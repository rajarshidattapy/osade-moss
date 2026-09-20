import type { Namespace } from '@osade/contract';
import { NAMESPACES } from '@osade/contract';

import type { Db } from '../db/index.js';
import { RETRIEVAL_TABLES, type RetrievalTable } from '../db/migrations.js';
import type { IndexDoc, RetrievalPort } from './port.js';
import { PROJECTORS } from './projectors.js';

/**
 * The indexer — OSADE-MOSS §M.1.4.
 *
 * **INVARIANT R1: Moss is a derived view. This file is its only writer, SQLite is its only
 * input, and the index can be dropped and rebuilt at any time.** `RetrievalPort#upsert` and
 * `#remove` are lint-restricted to this module. The moment a second writer exists, `osade index
 * rebuild` stops being safe and the index starts holding facts that are nowhere else.
 *
 * **The Moss write and the cursor advance cannot be atomic** — they are different stores. So
 * the order is: write the backend, *then* advance the cursor. A crash between the two replays
 * the batch, which is harmless because document ids are deterministic (§M.1.5) and upserts
 * replace by id. The reverse order would silently drop a batch, which is not recoverable
 * without a full rebuild.
 */

const CONSUMER = 'indexer';
const BATCH = 500;

export interface IndexerOptions {
  readonly intervalMs?: number;
  readonly onWarning?: (message: string) => void;
}

interface LogRow {
  seq: number;
  table_name: string;
  row_id: string;
  op: string;
}

