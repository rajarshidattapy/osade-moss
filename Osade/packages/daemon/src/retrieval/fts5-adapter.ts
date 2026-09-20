import type { Namespace, RetrievalBackend } from '@osade/contract';

import type { Db } from '../db/index.js';
import {
  metaMatches,
  type IndexDoc,
  type MetaFilter,
  type NamespaceCounts,
  type RetrievalHit,
  type RetrievalPort,
  type RetrievalQuery,
} from './port.js';

/**
 * The fallback backend — OSADE-MOSS §M.1.2, R3.
 *
 * This is not a stub. It is the backend Osade runs on when there are no Moss credentials, when
 * the SDK is not installed, and whenever Moss throws (§M.10) — which means it has to return
 * *usable* results, not empty ones. It runs over SQLite's FTS5, the same machinery migration 11
 * already uses for memory.
 *
 * What it does not do is semantic matching. An aliased import that F1's discovery finds through
 * meaning will not be found here, and that gap is exactly what the degraded-retrieval badge is
 * telling the user about. `alpha` is therefore ignored rather than approximated: pretending to
 * blend would make the fallback's results look like Moss's without being them.
 */
export class Fts5Adapter implements RetrievalPort {
  readonly backend: RetrievalBackend = 'fts5';
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  async upsert(ns: Namespace, docs: readonly IndexDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const stmt = this.#db.prepare(
      `INSERT INTO retrieval_doc (id, ns, text, meta_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ns = excluded.ns, text = excluded.text,
         meta_json = excluded.meta_json, updated_at = excluded.updated_at`,
    );
    const at = this.#now();
    this.#db.transaction(() => {
      for (const doc of docs) stmt.run(doc.id, ns, doc.text, JSON.stringify(doc.meta), at);
    })();
  }

  async remove(_ns: Namespace, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.#db.prepare('DELETE FROM retrieval_doc WHERE id = ?');
    this.#db.transaction(() => {
      for (const id of ids) stmt.run(id);
    })();
  }

  async drop(ns: Namespace): Promise<void> {
    this.#db.prepare('DELETE FROM retrieval_doc WHERE ns = ?').run(ns);
  }

  async counts(): Promise<readonly NamespaceCounts[]> {
    return this.#db
      .prepare('SELECT ns, COUNT(*) AS docs FROM retrieval_doc GROUP BY ns')
      .all() as NamespaceCounts[];
  }

  async query(ns: Namespace, q: string, opts: RetrievalQuery): Promise<readonly RetrievalHit[]> {
    const match = ftsQuery(q);
    const filter = opts.filter ?? [];
    // An empty query is not an error: §M.6.5's catch-up guarantees an exact-filter include
    // regardless of ranking, so "everything matching the filter" is a real request.
    const rows = match == null ? this.#recent(ns, opts.topK, filter) : this.#match(ns, match, opts.topK, filter);

    const hits: RetrievalHit[] = [];
    for (const row of rows) {
      const meta = parseMeta(row.meta_json);
      if (!metaMatches(meta, filter)) continue;
      // bm25() is a *cost* — lower is better, and it is negative. Map it onto a 0..1 scale so
      // a caller's `minScore` and the assembler's weighting mean the same thing on both
      // backends. The shape is arbitrary; the ordering it produces is not.
      const score = row.rank == null ? 0.5 : 1 / (1 + Math.max(0, -row.rank));
      if (opts.minScore != null && score < opts.minScore) continue;
      hits.push({ id: row.id, score, text: row.text, meta });
      if (hits.length >= opts.topK) break;
    }
    return hits;
  }

  async close(): Promise<void> {
    // Nothing to release: the database handle belongs to the daemon, not to this adapter.
  }

  /**
   * Over-fetch, because the metadata filter is applied in JS afterwards.
   *
   * Pushing the filter into SQL with `json_extract` is possible and was considered. It is not
   * worth it: the filter subset includes `$nin` over arrays, the FTS join already limits the
   * candidate set, and one filter implementation shared with the fake adapter is one place for
   * the semantics to be wrong.
   */
  #match(ns: Namespace, match: string, topK: number, filter: MetaFilter): DocRow[] {
    return this.#db
      .prepare(
        `SELECT d.id, d.text, d.meta_json, bm25(retrieval_doc_fts) AS rank
           FROM retrieval_doc d
           JOIN retrieval_doc_fts ON d.rowid = retrieval_doc_fts.rowid
          WHERE retrieval_doc_fts MATCH ? AND d.ns = ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, ns, overFetch(topK, filter)) as DocRow[];
  }

  #recent(ns: Namespace, topK: number, filter: MetaFilter): DocRow[] {
    return this.#db
      .prepare(
        `SELECT id, text, meta_json, NULL AS rank
           FROM retrieval_doc WHERE ns = ?
          ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(ns, overFetch(topK, filter)) as DocRow[];
  }
}

interface DocRow {
  id: string;
  text: string;
  meta_json: string;
  rank: number | null;
}

function overFetch(topK: number, filter: MetaFilter): number {
  return filter.length === 0 ? topK : Math.min(topK * 20, 1000);
}

function parseMeta(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed == null || typeof parsed !== 'object') return {};
    return parsed as Record<string, string>;
  } catch {
    // A corrupt row is a rebuildable-cache problem (§M.1.3), not a query failure.
    return {};
  }
}

/**
 * Quote tokens so FTS5 operators in retrieved text cannot change the query.
 *
 * Same rule as `knowledge/memory.ts`, and it matters more here: the query text is a user's
 * turn, which routinely contains `*`, quotes and `AND`.
 */
function ftsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.replace(/["*]/g, ''))
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return null;
  // OR, not AND: this is a relevance query over prose, and requiring every token of a
  // 40-word turn to appear would return nothing on almost every turn.
  return tokens.slice(0, 40).map((token) => `"${token}"`).join(' OR ');
}
