import type { Db } from '../db/index.js';
import { appliesToPath } from '../knowledge/policies.js';
import type { RetrievalService } from '../retrieval/service.js';
import { parseHunks } from './fix-patterns.js';
import { git } from './git.js';
import { hashClauses, type GateName } from './gates.js';

/**
 * Which policy clauses a diff touches — OSADE-MOSS §M.8.2.
 *
 * **Computed when the gate is *requested*, not when its card is opened.** Opening an approval
 * card has to be instant; the hot path here is gate creation across N lanes, and the UI reads
 * precomputed rows. More importantly, the clause set has to exist *before* the payload is
 * hashed, because it is part of the payload:
 *
 * **The `clauses_hash` binds approval to what was shown.** If policies change between request
 * and approval, a reload recomputes the clauses, the payload hash changes, and the old approval
 * can no longer execute (§14 mechanics, unchanged). Without that, "I approved this knowing
 * SEC-3.2 applied" would be a claim nothing checks.
 *
 * **INVARIANT C2: retrieval informs; humans decide.** Nothing here blocks anything. It produces
 * a list of cited clauses and a hash. The only thing that gates the approve button is
 * `requires_ack`, which a human wrote into a policy file.
 */

/** §M.8.2 — the gates whose payloads carry a diff, and so can touch a policy. */
export const DIFF_BEARING: ReadonlySet<GateName> = new Set<GateName>([
  'gate.commit',
  'gate.push',
  'gate.pr_open',
  'gate.pr_update',
  'gate.force_push',
]);

export interface ClauseMatch {
  /** `path:startLine` — §M.8.1's `gate_clause.hunk_ref`. */
  readonly hunkRef: string;
  readonly clauseId: string;
  readonly score: number;
}

export interface ClauseSet {
  readonly matches: readonly ClauseMatch[];
  /** The hash folded into the gate payload before it is hashed. */
  readonly clausesHash: string;
}

/** No policies, no diff, or no retrieval — all the same honest answer. */
const EMPTY: ClauseSet = { matches: [], clausesHash: hashClauses([]) };

/** §M.8.2 step 3 — prose, but clause ids and terms matter, so not pure semantic. */
const ALPHA = 0.7;
const TOP_K = 3;
/** A hunk query longer than this is mostly noise; ~1 500 chars is the PRD's figure. */
const MAX_QUERY_CHARS = 1_500;

export class GateClauses {
  readonly #db: Db;
  readonly #retrieval: RetrievalService | null;

  constructor(db: Db, retrieval: RetrievalService | null) {
    this.#db = db;
    this.#retrieval = retrieval;
  }

