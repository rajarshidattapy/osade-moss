import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import { keyIdFor, loadOrCreateKey, sign, verify, type KeyPair } from './keys.js';
import {
  canonicalise,
  parseBlock,
  parseStatement,
  renderBlock,
  type AttestationStatement,
  type VerificationRecord,
} from './statement.js';

/**
 * Attestations — OSADE-MOSS §M.7.2, §M.7.4.
 *
 * **An attestation is created inside the same execution path as the gated write**, after
 * `assertExecutableNow` and before the GitHub call. The ordering is the guarantee: a write that
 * fails leaves an attestation with no PR, which is harmless, but a PR can never exist without
 * one, because the PR body *contains* it.
 *
 * Everything signed here is a stored fact. The verification records come from `verify_run`
 * rows, the approver from `gate_request.decided_by`, the commit from the gate payload that A1
 * forced it to pin. Nothing is computed by a model, and nothing is taken from the caller.
 */

export interface AttestOptions {
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onWarning?: (message: string) => void;
  /** Tests inject a key; production generates one on first use. */
  readonly key?: KeyPair;
  /** Identifies the build that produced the statement. */
  readonly build?: string;
}

export interface IssuedAttestation {
  readonly id: string;
  readonly statement: AttestationStatement;
  readonly signature: string;
  readonly keyId: string;
  /** The block to put in the PR body. */
  readonly block: string;
}

export class Attestations {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #onWarning: (message: string) => void;
  readonly #build: string;
  #key: KeyPair | null;

  constructor(db: Db, options: AttestOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#build = options.build ?? 'osade-dev';
    this.#key = options.key ?? null;
  }

  /** Lazy, so a daemon that never opens a PR never writes a key to disk. */
  key(): KeyPair {
    this.#key ??= loadOrCreateKey(this.#env);
    return this.#key;
  }

