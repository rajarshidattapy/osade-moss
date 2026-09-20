import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import { isAttached } from './cwd.js';

/**
 * Approval gates — OSADE.md §14.
 *
 * The mechanism behind "safe autonomous contribution". Without this the product is a liability.
 *
 * INVARIANT (§14.1): anything that writes to a public GitHub surface defaults to human
 * approval. A policy may downgrade a gate, and that downgrade is itself recorded in
 * `decided_by` as `policy:<name>` so the audit trail never loses who decided.
 */

export type GateName =
  | 'gate.commit'
  | 'gate.push'
  | 'gate.pr_open'
  | 'gate.fork_create'
  | 'gate.pr_update'
  | 'gate.pr_comment'
  | 'gate.issue_comment'
  | 'gate.review_submit'
  | 'gate.force_push'
  | 'gate.branch_delete'
  | 'gate.dep_add'
  | 'gate.file_write_outside_worktree'
  | 'gate.undo_turn'
  | 'gate.network_egress'
  | 'gate.branch_switch';

export type GateDefault = 'auto' | 'human' | 'conditional';

export interface GatePolicy {
  readonly gate: GateName;
  readonly def: GateDefault;
  /** Whether a policy may downgrade this gate to automatic. */
  readonly overridable: boolean;
  readonly note: string;
}

/** §14.1 — the gate list, verbatim. */
export const GATES: readonly GatePolicy[] = [
  { gate: 'gate.commit', def: 'auto', overridable: true, note: 'local only, reversible via checkpoint; human when attached' },
  { gate: 'gate.push', def: 'human', overridable: true, note: 'first write that leaves the machine' },
  { gate: 'gate.pr_open', def: 'human', overridable: true, note: 'requires passing verification' },
  // §11.3 — "If the user has no fork, offer to create one behind a gate." Creating a
  // repository under someone's account is a visible, public act on their behalf, so it is not
  // overridable: a policy that silently forked things would be exactly the surprise §14 exists
  // to prevent.
  {
    gate: 'gate.fork_create',
    def: 'human',
    overridable: false,
    note: 'creates a public repository under the user account',
  },
  { gate: 'gate.pr_update', def: 'human', overridable: true, note: 'public speech' },
  { gate: 'gate.pr_comment', def: 'human', overridable: true, note: 'public speech' },
  { gate: 'gate.issue_comment', def: 'human', overridable: true, note: 'public speech' },
  {
    gate: 'gate.review_submit',
    def: 'human',
    overridable: true,
    note: "public speech about someone else's work",
  },
  // §14.1 — "always, no policy override". The only gate a policy cannot touch.
  { gate: 'gate.force_push', def: 'human', overridable: false, note: 'always, no policy override' },
  { gate: 'gate.branch_delete', def: 'human', overridable: true, note: '' },
  { gate: 'gate.dep_add', def: 'human', overridable: true, note: 'supply chain' },
  {
    gate: 'gate.file_write_outside_worktree',
    def: 'human',
    overridable: false,
    note: 'should never happen; if it fires, investigate',
  },
  { gate: 'gate.undo_turn', def: 'conditional', overridable: true, note: 'human if diff > 20 files' },
  { gate: 'gate.network_egress', def: 'auto', overridable: true, note: 'v1 logs only' },
  {
    gate: 'gate.branch_switch',
    def: 'human',
    overridable: true,
    note: 'human on a dirty tree; a policy may downgrade a clean switch',
  },
];

const GATE_INDEX = new Map(GATES.map((g) => [g.gate, g]));

/**
 * OSADE-MOSS §M.7.1 — the gates whose approval is about a *diff*.
 *
 * Lives here rather than beside the clause finder because **INVARIANT A1** is enforced in this
 * module: every gate in this set must pin the commit it approves. F4's clause matching happens
 * to need the same list, which is a coincidence of scope rather than a shared concern.
 */
export const DIFF_BEARING: ReadonlySet<GateName> = new Set<GateName>([
  'gate.commit',
  'gate.push',
  'gate.pr_open',
  'gate.pr_update',
  'gate.force_push',
]);

/** §14.2 — gates expire after 24h into `decision='expired'`. */
export const GATE_TTL_MS = 24 * 60 * 60 * 1000;

/** §9.1 — undo_turn becomes a human gate when the diff is larger than this. */
export const UNDO_TURN_FILE_THRESHOLD = 20;

export function gatePolicy(gate: GateName): GatePolicy {
  const policy = GATE_INDEX.get(gate);
  if (!policy) throw new Error(`unknown gate ${gate}`);
  return policy;
}

/**
 * §11.2 — the payload is hashed at request time and re-hashed at execution.
 *
 * A mismatch aborts. This is what stops an "approve this comment" decision from being executed
 * against different text — the approval is bound to the exact bytes the human saw.
 *
 * Keys are sorted so an object that round-trips through JSON hashes identically.
 */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export class GateError extends Error {}

