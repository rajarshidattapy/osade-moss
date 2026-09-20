import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { normaliseHunk, parseHunks } from '../domain/fix-patterns.js';
import type { RetrievalService } from '../retrieval/service.js';

/**
 * Slop signals — OSADE-MOSS §M.7.5.
 *
 * This half of F3 faces the other way. The rest of Osade is about making *our* contributions
 * cheap to review; this is about helping a maintainer triage what arrives, from anyone, made
 * with anything.
 *
 * **INVARIANT A2: signals are never acted on publicly without a gate.** Nothing here closes,
 * labels or comments on a pull request. There is no auto-anything. A maintainer replying to a
 * duplicate cluster goes through `gate.pr_comment` like every other piece of public speech, and
 * the absence of a code path to do otherwise is the enforcement.
 *
 * **The score is shown, not a verdict.** The label reads "similar to #412 (0.91)", never
 * "spam". Two people solving the same issue is the *normal* outcome of an open issue tracker,
 * and a tool that called that spam would be wrong about the thing it was built to help with.
 */

export interface SignalsOptions {
  readonly now?: () => number;
  readonly onWarning?: (message: string) => void;
}

export interface IncomingPr {
  readonly repoId: string;
  readonly number: number;
  readonly author: string;
  readonly title: string;
  readonly body: string;
  readonly headSha: string;
  readonly openedAt: number;
  /** Unified diff. Summarised structurally; never indexed raw. */
  readonly diff: string;
}

export type SignalKind =
  | 'near_duplicate'
  | 'attested'
  | 'attestation_stale'
  | 'attestation_invalid';

/** §M.7.5 — above this, or sharing half their hunks, two PRs are worth showing side by side. */
const SIMILARITY_THRESHOLD = 0.6;
const SHARED_HUNK_THRESHOLD = 0.5;
const WINDOW_DAYS = 90;

export class PrSignals {
  readonly #db: Db;
  readonly #retrieval: RetrievalService | null;
  readonly #now: () => number;