  /**
   * Builds, signs and records the attestation for an approved gate.
   *
   * Returns null when the gate is not in a state that can be attested — undecided, denied, or
   * missing its commit. Null rather than throwing: the caller is mid-write, and "no
   * attestation" is a fact the caller can act on while "exception" is not.
   */
  issue(gateId: string): IssuedAttestation | null {
    const gate = this.#db
      .prepare(
        `SELECT g.id, g.task_id, g.gate, g.payload_json, g.payload_hash, g.decision,
                g.decided_by, g.decided_at
           FROM gate_request g WHERE g.id = ?`,
      )
      .get(gateId) as
      | {
          id: string;
          task_id: string;
          gate: string;
          payload_json: string;
          payload_hash: string;
          decision: string | null;
          decided_by: string | null;
          decided_at: number | null;
        }
      | undefined;

    if (!gate || gate.decision !== 'approve' || gate.decided_at == null) return null;

    const task = getTask(this.#db, gate.task_id);
    if (!task) return null;

    const headSha = headOf(gate.payload_json);
    // A1 guarantees this for a diff-bearing gate, so reaching here means A1 was bypassed — the
    // one case worth saying out loud, because the PR will open with no attestation and nothing
    // else would explain why. Refusing rather than substituting the task's base sha: an
    // attestation naming the wrong commit is worse than none.
    if (!headSha) {
      this.#onWarning(
        `gate ${gateId} (${gate.gate}) has no head_sha, so no attestation was issued — A1 should have prevented this`,
      );
      return null;
    }

    const statement: AttestationStatement = {
      v: 1,
      tier: 1,
      repo: this.#repoSlug(task.repo_id),
      head_sha: headSha,
      base_sha: task.base_sha,
      gate: { id: gate.id, name: gate.gate, payload_hash: gate.payload_hash },
      approved_by: gate.decided_by ?? 'unknown',
      approved_at: new Date(gate.decided_at).toISOString(),
      verification: this.#verification(gate.task_id, headSha),
      context: this.#context(gate.task_id, gate.id),
      agent: task.agent_id ?? 'unknown',
      osade_build: this.#build,
    };

    const canonical = canonicalise(statement);
    const key = this.key();
    const signature = sign(canonical, key.privatePem);
    const id = `att_${randomUUID().slice(0, 8)}`;

    this.#db
      .prepare(
        `INSERT INTO attestation (id, task_id, gate_id, statement_json, signature, key_id, tier,
                                  head_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, gate.task_id, gate.id, canonical, signature, key.keyId, headSha, this.#now());

    return { id, statement, signature, keyId: key.keyId, block: renderBlock(statement, signature, key.keyId) };
  }

  /**
   * §M.7.4 — checks a PR body's block against a set of published keys.
   *
   * Three outcomes, and the middle one is the interesting one:
   *   - **invalid** — the signature does not verify, or the block is malformed. Someone edited
   *     it, or it was never real.
   *   - **stale** — it verifies, but the PR has moved on. *Not* invalid: a named human really
   *     did approve that commit; there is simply newer code now. Conflating the two would
   *     teach maintainers to ignore both.
   *   - **valid** — it verifies and names the PR's current head.
   */
  verifyBody(
    body: string,
    currentHead: string,
    keys: readonly { key_id: string; public_key: string }[],
  ): VerifyResult {
    const block = parseBlock(body);
    if (!block) return { state: 'absent' };

    const statement = parseStatement(block.statement);
    if (!statement) return { state: 'invalid', reason: 'the statement is not readable' };

    const published = keys.find((entry) => entry.key_id === block.keyId);
    if (!published) {
      return { state: 'invalid', reason: `no published key matches ${block.keyId}` };
    }
    // A key file that claims someone else's id proves nothing; the id is derived from the key.
    if (keyIdFor(published.public_key) !== block.keyId) {
      return { state: 'invalid', reason: `the published key does not match its own key_id` };
    }
    if (!verify(block.statement, block.signature, published.public_key)) {
      return { state: 'invalid', reason: 'the signature does not verify' };
    }
    if (statement.head_sha !== currentHead) {
      return { state: 'stale', statement, approvedHead: statement.head_sha };
    }
    return { state: 'valid', statement };
  }

  latestFor(taskId: string): { statement: AttestationStatement; head_sha: string } | null {
    const row = this.#db
      .prepare(
        'SELECT statement_json, head_sha FROM attestation WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(taskId) as { statement_json: string; head_sha: string } | undefined;
    if (!row) return null;
    const statement = parseStatement(row.statement_json);
    return statement ? { statement, head_sha: row.head_sha } : null;
  }

  /**
   * The verification records for the commit being approved.
   *
   * Scoped to this `head_sha` on purpose: §6 makes a verify result stale the moment the head
   * moves, and a statement that cited runs from an earlier commit would be claiming checks
   * passed on code that was never checked.
   */
  #verification(taskId: string, headSha: string): VerificationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT step_name, cmd, exit_code, head_sha FROM verify_run
          WHERE task_id = ? AND head_sha = ? AND finished_at IS NOT NULL
          ORDER BY started_at ASC`,
      )
      .all(taskId, headSha) as {
      step_name: string;
      cmd: string;
      exit_code: number | null;
      head_sha: string;
    }[];

    return rows.map((row) => ({
      step: row.step_name,
      cmd: row.cmd,
      exit: row.exit_code ?? -1,
      head_sha: row.head_sha,
    }));
  }

  /** §M.7.2 — what the approver was shown, so the statement records the conditions too. */
  #context(taskId: string, gateId: string): AttestationStatement['context'] {
    const injected = this.#db
      .prepare('SELECT rule_count FROM task_injection WHERE task_id = ?')
      .get(taskId) as { rule_count: number } | undefined;

    const clauses = this.#db
      .prepare(
        `SELECT clause_ref, acked_at FROM gate_clause
          WHERE gate_id = ? ORDER BY clause_ref`,
      )
      .all(gateId) as { clause_ref: string; acked_at: number | null }[];

    return {
      conventions_injected: injected?.rule_count ?? 0,
      policy_clauses_shown: clauses.map((clause) => clause.clause_ref),
      clauses_acked: clauses.filter((c) => c.acked_at != null).map((c) => c.clause_ref),
    };
  }

  #repoSlug(repoId: string): string {
    const row = this.#db
      .prepare('SELECT gh_owner, gh_name, path FROM repo WHERE id = ?')
      .get(repoId) as { gh_owner: string | null; gh_name: string | null; path: string } | undefined;
    if (row?.gh_owner && row.gh_name) return `${row.gh_owner}/${row.gh_name}`;
    return row?.path.replace(/\\/g, '/').split('/').pop() ?? repoId;
  }
}

export type VerifyResult =
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }
  | { state: 'stale'; statement: AttestationStatement; approvedHead: string }
  | { state: 'valid'; statement: AttestationStatement };

function headOf(payloadJson: string): string | null {
  try {
    const parsed = JSON.parse(payloadJson) as { head_sha?: unknown };
    return typeof parsed.head_sha === 'string' && parsed.head_sha.length > 0
      ? parsed.head_sha
      : null;
  } catch {
    return null;
  }
}
