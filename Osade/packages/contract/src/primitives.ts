import { z } from 'zod';

/**
 * Shared primitives. OSADE.md §5.5 — everything crossing a process boundary is declared here,
 * so renderer and CLI types are derived rather than hand-written.
 */

/** Milliseconds since the epoch. Every timestamp in Osade is an integer, never a Date. */
export const Timestamp = z.number().int();
export type Timestamp = z.infer<typeof Timestamp>;

export const TaskId = z.string().min(1);
export type TaskId = z.infer<typeof TaskId>;

export const RepoId = z.string().min(1);
export type RepoId = z.infer<typeof RepoId>;

export const OrgId = z.string().min(1);
export type OrgId = z.infer<typeof OrgId>;

/**
 * The substrate's public id alphabet — `backend/src/workspace.rs:105`.
 *
 * **Not decimal.** The substrate encodes workspace, tab and pane numbers in a 32-character
 * Crockford-style alphabet (`123456789ABCDEFGHJKMNPQRSTVWXYZ0`, omitting I, L, O and U), so the
 * tenth workspace is `wA` and the thirty-third is `w11`. A `\d+` pattern accepts the first
 * nine and rejects everything after — which is invisible until someone opens a tenth workspace,
 * and then every launch fails validation.
 */
const PUBLIC_NUMBER = '[0-9A-HJKMNP-TV-Z]+';

/**
 * the substrate's public workspace id, e.g. `w3`.
 *
 * OSADE.md §5.2 — a durable key, stable across other workspaces closing and across a substrate
 * restart. Always the full `wN` form: `parse_workspace_id` has a positional fallback for bare
 * integers, so sending `"3"` can resolve to a different workspace.
 */
export const SubstrateWorkspaceId = z
  .string()
  .regex(new RegExp(`^w${PUBLIC_NUMBER}$`), 'expected the substrate workspace id like w3');
export type SubstrateWorkspaceId = z.infer<typeof SubstrateWorkspaceId>;

/** substrate's public tab id, e.g. `w3:t2`. */
export const SubstrateTabId = z
  .string()
  .regex(new RegExp(`^w${PUBLIC_NUMBER}:t${PUBLIC_NUMBER}$`), 'expected the substrate tab id like w3:t2');
export type SubstrateTabId = z.infer<typeof SubstrateTabId>;

/** substrate's public pane id, e.g. `w3:p2`. The key for a status subscription (§7.2). */
export const SubstratePaneId = z
  .string()
  .regex(new RegExp(`^w${PUBLIC_NUMBER}:p${PUBLIC_NUMBER}$`), 'expected the substrate pane id like w3:p2');
export type SubstratePaneId = z.infer<typeof SubstratePaneId>;

/**
 * the substrate's `AgentStatus`, verbatim from the pinned schema.
 *
 * `done` and `idle` are not interchangeable: the substrate reports `done` when a pane is idle **and
 * unseen**, `idle` once it has been seen. See OSADE.md §6.1.
 */
export const SubstrateAgentStatus = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type SubstrateAgentStatus = z.infer<typeof SubstrateAgentStatus>;

/**
 * OSADE.md §6.1 — INVARIANT: exactly three internal agent events. Adding a fourth requires
 * changing the spec first.
 */
export const AgentEvent = z.enum(['to_in_progress', 'to_review', 'activity']);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** OSADE.md §6 — derived, never stored. Present here only as a wire type. */
export const TaskStatus = z.enum([
  'merged',
  'archived',
  'awaiting_approval',
  'needs_input',
  'review_changes_requested',
  'ci_failed',
  'verify_failed',
  'verifying',
  'pr_open',
  'awaiting_review',
  'implementing',
  'stopped',
  'queued',
  'idle',
  'blocked_external',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * The needs-you set — OSADE.md §6, rows 3–5 and 10. The ledger sorts on this, and it is the
 * entire product for someone running eight agents.
 */
export const NEEDS_YOU: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'awaiting_approval',
  'needs_input',
  'review_changes_requested',
  'awaiting_review',
]);

export function isNeedsYou(status: TaskStatus): boolean {
  return NEEDS_YOU.has(status);
}

/**
 * `api_migration` is F1's origin (OSADE-MOSS §M.5.6). It is a new *kind*, not new
 * orchestration: a migration lane is created through the same `LaunchTask` path as every other
 * lane, and this field is how the ledger can say where it came from.
 */
export const TaskOriginKind = z.enum(['issue', 'manual', 'triage', 'followup', 'api_migration']);
export type TaskOriginKind = z.infer<typeof TaskOriginKind>;

export const PrState = z.enum(['open', 'closed', 'merged']);
export type PrState = z.infer<typeof PrState>;

export const ChecksState = z.enum(['pending', 'success', 'failure', 'neutral']);
export type ChecksState = z.infer<typeof ChecksState>;

export const ReviewState = z.enum(['none', 'commented', 'changes_requested', 'approved']);
export type ReviewState = z.infer<typeof ReviewState>;

export const GateDecision = z.enum(['approve', 'deny', 'expired']);
export type GateDecision = z.infer<typeof GateDecision>;
