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
}

export interface GatesOptions {
  now?: () => number;
  /** Policy downgrades, e.g. `{ 'gate.commit': 'auto-commit' }`. Recorded in `decided_by`. */
  policies?: Partial<Record<GateName, string>>;
}

export class Gates {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #policies: Partial<Record<GateName, string>>;

  constructor(db: Db, options: GatesOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#policies = options.policies ?? {};
  }

  /**
   * Records a gate request.
   *
   * When a policy covers the gate and the gate is overridable, the request is auto-decided and
   * `decided_by` records `policy:<name>` — the audit trail never loses who decided (§14.1).
   */
  request(input: GateRequestInput): string {
    const policy = gatePolicy(input.gate);
    const id = `g_${randomUUID().slice(0, 8)}`;
    const payloadJson = JSON.stringify(input.payload);
    const payloadHash = hashPayload(input.payload);
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

    const actual = hashPayload(payload);
    if (actual !== row.payload_hash) {
      throw new GateError(
        `gate ${gateId} payload changed after approval: approved ${row.payload_hash.slice(0, 12)}, ` +
          `about to execute ${actual.slice(0, 12)}. Refusing.`,
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
  } {
    const row = this.#db.prepare('SELECT * FROM gate_request WHERE id = ?').get(gateId) as
      | {
          decided_at: number | null;
          decision: string | null;
          executed_at: number | null;
          requested_at: number;
          payload_hash: string;
        }
      | undefined;
    if (!row) throw new GateError(`unknown gate ${gateId}`);
    return row;
  }
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
