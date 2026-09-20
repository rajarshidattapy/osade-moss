import type { Namespace, RetrievalBackend } from '@osade/contract';
import { NAMESPACES } from '@osade/contract';

import {
  metaMatches,
  type IndexDoc,
  type NamespaceCounts,
  type RetrievalHit,
  type RetrievalPort,
  type RetrievalQuery,
} from './port.js';

/**
 * An in-memory `RetrievalPort` for unit tests — OSADE-MOSS §M.1.2.
 *
 * The same reasoning as `ModelPort`'s fake (ARCH §13.2): no test should need a Moss key, a
 * network, or a native addon to exercise the indexer, the assembler or anything downstream of
 * them. Scoring is token overlap — deterministic, explainable in one line, and good enough to
 * assert ordering, which is all a consumer's test should be asserting.
 *
 * It also records every call, because several invariants are about *who called what*: R1 says
 * the indexer is the only writer, and the rebuild test asserts an identical id set.
 */
export class FakeRetrieval implements RetrievalPort {
  readonly backend: RetrievalBackend = 'fts5';
  readonly #docs = new Map<Namespace, Map<string, IndexDoc>>();
  readonly calls: { op: 'upsert' | 'remove' | 'drop' | 'query'; ns: Namespace; n: number }[] = [];
  /** Set to make the next query throw, to exercise R3's degrade path. */
  failNextQuery: Error | null = null;

  constructor() {
    for (const ns of NAMESPACES) this.#docs.set(ns, new Map());
  }

  async upsert(ns: Namespace, docs: readonly IndexDoc[]): Promise<void> {
    this.calls.push({ op: 'upsert', ns, n: docs.length });
    const bucket = this.#bucket(ns);
    for (const doc of docs) bucket.set(doc.id, doc);
  }

  async remove(ns: Namespace, ids: readonly string[]): Promise<void> {
    this.calls.push({ op: 'remove', ns, n: ids.length });
    const bucket = this.#bucket(ns);
    for (const id of ids) bucket.delete(id);
  }

  async drop(ns: Namespace): Promise<void> {
    this.calls.push({ op: 'drop', ns, n: 0 });
    this.#bucket(ns).clear();
  }

  async counts(): Promise<readonly NamespaceCounts[]> {
    return NAMESPACES.map((ns) => ({ ns, docs: this.#bucket(ns).size }));
  }

  async query(ns: Namespace, q: string, opts: RetrievalQuery): Promise<readonly RetrievalHit[]> {
    this.calls.push({ op: 'query', ns, n: opts.topK });
    if (this.failNextQuery) {
      const err = this.failNextQuery;
      this.failNextQuery = null;
      throw err;
    }
    const wanted = tokens(q);
    const filter = opts.filter ?? [];
    const hits: RetrievalHit[] = [];
    for (const doc of this.#bucket(ns).values()) {
      const meta = doc.meta as Record<string, string>;
      if (!metaMatches(meta, filter)) continue;
      const score = overlap(wanted, tokens(doc.text));
      if (opts.minScore != null && score < opts.minScore) continue;
      hits.push({ id: doc.id, score, text: doc.text, meta });
    }
    // Ties broken by id so a test asserting order is not asserting Map iteration order.
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, opts.topK);
  }

  async close(): Promise<void> {}

  /** Test helper: every id currently indexed, sorted. Used by the rebuild test. */
  ids(ns?: Namespace): string[] {
    const namespaces = ns ? [ns] : NAMESPACES;
    return namespaces.flatMap((n) => [...this.#bucket(n).keys()]).sort();
  }

  #bucket(ns: Namespace): Map<string, IndexDoc> {
    const bucket = this.#docs.get(ns);
    if (bucket) return bucket;
    const created = new Map<string, IndexDoc>();
    this.#docs.set(ns, created);
    return created;
  }
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length > 1),
  );
}

/** Jaccard-ish: shared tokens over the query's tokens. 0 when the query is empty. */
function overlap(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0) return 0.5;
  let shared = 0;
  for (const token of query) if (doc.has(token)) shared += 1;
  return shared / query.size;
}