  /**
   * Finds the clauses a diff touches.
   *
   * Never throws: R3 says retrieval never fails an operation, and a gate that could not be
   * *requested* because the policy index was unavailable would be a compliance feature that
   * blocks work when it breaks. No clauses is a valid, honest answer — and it hashes to the
   * empty set, which the card renders as "no policy clauses matched".
   */
  async forDiff(repoId: string, diff: string): Promise<ClauseSet> {
    const matches: ClauseMatch[] = [];
    if (this.#retrieval && diff.trim().length > 0) {
      const clauses = this.#clauseIndex(repoId);
      if (clauses.size > 0) {
        for (const hunk of parseHunks(diff)) {
          const hits = await this.#retrieval.query('policies', queryFor(hunk.file, hunk.body), {
            topK: TOP_K,
            alpha: ALPHA,
            filter: [
              {
                field: 'scope',
                condition: { $in: ['global', 'repo'] },
              },
            ],
          });

          for (const hit of hits) {
            const clauseId = hit.meta.src_id;
            const clause = clauses.get(clauseId ?? '');
            // A hit whose clause is not in scope for this repo, or has vanished since it was
            // indexed, is not a flag (C1). The index may lag; the tables are the truth.
            if (!clause) continue;
            // §M.8.2 step 3 — `applies_to` globs are checked in code, after retrieval.
            if (!appliesToPath(clause.appliesTo, hunk.file)) continue;
            matches.push({
              hunkRef: `${hunk.file}:${hunk.startLine}`,
              clauseId: clause.id,
              score: Math.round(hit.score * 1000) / 1000,
            });
          }
        }
      }
    }

    const deduped = dedupe(matches);
    return { matches: deduped, clausesHash: hashClauses(deduped) };
  }

  /**
   * The clauses a task's current work touches.
   *
   * The entry point every diff-bearing gate should use, so the definition of "the diff" lives
   * in one place rather than being re-derived per gate. Today only `gate.pr_open` has a
   * producer; `gate.commit` and `gate.push` get this for free when theirs are wired.
   */
  async forTask(taskId: string): Promise<ClauseSet> {
    const row = this.#db
      .prepare(
        `SELECT t.repo_id, t.base_sha, t.worktree_path, r.path AS repo_path
           FROM task t JOIN repo r ON r.id = t.repo_id WHERE t.id = ?`,
      )
      .get(taskId) as
      | { repo_id: string; base_sha: string; worktree_path: string | null; repo_path: string }
      | undefined;
    if (!row) return EMPTY;

    const cwd = row.worktree_path ?? row.repo_path;
    const diff = await git(cwd, ['diff', row.base_sha]).catch(() => '');
    return this.forDiff(row.repo_id, diff);
  }

  /** Writes the rows for a gate that has just been created. */
  record(gateId: string, set: ClauseSet): void {
    if (set.matches.length === 0) return;
    // Copied from the clause as it is now (M18): the gate keeps what it was shown even after the
    // policy file changes. Selecting from `policy_clause` is also what keeps C1 — a clause id
    // that does not exist inserts nothing, so there is no way to write an uncited row.
    const insert = this.#db.prepare(
      `INSERT INTO gate_clause
         (gate_id, hunk_ref, clause_id, clause_ref, title, text, scope, policy_path, file_sha,
          requires_ack, score)
       SELECT ?, ?, pc.id, pc.clause_ref, pc.title, pc.text, p.scope, p.path, p.file_sha,
              pc.requires_ack, ?
         FROM policy_clause pc JOIN policy p ON p.id = pc.policy_id
        WHERE pc.id = ?
       ON CONFLICT(gate_id, hunk_ref, clause_id) DO UPDATE SET score = excluded.score`,
    );
    this.#db.transaction(() => {
      for (const match of set.matches) {
        insert.run(gateId, match.hunkRef, match.score, match.clauseId);
      }
    })();
  }

  /**
   * §M.8.3 — is every `requires_ack` clause on this gate acknowledged?
   *
   * The approve button reads this. It is computed from rows rather than stored, like every
   * other derived answer in Osade (§6): a stored "approvable" flag would go stale the moment a
   * policy reload changed the clause set.
   */
  outstandingAcks(gateId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM gate_clause
          WHERE gate_id = ? AND requires_ack = 1 AND acked_at IS NULL AND unbound_at IS NULL`,
      )
      .get(gateId) as { n: number };
    return row.n;
  }

  /** Records who acknowledged a clause, and when. Both, because §M.8.4 has to report them. */
  ack(gateId: string, clauseId: string, by: string, at: number): void {
    this.#db
      .prepare(
        'UPDATE gate_clause SET acked_by = ?, acked_at = ? WHERE gate_id = ? AND clause_id = ?',
      )
      .run(by, at, gateId, clauseId);
  }

  /** Clauses in scope for a repo: its own, plus every global one. */
  #clauseIndex(repoId: string): Map<string, { id: string; appliesTo: string[] }> {
    const rows = this.#db
      .prepare(
        `SELECT c.id, c.applies_to FROM policy_clause c
           JOIN policy p ON p.id = c.policy_id
          WHERE p.scope = 'global' OR p.repo_id = ?`,
      )
      .all(repoId) as { id: string; applies_to: string | null }[];
    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, appliesTo: row.applies_to ? row.applies_to.split('\n') : [] },
      ]),
    );
  }
}

function dedupe(matches: readonly ClauseMatch[]): ClauseMatch[] {
  const best = new Map<string, ClauseMatch>();
  for (const match of matches) {
    const key = `${match.hunkRef}\u0000${match.clauseId}`;
    const existing = best.get(key);
    if (!existing || match.score > existing.score) best.set(key, match);
  }
  return [...best.values()].sort(
    (a, b) => a.hunkRef.localeCompare(b.hunkRef) || a.clauseId.localeCompare(b.clauseId),
  );
}

/**
 * The path plus the hunk's added and removed lines — what the change actually says.
 *
 * Identifiers are also appended split into words, because **code and policy prose do not share
 * a vocabulary**. A diff adds `apiKey`; the policy says "API key". To a keyword index those are
 * different tokens and the clause is never found — which is not a ranking problem the semantic
 * half can paper over, it is the query missing the words. Splitting `apiKey` into `api Key`
 * alongside the original costs one pass and makes the exact-term half of the hybrid query
 * actually able to hit.
 */
function queryFor(file: string, body: string): string {
  const changed = body
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .map((line) => line.slice(1))
    .join('\n');
  const text = `${file}\n${changed}`.slice(0, MAX_QUERY_CHARS);
  return `${text}\n${splitIdentifiers(text)}`.slice(0, MAX_QUERY_CHARS * 2);
}

/** `apiKey` → `api Key`, `private_key` → `private key`, `SKLive` → `SK Live`. */
export function splitIdentifiers(text: string): string {
  const words = new Set<string>();
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const parts = token
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter((part) => part.length > 1);
    if (parts.length > 1) for (const part of parts) words.add(part);
  }
  return [...words].join(' ');
}
