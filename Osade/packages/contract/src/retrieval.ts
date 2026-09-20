import { z } from 'zod';

import { TaskId, Timestamp } from './primitives.js';

/**
 * The retrieval layer, as it crosses the boundary — OSADE-MOSS §M.1, §M.2.
 *
 * INVARIANT R1 restated for this file: Moss is a derived view. Nothing here is a source of
 * truth, and every shape below is reconstructible from the fact tables. That is why a context
 * pack carries *ids*, not text (§M.2.4) — the renderer resolves them against rows it already
 * streams, and the index can be dropped without losing anything the UI needs.
 */

/**
 * §M.1.2 — one session per namespace.
 *
 * `code`, `policies` and `prs` are declared here before their source tables exist (migrations
 * 14–16). A namespace with no projector simply indexes nothing, which keeps the port stable
 * while the features behind it land.
 */
export const Namespace = z.enum(['turns', 'conventions', 'policies', 'code', 'prs']);
export type Namespace = z.infer<typeof Namespace>;

export const NAMESPACES = Namespace.options;

/**
 * §M.1.4 R3 — which backend answered. `fts5` is not an error state; it is the degraded mode
 * the UI badges, in the same way a failed probe is a fact about confidence rather than a
 * task state (ARCH §5.1).
 */
export const RetrievalBackend = z.enum(['moss', 'fts5']);
export type RetrievalBackend = z.infer<typeof RetrievalBackend>;

/** §M.1.7 — a 1 000-sample ring per namespace, never a per-query row in SQLite. */
export const NamespaceStats = z.object({
  ns: Namespace,
  docs: z.number().int(),
  queries: z.number().int(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
});
export type NamespaceStats = z.infer<typeof NamespaceStats>;

export const RetrievalStats = z.object({
  backend: RetrievalBackend,
  /** Why the backend is `fts5` when Moss was configured. Null when nothing is degraded. */
  degradedReason: z.string().nullable(),
  /** False when neither credentials nor the SDK are present — retrieval still works on FTS5. */
  mossConfigured: z.boolean(),
  namespaces: z.array(NamespaceStats),
  /** Rows waiting in `retrieval_log`. A number that only grows means the indexer is stuck. */
  indexerLag: z.number().int(),
});
export type RetrievalStats = z.infer<typeof RetrievalStats>;

/**
 * One cited item in a pack. `text` is the rendered line, kept out of `context_pack.items_json`
 * (§M.2.4) and re-derived on read, so the table stores ids only.
 */
export const ContextItem = z.object({
  id: z.string(),
  ns: Namespace,
  score: z.number(),
  src_table: z.string(),
  src_id: z.string(),
  /** Present when the pack is fetched for display; absent in the stored row. */
  text: z.string().optional(),
  url: z.string().nullable().optional(),
});
export type ContextItem = z.infer<typeof ContextItem>;

/**
 * §M.2.4 — the per-turn record. `retrieval_ms` is the *max* of the parallel queries, not their
 * sum: they run under one `Promise.all`, so the wall time the turn actually paid is the slowest
 * one.
 */
export const ContextPack = z.object({
  id: z.string(),
  task_id: TaskId,
  chat_turn_id: z.string().nullable(),
  arm: z.enum(['digest_on', 'digest_off']).nullable(),
  backend: RetrievalBackend,
  retrieval_ms: z.number(),
  assembly_ms: z.number(),
  tokens_used: z.number().int(),
  overflow: z.number().int(),
  degraded: z.boolean(),
  items: z.array(ContextItem),
  created_at: Timestamp,
});
export type ContextPack = z.infer<typeof ContextPack>;

/**
 * The chip on a turn (§M.2.1). Small on purpose: `TaskView` is already the heaviest push
 * payload (§M.12 Q7), so the full pack is fetched on demand through `contextPackGet`.
 */
export const ContextPackSummary = z.object({
  id: z.string(),
  items: z.number().int(),
  tokens_used: z.number().int(),
  overflow: z.number().int(),
  retrieval_ms: z.number(),
  backend: RetrievalBackend,
  degraded: z.boolean(),
  created_at: Timestamp,
});
export type ContextPackSummary = z.infer<typeof ContextPackSummary>;
