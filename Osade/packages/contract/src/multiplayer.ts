import { z } from 'zod';

import { RetrievalBackend } from './retrieval.js';
import { TaskId, Timestamp } from './primitives.js';

/**
 * F2 — multiplayer lanes, as it crosses the boundary (OSADE-MOSS §M.6).
 *
 * **GitHub login is the only identity here.** There is no display name, no avatar URL and no
 * Osade user id, because §M.6.3 needs `decided_by` to mean something outside this machine —
 * and a name only means something if GitHub says whose it is.
 */

export const Role = z.enum(['owner', 'maintainer', 'viewer']);
export type Role = z.infer<typeof Role>;

export const Member = z.object({
  login: z.string(),
  role: Role,
  invited_by: z.string(),
  invited_at: Timestamp,
});
export type Member = z.infer<typeof Member>;

/**
 * What `authExchange` returns.
 *
 * The token appears here exactly once, on the way out. Only its hash is stored, so a database
 * that leaks cannot be replayed as a session.
 */
export const SessionGrant = z.object({
  token: z.string(),
  login: z.string(),
  role: Role,
  expires_at: Timestamp,
});
export type SessionGrant = z.infer<typeof SessionGrant>;

/** §M.6.5 — one thing that happened while you were away, cited to its source row. */
export const CatchUpItem = z.object({
  kind: z.string(),
  src_table: z.string(),
  src_id: z.string(),
  task_id: TaskId.nullable(),
  text: z.string(),
  at: Timestamp,
  /** Null for the guaranteed half: those are not ranked, so they have no score. */
  score: z.number().nullable(),
  /**
   * True when this item was included by exact filter rather than by similarity.
   *
   * Surfaced so the UI can say so. "Everything important, plus what else looked relevant" is a
   * different promise from "the twelve most relevant things", and a reader deciding whether
   * they are caught up needs to know which one they are looking at.
   */
  guaranteed: z.boolean(),
});
export type CatchUpItem = z.infer<typeof CatchUpItem>;

export const CatchUpResult = z.object({
  chat_id: z.string(),
  since_seq: Timestamp,
  items: z.array(CatchUpItem),
  backend: RetrievalBackend,
  retrieval_ms: z.number(),
});
export type CatchUpResult = z.infer<typeof CatchUpResult>;

/** §M.6.1 — what `osade share` prints and `osade join` consumes. */
export const ShareInfo = z.object({
  mode: z.enum(['loopback', 'lan']),
  /** Null on loopback, where there is nothing to join from another machine. */
  joinCode: z.string().nullable(),
  fingerprint: z.string().nullable(),
  members: z.array(Member),
});
export type ShareInfo = z.infer<typeof ShareInfo>;

/**
 * F3's maintainer-facing half — OSADE-MOSS §M.7.5.
 *
 * **INVARIANT A2: signals are never acted on publicly without a gate.** There is no `action`
 * field and no `dismissed` flag, because nothing here closes, labels or comments on anything.
 *
 * `top_score` travels beside `similar_to` and is rendered as "similar to #412 (0.91)", never as
 * a verdict. Two people solving the same issue is the normal outcome of an open tracker, and a
 * type with a `spam: boolean` would be wrong about the thing it exists to help with.
 */
export const PrSignalKind = z.enum([
  'near_duplicate',
  'attested',
  'attestation_stale',
  'attestation_invalid',
]);
export type PrSignalKind = z.infer<typeof PrSignalKind>;

export const TriageRow = z.object({
  number: z.number().int(),
  author: z.string(),
  title: z.string(),
  head_sha: z.string(),
  /** A valid attestation naming this PR's current head. */
  attested: z.boolean(),
  /** Verified, but for an earlier commit. A real approval, superseded — not a forgery. */
  stale: z.boolean(),
  invalid: z.boolean(),
  duplicates: z.number().int(),
  similar_to: z.array(z.number().int()),
  top_score: z.number().nullable(),
});
export type TriageRow = z.infer<typeof TriageRow>;

/** §M.7.4 — what `osade attest verify` says about a pull request. */
export const AttestationCheck = z.object({
  state: z.enum(['absent', 'invalid', 'stale', 'valid']),
  reason: z.string().nullable(),
  approved_by: z.string().nullable(),
  approved_head: z.string().nullable(),
  current_head: z.string(),
});
export type AttestationCheck = z.infer<typeof AttestationCheck>;