export interface GateRequestInput {
  taskId: string;
  gate: GateName;
  payload: unknown;
  /**
   * OSADE-MOSS §M.8.2 — the policy clauses this diff touches.
   *
   * Computed by the caller, because finding them is an async retrieval call and `request` is
   * synchronous by design. Passing them in rather than fetching them here also keeps `Gates`
   * unaware of F4: all it does is fold the hash into the payload before hashing, which is the
   * one thing that has to happen here and nowhere else.
   */
  clauses?: { matches: readonly unknown[]; clausesHash: string };
}

export interface GatesOptions {
  now?: () => number;
  /** Policy downgrades, e.g. `{ 'gate.commit': 'auto-commit' }`. Recorded in `decided_by`. */
  policies?: Partial<Record<GateName, string>>;
  /**
   * A1 — reads a task's branch head. Injected so this module never shells out to git itself,
   * and so a test can drive the "branch moved" case without a repository.
   */
  resolveHead?: (taskId: string) => Promise<string | null>;
}

export class Gates {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #policies: Partial<Record<GateName, string>>;
  readonly #resolveHead: ((taskId: string) => Promise<string | null>) | null;

  constructor(db: Db, options: GatesOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#policies = options.policies ?? {};
    this.#resolveHead = options.resolveHead ?? null;
  }