export class Indexer {
  readonly #db: Db;
  readonly #port: RetrievalPort;
  readonly #intervalMs: number;
  readonly #onWarning: (message: string) => void;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(db: Db, port: RetrievalPort, options: IndexerOptions = {}) {
    this.#db = db;
    this.#port = port;
    this.#intervalMs = options.intervalMs ?? 250;
    this.#onWarning = options.onWarning ?? (() => {});
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: Error) => {
        // R3 — a broken indexer degrades freshness, never an agent turn.
        this.#onWarning(`retrieval indexer: ${err.message}`);
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Rows waiting behind the cursor. Only grows when the indexer is stuck — surfaced in stats. */
  lag(): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM retrieval_log WHERE seq > ?')
      .get(this.#cursor()) as { n: number };
    return row.n;
  }

  /**
   * One batch. Re-entrant-safe: a tick that overruns its interval is skipped rather than
   * queued, because two concurrent passes would both read the same cursor.
   */
  async tick(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      return await this.#drain();
    } finally {
      this.#running = false;
    }
  }

  /** Runs until the log is empty. Used by the rebuild path and by tests. */
  async drain(limit = 100): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < limit; pass += 1) {
      const n = await this.tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  /**
   * §M.1.4 rebuild — drop the sessions and re-project every row from the source tables.
   *
   * Also the recovery path for a cache that fails to load, a changed model id, or a
   * `retrieval_log` pruned past the cursor. It is deliberately the *same* code as incremental
   * indexing after the drop: a rebuild that took a different path would be a second projector
   * implementation, and the two would drift.
   */
  async rebuild(only?: Namespace): Promise<number> {
    const namespaces = only ? [only] : NAMESPACES;
    for (const ns of namespaces) {
      await this.#port.drop(ns);
    }
    const tables = RETRIEVAL_TABLES.filter((table) => namespaces.includes(PROJECTORS[table].ns));

    let indexed = 0;
    for (const table of tables) {
      const projector = PROJECTORS[table];
      if (projector.redirect) continue; // its target table is re-projected on its own pass
      for (const ids of chunks(this.#allIds(table), BATCH)) {
        indexed += await this.#project(table, ids);
      }
    }
    // Everything is current as of now, so the log up to here is spent.
    this.#setCursor(this.#maxLogSeq());
    return indexed;
  }

  async #drain(): Promise<number> {
    const cursor = this.#cursor();
    const rows = this.#db
      .prepare(
        `SELECT seq, table_name, row_id, op FROM retrieval_log
          WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(cursor, BATCH) as LogRow[];
    if (rows.length === 0) return 0;

    // §M.1.4 step 2 — collapse to the latest op per (table, row). A row inserted and updated
    // five times in one batch is one projection, and a row deleted after being written is a
    // removal, never a write followed by a removal.
    const latest = new Map<string, LogRow>();
    for (const row of rows) latest.set(`${row.table_name}\u0000${row.row_id}`, row);

    const deletes = new Map<RetrievalTable, string[]>();
    const writes = new Map<RetrievalTable, string[]>();
    for (const row of latest.values()) {
      if (!isRetrievalTable(row.table_name)) continue;
      const bucket = row.op === 'delete' ? deletes : writes;
      const list = bucket.get(row.table_name) ?? [];
      list.push(row.row_id);
      bucket.set(row.table_name, list);
    }

    for (const [table, ids] of deletes) await this.#remove(table, ids);
    for (const [table, ids] of writes) await this.#project(table, ids);

    // Cursor last (see the class comment), in one transaction with the prune.
    const last = rows[rows.length - 1]!.seq;
    this.#db.transaction(() => {
      this.#setCursor(last);
      this.#db.prepare('DELETE FROM retrieval_log WHERE seq <= ?').run(last);
    })();
    return rows.length;
  }

  /** Loads rows, projects them, and writes. Rows that vanished are removals. */
  async #project(table: RetrievalTable, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const projector = PROJECTORS[table];

    if (projector.redirect) {
      const targets = this.#db
        .prepare(expand(projector.redirect.select, ids.length))
        .all(...ids) as { id: string }[];
      const unique = [...new Set(targets.map((row) => row.id))];
      return this.#project(projector.redirect.table, unique);
    }

    const rows = this.#db.prepare(expand(projector.select, ids.length)).all(...ids) as unknown[];
    const docs: IndexDoc[] = [];
    const present = new Set<string>();
    for (const row of rows) {
      const projected = projector.project(row);
      const id = (row as { id?: string; task_id?: string }).id ?? (row as { task_id: string }).task_id;
      present.add(id);
      docs.push(...projected);
    }

    // A row the projector declined (a rejected convention, an unfinished verify run) and a row
    // that no longer exists are the same thing to the index: whatever was there must go. This
    // is what keeps §M.2.2's provenance filter from being the only line of defence.
    const stale = ids
      .filter((id) => !docs.some((doc) => doc.meta.src_id === id))
      .map((id) => `${projector.ns}:${table}:${id}`);

    if (stale.length > 0) await this.#port.remove(projector.ns, stale);
    if (docs.length > 0) await this.#port.upsert(projector.ns, docs);
    return docs.length;
  }

  async #remove(table: RetrievalTable, ids: readonly string[]): Promise<void> {
    const projector = PROJECTORS[table];
    if (projector.redirect) {
      // The parent row is gone or has changed; re-project it rather than guessing its id from
      // a row that no longer exists.
      return;
    }
    await this.#port.remove(
      projector.ns,
      ids.map((id) => `${projector.ns}:${table}:${id}`),
    );
  }

  #allIds(table: RetrievalTable): string[] {
    const key = table === 'agent_fact' ? 'task_id' : 'id';
    const rows = this.#db.prepare(`SELECT ${key} AS id FROM ${table}`).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  #cursor(): number {
    const row = this.#db
      .prepare('SELECT last_seq FROM retrieval_cursor WHERE consumer = ?')
      .get(CONSUMER) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  #setCursor(seq: number): void {
    this.#db
      .prepare(
        `INSERT INTO retrieval_cursor (consumer, last_seq) VALUES (?, ?)
         ON CONFLICT(consumer) DO UPDATE SET last_seq = excluded.last_seq`,
      )
      .run(CONSUMER, seq);
  }

  #maxLogSeq(): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM retrieval_log')
      .get() as { seq: number };
    return row.seq;
  }
}

function isRetrievalTable(name: string): name is RetrievalTable {
  return (RETRIEVAL_TABLES as readonly string[]).includes(name);
}

/** SQLite has no array binding, so `%IDS%` becomes the right number of placeholders. */
function expand(sql: string, count: number): string {
  return sql.replace('%IDS%', new Array(count).fill('?').join(', '));
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
