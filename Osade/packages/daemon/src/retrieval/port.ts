import type { Namespace, RetrievalBackend } from '@osade/contract';

/**
 * The retrieval seam — OSADE-MOSS §M.1.2.
 *
 * INVARIANT: no Moss type crosses this line. `@moss-js/moss` may be imported only under
 * `retrieval/**` (lint-enforced), and only `moss-adapter.ts` inside it actually does. The rest
 * of the daemon speaks this interface, which is why the FTS5 fallback (R3) is a swap of one
 * object rather than a second code path through every caller.
 *
 * This is the same shape as `ModelPort` (ARCH §13.2) and for the same reason: a unit test must
 * be able to exercise every consumer without a key, a network or a native addon.
 */

export type { Namespace, RetrievalBackend };

/**
 * §M.1.5 — `id` is `<ns>:<src_table>:<src_id>[:<chunk_n>]`, deterministic so re-projection is
 * idempotent. That determinism is what lets the indexer write Moss *before* advancing its
 * cursor and replay the batch harmlessly after a crash (§M.1.4).
 */
export interface IndexDoc {
  readonly id: string;
  readonly text: string;
  /** Moss's document schema is a string map, so every value is stringified at the projector. */
  readonly meta: DocMeta;
}

/**
 * INVARIANT R2: nothing enters the index without provenance.
 *
 * `src_table` and `src_id` are required by the type, and `evidence` requires at least one of
 * the four locators. A projector that omits them does not compile — which is the point:
 * §M.8.3 C1 ("a flag without a cited clause is not a flag") is only enforceable if every
 * document can be traced back to a row.
 */
export type DocMeta = {
  readonly ns: Namespace;
  readonly src_table: string;
  readonly src_id: string;
} & Evidence &
  Readonly<Record<string, string | undefined>>;

/** R2 — at least one locator. A union rather than four optional fields, so the type enforces it. */
export type Evidence =
  | { readonly url: string }
  | { readonly head_sha: string }
  | { readonly run_id: string }
  | { readonly gate_id: string };

/**
 * Osade's own filter type, translated in the adapter (§M.1.2).
 *
 * Deliberately narrower than Moss's `MetadataFilter`: no `$near`, and no nesting beyond one
 * `$and`. Everything the four features need is expressible in it, and a filter the FTS5
 * adapter cannot also evaluate would make the fallback silently return different results.
 */
export type MetaOp =
  | { readonly $eq: string }
  | { readonly $ne: string }
  | { readonly $gt: string }
  | { readonly $gte: string }
  | { readonly $lt: string }
  | { readonly $lte: string }
  | { readonly $in: readonly string[] }
  | { readonly $nin: readonly string[] };

export interface MetaCondition {
  readonly field: string;
  readonly condition: MetaOp;
}

/** A conjunction. Empty means "no filter". */
export type MetaFilter = readonly MetaCondition[];

export interface RetrievalQuery {
  readonly topK: number;
  /** Per-namespace default from `settings.ts` when omitted (§M.1.6). */
  readonly alpha?: number;
  readonly filter?: MetaFilter;
  readonly minScore?: number;
}

export interface RetrievalHit {
  readonly id: string;
  readonly score: number;
  readonly text: string;
  readonly meta: Record<string, string>;
}

export interface NamespaceCounts {
  readonly ns: Namespace;
  readonly docs: number;
}

/**
 * The port. `upsert` and `remove` are lint-restricted to `indexer.ts` (R1): one writer, or the
 * index stops being derivable and `osade index rebuild` stops being a safe operation.
 */
export interface RetrievalPort {
  upsert(ns: Namespace, docs: readonly IndexDoc[]): Promise<void>;
  remove(ns: Namespace, ids: readonly string[]): Promise<void>;
  query(ns: Namespace, q: string, opts: RetrievalQuery): Promise<readonly RetrievalHit[]>;
  /** Drops a namespace's documents. Used by rebuild, never by normal operation. */
  drop(ns: Namespace): Promise<void>;
  counts(): Promise<readonly NamespaceCounts[]>;
  readonly backend: RetrievalBackend;
  close(): Promise<void>;
}

/** Matches a document's metadata against a filter. Shared by the FTS5 and fake adapters. */
export function metaMatches(meta: Record<string, string>, filter: MetaFilter): boolean {
  return filter.every(({ field, condition }) => {
    const value = meta[field];
    if ('$eq' in condition) return value === condition.$eq;
    if ('$ne' in condition) return value !== condition.$ne;
    if ('$in' in condition) return value != null && condition.$in.includes(value);
    if ('$nin' in condition) return value == null || !condition.$nin.includes(value);
    if (value == null) return false;
    // Lexical, matching Moss's string metadata. §M.1.5 zero-pads `seq` to 12 digits so
    // lexical order equals numeric order — see §M.12 Q3.
    if ('$gt' in condition) return value > condition.$gt;
    if ('$gte' in condition) return value >= condition.$gte;
    if ('$lt' in condition) return value < condition.$lt;
    return value <= condition.$lte;
  });
}