  /**
   * Records a gate request.
   *
   * When a policy covers the gate and the gate is overridable, the request is auto-decided and
   * `decided_by` records `policy:<name>` — the audit trail never loses who decided (§14.1).
   */
  request(input: GateRequestInput): string {
    const policy = gatePolicy(input.gate);
    assertPinsHead(input.gate, input.payload);
    const id = `g_${randomUUID().slice(0, 8)}`;

    // §M.8.2 step 5 — the clause set is part of what is hashed, so approval binds to what was
    // shown. A policy edited before approval changes this hash and the old approval can no
    // longer execute, which is the whole mechanism.
    const payload = withClauses(input.payload, input.clauses?.clausesHash);
    const payloadJson = JSON.stringify(payload);
    const payloadHash = hashPayload(payload);
    const now = this.#now();

    const attached =
      input.gate === 'gate.commit' &&
      (() => {
        const task = getTask(this.#db, input.taskId);
        return task != null && isAttached(task);
      })();

    const dirtySwitch = input.gate === 'gate.branch_switch' && payloadIsDirty(input.payload);

    const policyName = this.#policies[input.gate];
    const autoDecided =
      !attached &&
      !dirtySwitch &&
      policy.overridable &&
      (policy.def === 'auto' || policyName != null)
        ? (policyName ?? 'default')
        : null;

    this.#db
      .prepare(
        `INSERT INTO gate_request
           (id, task_id, gate, payload_json, payload_hash, requested_at, decided_at, decision, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.gate,
        payloadJson,
        payloadHash,
        now,
        autoDecided ? now : null,
        autoDecided ? 'approve' : null,
        autoDecided ? `policy:${autoDecided}` : null,
      );

    return id;
  }

  decide(gateId: string, decision: 'approve' | 'deny', decidedBy = 'human'): void {
    const row = this.#row(gateId);
    if (row.decided_at != null) {
      throw new GateError(`gate ${gateId} was already decided (${row.decision})`);
    }
    if (decision === 'approve') this.#assertAcked(gateId);
    this.#db
      .prepare('UPDATE gate_request SET decided_at = ?, decision = ?, decided_by = ? WHERE id = ?')
      .run(this.#now(), decision, decidedBy, gateId);
  }

  /**
   * §14.2 — edit-and-approve rewrites the payload and **re-hashes**.
   *
   * The new hash is what execution will be checked against, so an edited approval is bound to
   * the edited text rather than to what was originally proposed.
   */
  editAndApprove(gateId: string, payload: unknown, decidedBy = 'human'): void {
    const row = this.#row(gateId);
    if (row.decided_at != null) {
      throw new GateError(`gate ${gateId} was already decided (${row.decision})`);
    }
    this.#db
      .prepare(
        `UPDATE gate_request
            SET payload_json = ?, payload_hash = ?, decided_at = ?, decision = 'approve', decided_by = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(payload), hashPayload(payload), this.#now(), decidedBy, gateId);
  }

  /**
   * Checks a gate immediately before performing its action.
   *
   * Throws unless the gate was approved **and** the payload still hashes to what was approved.
   * This is the second half of §11.2: hashing at request time alone proves nothing if nobody
   * checks at execution time.
   */
  assertExecutable(gateId: string, payload: unknown): void {
    const row = this.#row(gateId);
    // A1 — a diff-bearing gate must go through `assertExecutableNow`, which re-reads the
    // branch. Refusing here rather than silently skipping the re-read is what stops the
    // invariant from being bypassed by picking the convenient method.
    if (DIFF_BEARING.has(row.gate as GateName)) {
      throw new GateError(
        `gate ${gateId} (${row.gate}) pins a commit — use assertExecutableNow so the branch is re-read (A1)`,
      );
    }
    this.#check(gateId, payload);
  }

  /** The payload and lifecycle checks, shared by both entry points. */
  #check(gateId: string, payload: unknown): void {
    const row = this.#row(gateId);

    if (row.decided_at == null) throw new GateError(`gate ${gateId} has not been decided`);
    if (row.decision !== 'approve') {
      throw new GateError(`gate ${gateId} was ${row.decision}, not approved`);
    }
    if (row.executed_at != null) {
      throw new GateError(`gate ${gateId} was already executed`);
    }
    if (this.#now() - row.requested_at > GATE_TTL_MS) {
      throw new GateError(`gate ${gateId} expired before execution`);
    }

    // §M.8.2 — the clause set is re-derived from the rows, not taken from the caller.
    //
    // This is what makes "policies changed after approval" abort. A policy reload deletes and
    // recreates its clauses, which cascades the gate's `gate_clause` rows away, so the hash
    // recomputed here no longer matches the one the human approved. The alternative — trusting
    // the caller to pass the same clause hash back — would check nothing.
    const actual = hashPayload(this.#rebind(row.payload_json, payload, gateId));
    if (actual !== row.payload_hash) {
      throw new GateError(
        `gate ${gateId} payload changed after approval: approved ${row.payload_hash.slice(0, 12)}, ` +
          `about to execute ${actual.slice(0, 12)}. Refusing.`,
      );
    }
  }


  /**
   * INVARIANT A1 — the same checks, plus the branch head as it is *right now*.
   *
   * §M.7.1: a `gate.push` or `gate.pr_open` payload that did not pin the commit let an agent
   * add commits between approval and execution, and the approval would still execute — against
   * code no human ever saw. The payload now carries `head_sha` (enforced at request time), and
   * this re-reads the branch immediately before the write.
   *
   * Async, and therefore separate from the synchronous `assertExecutable`: reading a branch
   * head is a subprocess. Every diff-bearing write goes through here; `assertExecutable`
   * refuses those gates outright so the sync path cannot be used to skip the re-read.
   */
  async assertExecutableNow(gateId: string, payload: unknown): Promise<void> {
    this.#check(gateId, payload);

    const row = this.#row(gateId);
    if (!DIFF_BEARING.has(row.gate as GateName)) return;

    const pinned = headOf(payload);
    const current = await this.#resolveHead?.(row.task_id);
    // No resolver configured (a test harness, an attached lane with no branch) means the head
    // cannot be re-read. The pin is still checked against the hash, which is the half that
    // does not need git.
    if (current == null || pinned == null) return;

    if (current !== pinned) {
      throw new GateError(
        `the branch moved after approval — re-approve. ` +
          `Approved ${pinned.slice(0, 8)}, branch is now at ${current.slice(0, 8)}.`,
      );
    }
  }

  /**
   * Re-folds the current clause hash into a caller's payload, when the gate had one.
   *
   * A gate requested on a repo with no policies has no `clauses_hash` in its payload and must
   * keep hashing exactly as it did before F4 existed — otherwise enabling the feature would
   * invalidate every approval already in flight.
   */
  #rebind(storedJson: string, payload: unknown, gateId: string): unknown {
    let stored: unknown;
    try {
      stored = JSON.parse(storedJson);
    } catch {
      return payload;
    }
    const hadClauses =
      stored != null && typeof stored === 'object' && 'clauses_hash' in (stored as object);
    if (!hadClauses) return payload;
    return withClauses(payload, this.#currentClausesHash(gateId));
  }

  #currentClausesHash(gateId: string): string {
    const rows = this.#db
      .prepare('SELECT hunk_ref, clause_id FROM gate_clause WHERE gate_id = ?')
      .all(gateId) as { hunk_ref: string; clause_id: string }[];
    return hashClauses(rows.map((row) => ({ hunkRef: row.hunk_ref, clauseId: row.clause_id })));
  }

  /**
   * §M.8.3 — approve is refused while a `requires_ack` clause is unacknowledged.
   *
   * INVARIANT C2: this is the *only* way a clause can block anything, and it exists because a
   * human wrote `requires_ack: true` into a policy file. No model evaluates compliance, and a
   * clause that merely matched never stops an approval.
   *
   * Enforced here rather than only in the UI: the CLI and an orchestrating agent reach the same
   * `decide`, and §17's symmetry is worth nothing if the rule lives in one client.
   */
  #assertAcked(gateId: string): void {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM gate_clause gc
           JOIN policy_clause pc ON pc.id = gc.clause_id
          WHERE gc.gate_id = ? AND pc.requires_ack = 1 AND gc.acked_at IS NULL`,
      )
      .get(gateId) as { n: number } | undefined;
    const outstanding = row?.n ?? 0;
    if (outstanding > 0) {
      throw new GateError(
        `gate ${gateId} has ${outstanding} policy clause(s) that must be acknowledged before approval`,
      );
    }
  }

  markExecuted(gateId: string, error?: string): void {
    this.#db
      .prepare('UPDATE gate_request SET executed_at = ?, execution_error = ? WHERE id = ?')
      .run(this.#now(), error ?? null, gateId);
  }

  /**
   * §14.2 — gates expire after 24h into `decision='expired'`.
   *
   * An expired gate is **not a denial** and can be re-requested; the distinction matters
   * because a denial is a decision and an expiry is the absence of one.
   */
  expireStale(): number {
    const cutoff = this.#now() - GATE_TTL_MS;
    const result = this.#db
      .prepare(
        `UPDATE gate_request
            SET decided_at = ?, decision = 'expired', decided_by = 'policy:ttl'
          WHERE decided_at IS NULL AND requested_at < ?`,
      )
      .run(this.#now(), cutoff);
    return result.changes;
  }

  #row(gateId: string): {
    decided_at: number | null;
    decision: string | null;
    executed_at: number | null;
    requested_at: number;
    payload_hash: string;
    payload_json: string;
    gate: string;
    task_id: string;
  } {
    const row = this.#db.prepare('SELECT * FROM gate_request WHERE id = ?').get(gateId) as
      | {
          decided_at: number | null;
          decision: string | null;
          executed_at: number | null;
          requested_at: number;
          payload_hash: string;
          payload_json: string;
          gate: string;
          task_id: string;
        }
      | undefined;
    if (!row) throw new GateError(`unknown gate ${gateId}`);
    return row;
  }
}

/**
 * The hash of the sorted `(hunk_ref, clause_id)` pairs — OSADE-MOSS §M.8.2 step 5.
 *
 * Sorted, so the hash does not depend on retrieval's ordering: two runs that surface the same
 * clauses in a different order must produce the same payload, or an approval would be voided by
 * nothing more than a reranking.
 *
 * `score` is deliberately **not** in the hash. It is advisory and drifts with the index; what
 * the human approved is *which clauses were shown*, and binding to a float would make
 * approvals expire for reasons nobody could explain.
 *
 * It lives here rather than in `gate-clauses.ts` so the dependency runs one way: the clause
 * finder knows about gates, and gates know nothing about retrieval.
 */
export function hashClauses(pairs: readonly { hunkRef: string; clauseId: string }[]): string {
  const joined = pairs
    .map((pair) => `${pair.hunkRef}\u0000${pair.clauseId}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(joined).digest('hex').slice(0, 32);
}

/**
 * Folds the clause hash into the payload.
 *
 * **An empty clause set is still bound**, and deliberately: "no policy matched this diff" is a
 * fact the approver relied on. If a policy is added afterwards that *would* have matched, the
 * set changes, the hash changes, and the approval correctly stops being executable.
 *
 * What is not bound is a gate requested with no clause argument at all — the path a caller
 * takes when F4 is not wired in. Those hash exactly as they did before this feature existed,
 * so enabling it cannot invalidate approvals already in flight.
 */
function withClauses(payload: unknown, clausesHash: string | undefined): unknown {
  if (clausesHash == null) return payload;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, clauses_hash: clausesHash };
  }
  return { ...(payload as Record<string, unknown>), clauses_hash: clausesHash };
}

/** §9.1 — undo_turn is conditional: a human decides once the diff is large. */
export function undoTurnNeedsHuman(filesChanged: number): boolean {
  return filesChanged > UNDO_TURN_FILE_THRESHOLD;
}

/** Dirty, or cleanliness unknown — both stay human. */
function payloadIsDirty(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return true;
  const dirty = (payload as { dirty?: unknown }).dirty;
  return dirty !== false;
}

/**
 * A1, the type half — a diff-bearing gate must pin the commit it approves.
 *
 * Checked at request time so a payload without `head_sha` can never reach the database. The
 * alternative, checking only at execution, would let a gate sit in the approval queue for a day
 * before anyone discovered it was unexecutable.
 */
function assertPinsHead(gate: GateName, payload: unknown): void {
  if (!DIFF_BEARING.has(gate)) return;
  if (headOf(payload) == null) {
    throw new GateError(
      `${gate} must pin the commit it approves: payload needs a head_sha (OSADE-MOSS A1)`,
    );
  }
}

function headOf(payload: unknown): string | null {
  if (payload == null || typeof payload !== 'object') return null;
  const value = (payload as { head_sha?: unknown }).head_sha;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