  constructor(db: Db, retrieval: RetrievalService | null, options: SignalsOptions = {}) {
    this.#db = db;
    this.#retrieval = retrieval;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records an incoming PR and looks for near-duplicates.
   *
   * The record is written first and the comparison runs against what is already stored, so a
   * PR is never compared with itself and the order PRs arrive in does not change the answer.
   */
  async record(pr: IncomingPr): Promise<void> {
    const summary = summariseDiff(pr.diff);
    const id = `pr_${pr.repoId}_${pr.number}`;

    this.#db
      .prepare(
        `INSERT INTO pr_record (id, repo_id, number, author, title, body_excerpt, diff_summary,
                                head_sha, opened_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, number) DO UPDATE SET
           title = excluded.title,
           body_excerpt = excluded.body_excerpt,
           diff_summary = excluded.diff_summary,
           head_sha = excluded.head_sha,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        id,
        pr.repoId,
        pr.number,
        pr.author,
        pr.title,
        // §M.7.5 — the first 1 000 characters. A whole PR body is mostly boilerplate.
        pr.body.slice(0, 1_000),
        summary.text,
        pr.headSha,
        pr.openedAt,
        this.#now(),
      );

    await this.#findDuplicates(pr, summary.hashes);
  }

  /**
   * §M.7.5 — two routes to the same signal, and they are not equal partners.
   *
   * **Shared hunk hashes decide; similarity only ranks.** The hashes catch "these *are* the
   * same change" regardless of wording, which is the case that matters and the one similarity
   * is worst at — two agents generating the same patch often describe it quite differently.
   *
   * On the FTS5 backend, similarity does not even create a candidate. Its score is a mapped
   * BM25 rank, not a similarity in any calibrated sense: two PRs sharing boilerplate ("This
   * migrates the SDK") score well above any threshold worth setting. Flagging on that would
   * produce exactly the harm this feature is supposed to avoid — a maintainer dismissing a
   * legitimate contribution because a tool called it a duplicate. So when retrieval is
   * degraded, the structural comparison is the whole signal, and the honest consequence is
   * that some genuinely-similar-but-differently-written pairs go unflagged.
   */
  async #findDuplicates(pr: IncomingPr, hashes: readonly string[]): Promise<void> {
    const since = this.#now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates = new Map<number, { score: number; shared: number }>();

    // 1. Structural. This is what decides.
    if (hashes.length > 0) {
      const others = this.#db
        .prepare(
          `SELECT number, diff_summary FROM pr_record
            WHERE repo_id = ? AND number != ? AND opened_at > ?`,
        )
        .all(pr.repoId, pr.number, since) as { number: number; diff_summary: string }[];

      for (const other of others) {
        const otherHashes = hashesOf(other.diff_summary);
        if (otherHashes.length === 0) continue;
        const shared = hashes.filter((hash) => otherHashes.includes(hash)).length;
        const ratio = shared / Math.max(hashes.length, otherHashes.length);
        if (ratio < SHARED_HUNK_THRESHOLD) continue;
        candidates.set(other.number, { score: ratio, shared: ratio });
      }
    }

    // 2. Semantic. On Moss it can add a candidate the hunks missed; on FTS5 it may only
    //    sharpen the score of one the hunks already found.
    if (this.#retrieval) {
      const semantic = this.#retrieval.backend === 'moss';
      const hits = await this.#retrieval.query('prs', `${pr.title}\n${summaryOf(pr.diff)}`, {
        topK: 5,
        filter: [{ field: 'repo_id', condition: { $eq: pr.repoId } }],
      });
      for (const hit of hits) {
        const number = Number.parseInt(hit.meta.pr_number ?? '', 10);
        if (!Number.isFinite(number) || number === pr.number) continue;
        if (hit.score < SIMILARITY_THRESHOLD) continue;
        const existing = candidates.get(number);
        if (existing) {
          existing.score = Math.max(existing.score, hit.score);
        } else if (semantic) {
          candidates.set(number, { score: hit.score, shared: 0 });
        }
      }
    }

    // Recorded in both directions, because a cluster has to be visible from either end.
    // Marking only the newer PR would leave the older one looking unique in the triage list —
    // and the maintainer's question is "are these the same work?", which is symmetric.
    for (const [number, match] of candidates) {
      const detail = { shared_hunks: Math.round(match.shared * 100) / 100 };
      this.#write(pr.repoId, pr.number, 'near_duplicate', number, match.score, detail);
      this.#write(pr.repoId, number, 'near_duplicate', pr.number, match.score, detail);
    }
  }

  /** §M.7.4 / §M.7.5 — what verification said about a PR's attestation block. */
  recordAttestation(
    repoId: string,
    prNumber: number,
    state: 'valid' | 'stale' | 'invalid',
    detail?: Record<string, unknown>,
  ): void {
    const kind: SignalKind =
      state === 'valid' ? 'attested' : state === 'stale' ? 'attestation_stale' : 'attestation_invalid';

    // A PR carries one attestation verdict at a time. Leaving "attested" behind next to
    // "stale" would let a triage list show both and mean neither.
    this.#db
      .prepare(
        `DELETE FROM pr_signal WHERE repo_id = ? AND pr_number = ? AND kind IN
           ('attested', 'attestation_stale', 'attestation_invalid')`,
      )
      .run(repoId, prNumber);
    this.#write(repoId, prNumber, kind, null, null, detail ?? null);
  }

  /**
   * §M.7.5 — the triage ordering: attested, then unattested and unique, then duplicate
   * clusters collapsed to one row with a count.
   *
   * Derived on read, never stored. A stored ordering would be a stored conclusion, and the
   * inputs — attestations, new duplicates — change under it.
   */
  triage(repoId: string): TriageRow[] {
    const prs = this.#db
      .prepare(
        'SELECT number, author, title, head_sha, opened_at FROM pr_record WHERE repo_id = ? ORDER BY opened_at DESC',
      )
      .all(repoId) as {
      number: number;
      author: string;
      title: string;
      head_sha: string;
      opened_at: number;
    }[];

    const signals = this.#db
      .prepare('SELECT pr_number, kind, related_pr, score FROM pr_signal WHERE repo_id = ?')
      .all(repoId) as {
      pr_number: number;
      kind: SignalKind;
      related_pr: number | null;
      score: number | null;
    }[];

    const byPr = new Map<number, typeof signals>();
    for (const signal of signals) {
      const list = byPr.get(signal.pr_number) ?? [];
      list.push(signal);
      byPr.set(signal.pr_number, list);
    }

    const rows: TriageRow[] = prs.map((pr) => {
      const own = byPr.get(pr.number) ?? [];
      const duplicates = own.filter((signal) => signal.kind === 'near_duplicate');
      const attested = own.some((signal) => signal.kind === 'attested');
      const stale = own.some((signal) => signal.kind === 'attestation_stale');
      const invalid = own.some((signal) => signal.kind === 'attestation_invalid');
      return {
        number: pr.number,
        author: pr.author,
        title: pr.title,
        head_sha: pr.head_sha,
        attested,
        stale,
        invalid,
        duplicates: duplicates.length,
        similar_to: duplicates
          .map((signal) => signal.related_pr)
          .filter((n): n is number => n != null)
          .sort((a, b) => a - b),
        top_score: duplicates.reduce((best, s) => Math.max(best, s.score ?? 0), 0) || null,
      };
    });

    return rows.sort((a, b) => rank(a) - rank(b) || b.number - a.number);
  }

  signalsFor(repoId: string, prNumber: number): StoredSignal[] {
    return this.#db
      .prepare(
        `SELECT id, kind, related_pr, score, detail_json, created_at
           FROM pr_signal WHERE repo_id = ? AND pr_number = ? ORDER BY created_at`,
      )
      .all(repoId, prNumber) as StoredSignal[];
  }

  #write(
    repoId: string,
    prNumber: number,
    kind: SignalKind,
    relatedPr: number | null,
    score: number | null,
    detail: Record<string, unknown> | null,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO pr_signal (id, repo_id, pr_number, kind, related_pr, score, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, pr_number, kind, related_pr) DO UPDATE SET
           score = excluded.score, detail_json = excluded.detail_json`,
      )
      .run(
        `sig_${randomUUID().slice(0, 8)}`,
        repoId,
        prNumber,
        kind,
        relatedPr,
        score,
        detail ? JSON.stringify(detail) : null,
        this.#now(),
      );
  }
}

export interface TriageRow {
  number: number;
  author: string;
  title: string;
  head_sha: string;
  attested: boolean;
  stale: boolean;
  invalid: boolean;
  duplicates: number;
  similar_to: number[];
  /** Shown beside the link. Never rendered as a verdict. */
  top_score: number | null;
}

export interface StoredSignal {
  id: string;
  kind: SignalKind;
  related_pr: number | null;
  score: number | null;
  detail_json: string | null;
  created_at: number;
}

/** §M.7.5 — attested first, then unattested and unique, then duplicate clusters. */
function rank(row: TriageRow): number {
  if (row.attested) return 0;
  if (row.duplicates === 0) return 1;
  return 2;
}

/**
 * §M.7.5 — the structural summary that gets indexed.
 *
 * Files touched plus the normalised hunk hashes from §M.5.5, rendered as text. Raw diffs are
 * deliberately not indexed: too large, and dominated by context lines identical across
 * unrelated changes. Reusing F1's normalisation is the point — "the same change" means the same
 * thing whether Osade produced it or a stranger did.
 */
export function summariseDiff(diff: string): { text: string; hashes: string[] } {
  const hunks = parseHunks(diff);
  const files = [...new Set(hunks.map((hunk) => hunk.file))].sort();
  const hashes = [
    ...new Set(hunks.map((hunk) => createHash('sha256').update(normaliseHunk(hunk.body)).digest('hex').slice(0, 16))),
  ].sort();
  return {
    text: [`files: ${files.join(' ')}`, `hunks: ${hashes.join(' ')}`].join('\n'),
    hashes,
  };
}

function hashesOf(summary: string): string[] {
  const line = /^hunks:\s*(.*)$/m.exec(summary)?.[1] ?? '';
  return line.split(/\s+/).filter((hash) => hash.length > 0);
}

function summaryOf(diff: string): string {
  return summariseDiff(diff).text;
}
