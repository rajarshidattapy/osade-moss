import { z } from 'zod';

import { Timestamp } from './primitives.js';

/**
 * F4 — compliance on the gate, as it crosses the boundary (OSADE-MOSS §M.8).
 *
 * **INVARIANT C1: a compliance flag without a cited clause is not a flag.** There is no
 * free-text field in this file. Every shape below carries `clause_ref`, the policy file it came
 * from and the `file_sha` that file had — so a reader can open the rule rather than trust a
 * label. A type that allowed "risk: high" with no citation is exactly what this feature exists
 * not to be.
 */

export const PolicyScope = z.enum(['repo', 'global']);
export type PolicyScope = z.infer<typeof PolicyScope>;

export const ClauseCitation = z.object({
  clause_id: z.string(),
  /** e.g. `SEC-3.2`, taken from the heading that defines it. */
  clause_ref: z.string(),
  title: z.string(),
  text: z.string(),
  scope: PolicyScope,
  /** The policy file, and the exact content hash it had when the clause was read. */
  policy_path: z.string(),
  file_sha: z.string(),
  /** §M.8.3 — the only thing that can gate the approve button, and a human wrote it. */
  requires_ack: z.boolean(),
});
export type ClauseCitation = z.infer<typeof ClauseCitation>;

/** One hunk of a diff and the clauses it touches. */
export const HunkClauses = z.object({
  /** `path:startLine`. */
  hunk_ref: z.string(),
  clauses: z.array(
    ClauseCitation.extend({
      /** Advisory, and deliberately not part of the approval hash. */
      score: z.number(),
      acked_by: z.string().nullable(),
      acked_at: Timestamp.nullable(),
    }),
  ),
});
export type HunkClauses = z.infer<typeof HunkClauses>;

/**
 * What the gate card renders — §M.8.3.
 *
 * `outstandingAcks` is derived from rows on every read, never stored: a stored "approvable"
 * flag would go stale the moment a policy reload changed the clause set (§6).
 */
export const GateClauseView = z.object({
  gate_id: z.string(),
  hunks: z.array(HunkClauses),
  outstandingAcks: z.number().int(),
  /** False while any `requires_ack` clause is unacknowledged. */
  approvable: z.boolean(),
});
export type GateClauseView = z.infer<typeof GateClauseView>;

export const PolicyReloadResult = z.object({
  policies: z.number().int(),
  clauses: z.number().int(),
  /** Policy files that have been deleted; their clauses stop applying. */
  removed: z.number().int(),
});
export type PolicyReloadResult = z.infer<typeof PolicyReloadResult>;

/**
 * §M.8.4 — one gate, with everything that surrounded it.
 *
 * **Nothing here is computed by a model.** Every field is a stored fact or a hash of one, which
 * is what makes the export usable as evidence: a reader can tell which parts were recorded
 * without having to know which parts were inferred, because none of them were.
 */
export const AuditRow = z.object({
  gate_id: z.string(),
  gate: z.string(),
  repo: z.string(),
  task_id: z.string(),
  requested_at: z.string(),
  decided_at: z.string().nullable(),
  decision: z.string().nullable(),
  decided_by: z.string().nullable(),
  payload_hash: z.string(),
  head_sha: z.string().nullable(),
  executed_at: z.string().nullable(),
  execution_error: z.string().nullable(),
  verification: z.array(
    z.object({ step: z.string(), cmd: z.string(), exit: z.number().nullable() }),
  ),
  clauses_shown: z.array(
    z.object({ ref: z.string(), policy: z.string(), file_sha: z.string() }),
  ),
  clauses_acked: z.array(z.object({ ref: z.string(), by: z.string(), at: z.string() })),
  attestation_id: z.string().nullable(),
  attestation_signature: z.string().nullable(),
  attestation_key_id: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRow>;
