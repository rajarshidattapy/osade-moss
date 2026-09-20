import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Namespace, RetrievalBackend, RetrievalStats } from '@osade/contract';
import { NAMESPACES } from '@osade/contract';

import type { RetrievalConfig } from '../config.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { Db } from '../db/index.js';
import { osadePaths } from '../paths.js';
import { Fts5Adapter } from './fts5-adapter.js';
import { Indexer } from './indexer.js';
import { MossAdapter, MossUnavailableError, type MossClientLike } from './moss-adapter.js';
import type { NamespaceCounts, RetrievalHit, RetrievalPort, RetrievalQuery } from './port.js';

/**
 * The retrieval service — OSADE-MOSS §M.1.
 *
 * Owns three things the adapters deliberately do not:
 *
 *   - **R3: retrieval never fails an operation.** A timeout, a Moss exception or a session that
 *     will not open degrades the *result* and never the caller. The service catches, falls back
 *     to FTS5, records why, and returns whatever it has — including nothing. A caller cannot
 *     make a turn fail by asking for context, which is the whole point: the same discipline as
 *     the failed probe in ARCH §5.1, where a degraded dependency changes a fact about
 *     confidence rather than a task's state.
 *   - **The latency ring (§M.1.7).** 1 000 samples per namespace, in memory. Not a SQLite row
 *     per query: that would put a write on the hot path in order to measure the hot path.
 *   - **Which backend is live.** One place decides, so `stats().backend` is never a guess.
 */

const RING = 1_000;

/** §M.1.3 — "on clean shutdown and every 10 minutes". */
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1_000;

/** The cursor a snapshot corresponds to. See `#warmBoot` for why it is not optional. */
const STAMP = 'cursor.txt';

export interface RetrievalServiceOptions {
  readonly config?: RetrievalConfig;
  readonly installId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onWarning?: (message: string) => void;
  readonly now?: () => number;
  /** Tests inject a port directly and skip backend selection entirely. */
  readonly port?: RetrievalPort;
  readonly loadMossClient?: () => Promise<MossClientLike>;
  readonly indexerIntervalMs?: number;
}

export class RetrievalService {
  readonly #db: Db;
  readonly #config: RetrievalConfig;
  readonly #onWarning: (message: string) => void;
  readonly #samples = new Map<Namespace, number[]>();
  readonly #fallback: RetrievalPort;
  #port: RetrievalPort;
  #indexer: Indexer;
  #degradedReason: string | null = null;
  #mossConfigured = false;
  #moss: MossAdapter | null = null;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #indexerRunning = false;
  readonly #mossDir: string;

  private constructor(db: Db, port: RetrievalPort, fallback: RetrievalPort, options: RetrievalServiceOptions) {
    this.#db = db;
    this.#port = port;
    this.#fallback = fallback;
    this.#config = options.config ?? DEFAULT_CONFIG.retrieval;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#mossDir = osadePaths(options.env ?? process.env).mossDir;
    this.#indexer = new Indexer(db, port, {
      intervalMs: options.indexerIntervalMs,
      onWarning: this.#onWarning,
    });
  }

  /**
   * Chooses a backend and opens it.
   *
   * §M.10 row 1: with no Moss credentials, retrieval runs on FTS5, a badge says so, and
   * everything else works. That is the *expected* path for a fresh install, not an error, so
   * nothing here throws — the worst case is a warning and a degraded backend.
   */
  static async open(db: Db, options: RetrievalServiceOptions = {}): Promise<RetrievalService> {
    const env = options.env ?? process.env;
    const fallback = new Fts5Adapter(db, { now: options.now });

    if (options.port) {
      const service = new RetrievalService(db, options.port, fallback, options);
      return service;
    }

    const service = new RetrievalService(db, fallback, fallback, options);
    const projectId = env.MOSS_PROJECT_ID;
    const projectKey = env.MOSS_PROJECT_KEY;
    service.#mossConfigured = Boolean(projectId && projectKey);

    if (!service.#config.enabled) {
      service.#degradedReason = 'retrieval.enabled is false in config.json';
      return service;
    }
    if (!service.#mossConfigured) {
      service.#degradedReason = 'no Moss credentials (MOSS_PROJECT_ID / MOSS_PROJECT_KEY)';
      return service;
    }

    try {
      const moss = await MossAdapter.open({
        projectId: projectId!,
        projectKey: projectKey!,
        installId: installId(db),
        cloudSync: service.#config.cloudSync,
        onWarning: service.#onWarning,
        ...(options.loadMossClient ? { loadClient: options.loadMossClient } : {}),
      });
      service.#adopt(moss);
      service.#moss = moss;
      await service.#warmBoot(moss);
    } catch (err) {
      const reason = err instanceof MossUnavailableError ? err.message : describe(err);
      service.#degradedReason = reason;
      service.#onWarning(`retrieval is running on FTS5: ${reason}`);
    }
    return service;
  }

  get backend(): RetrievalBackend {
    return this.#port.backend;
  }

  get indexer(): Indexer {
    return this.#indexer;
  }

  start(): void {
    this.#indexerRunning = true;
    this.#indexer.start();
    // §M.1.3 — "on clean shutdown and every 10 minutes". The timer is unref'd: a disposable
    // cache is never a reason to hold the process open.
    if (this.#moss && this.#snapshotTimer == null) {
      this.#snapshotTimer = setInterval(() => void this.#snapshot(), SNAPSHOT_INTERVAL_MS);
      this.#snapshotTimer.unref?.();
    }
  }

  async close(): Promise<void> {
    this.#indexerRunning = false;
    this.#indexer.stop();
    if (this.#snapshotTimer) {
      clearInterval(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
    await this.#snapshot();
    await this.#port.close().catch(() => {});
  }

  /**
   * §M.1.3 — restore the sessions from `~/.osade/moss/`, or rebuild.
   *
   * **The snapshot is only usable at the exact cursor it was taken at.** The documents live on
   * disk and the indexer's position lives in SQLite, so a snapshot older than the cursor would
   * silently miss every row in between — and those rows are already pruned from
   * `retrieval_log`, so they could never be replayed. Rather than guess, the cursor is written
   * beside the snapshot and a mismatch means a rebuild. A rebuild is always correct (R1); a
   * half-restored index is not.
   */
  async #warmBoot(moss: MossAdapter): Promise<void> {
    const stamped = this.#readStamp();
    if (stamped != null && stamped === this.#cursor() && (await moss.loadFrom(this.#mossDir))) {
      return;
    }
    await this.#indexer.rebuild();
  }

  async #snapshot(): Promise<void> {
    const moss = this.#moss;
    if (!moss) return;
    try {
      mkdirSync(this.#mossDir, { recursive: true });
      // The cursor is read *before* the save, not after.
      //
      // On the periodic snapshot the indexer is still running, so a cursor read afterwards
      // could be newer than the documents just written — and that is the one dangerous
      // direction: the next boot would accept a stale index as current and silently lose
      // every row in between. Stamping the earlier value can only make a good snapshot look
      // stale, which costs a rebuild. Wrong in the safe direction, on purpose.
      const at = this.#cursor();
      if (!(await moss.saveTo(this.#mossDir))) return;
      writeFileSync(join(this.#mossDir, STAMP), String(at), 'utf8');
    } catch (err) {
      this.#onWarning(`snapshotting the retrieval index failed, next boot rebuilds: ${describe(err)}`);
    }
  }

  #readStamp(): number | null {
    try {
      const raw = readFileSync(join(this.#mossDir, STAMP), 'utf8').trim();
      const seq = Number.parseInt(raw, 10);
      return Number.isFinite(seq) ? seq : null;
    } catch {
      return null;
    }
  }

  #cursor(): number {
    const row = this.#db
      .prepare("SELECT last_seq FROM retrieval_cursor WHERE consumer = 'indexer'")
      .get() as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  /**
   * One namespace query, budgeted and instrumented.
   *
   * Never throws. The timeout is a race rather than a cancellation because neither Moss nor
   * SQLite offers one — the query keeps running, but the turn stops waiting for it, which is
   * what the 25 ms budget is actually promising.
   */
  async query(ns: Namespace, text: string, opts: RetrievalQuery): Promise<readonly RetrievalHit[]> {
    const started = performance.now();
    try {
      const hits = await withTimeout(
        this.#port.query(ns, text, opts),
        this.#config.queryTimeoutMs,
        `${ns} query exceeded ${this.#config.queryTimeoutMs} ms`,
      );
      this.#record(ns, performance.now() - started);
      return hits;
    } catch (err) {
      this.#record(ns, performance.now() - started);
      return this.#degrade(ns, text, opts, err);
    }
  }

  async stats(): Promise<RetrievalStats> {
    const counts = await this.#port.counts().catch((): NamespaceCounts[] => []);
    const byNs = new Map(counts.map((c) => [c.ns, c.docs]));
    return {
      backend: this.#port.backend,
      degradedReason: this.#degradedReason,
      mossConfigured: this.#mossConfigured,
      indexerLag: this.#indexer.lag(),
      namespaces: NAMESPACES.map((ns) => {
        const samples = this.#samples.get(ns) ?? [];
        return {
          ns,
          docs: byNs.get(ns) ?? 0,
          queries: samples.length,
          p50Ms: percentile(samples, 0.5),
          p95Ms: percentile(samples, 0.95),
        };
      }),
    };
  }

  async rebuild(ns?: Namespace): Promise<number> {
    return this.#indexer.rebuild(ns);
  }

  /**
   * R3 — one failure switches the live backend, it does not fail the query.
   *
   * The switch is sticky on purpose. A Moss session that threw once will usually throw again,
   * and flapping between backends mid-migration would make one lane's context silently
   * different from its sibling's. Recovery is a daemon restart or an explicit rebuild, both of
   * which are visible acts.
   */
  async #degrade(
    ns: Namespace,
    text: string,
    opts: RetrievalQuery,
    err: unknown,
  ): Promise<readonly RetrievalHit[]> {
    const reason = describe(err);
    if (this.#port !== this.#fallback) {
      this.#degradedReason = reason;
      this.#onWarning(`retrieval fell back to FTS5: ${reason}`);
      this.#adopt(this.#fallback);
      // The fallback's store is maintained by the indexer alongside Moss only when Moss is the
      // port, so it may be cold. Rebuilding it is cheap next to answering every later turn from
      // an empty index.
      await this.#indexer.rebuild().catch((rebuildErr: Error) => {
        this.#onWarning(`rebuilding the FTS5 index failed: ${rebuildErr.message}`);
      });
    } else {
      this.#degradedReason ??= reason;
    }
    // One retry, on the fallback. If that throws too, the turn goes out without this
    // namespace's context — degraded, never failed.
    try {
      return await this.#fallback.query(ns, text, opts);
    } catch (fallbackErr) {
      this.#onWarning(`retrieval returned nothing for ${ns}: ${describe(fallbackErr)}`);
      return [];
    }
  }

  /**
   * Swaps the live backend and gives the indexer a new one to write to.
   *
   * The polling state is carried across explicitly rather than inferred from "is there an
   * indexer?" — there always is, including during `open()`, which would otherwise start
   * tailing `retrieval_log` before the caller ever called `start()`.
   */
  #adopt(port: RetrievalPort): void {
    const wasRunning = this.#indexerRunning;
    this.#indexer.stop();
    this.#port = port;
    this.#indexer = new Indexer(this.#db, port, { onWarning: this.#onWarning });
    if (wasRunning) this.#indexer.start();
  }

  #record(ns: Namespace, ms: number): void {
    const samples = this.#samples.get(ns) ?? [];
    samples.push(ms);
    if (samples.length > RING) samples.shift();
    this.#samples.set(ns, samples);
  }
}

/**
 * A stable per-install id for session names (§M.1.3).
 *
 * Stored in `retrieval_cursor` rather than a new table: it is one row of retrieval bookkeeping,
 * it is regenerated harmlessly if lost (the sessions are derived), and a table for one string
 * would be a table to migrate later.
 */
function installId(db: Db): string {
  const row = db
    .prepare("SELECT last_seq FROM retrieval_cursor WHERE consumer = 'install_id'")
    .get() as { last_seq: number } | undefined;
  if (row) return row.last_seq.toString(36);
  const value = Math.abs(hash(randomUUID()));
  db.prepare("INSERT INTO retrieval_cursor (consumer, last_seq) VALUES ('install_id', ?)").run(value);
  return value.toString(36);
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
