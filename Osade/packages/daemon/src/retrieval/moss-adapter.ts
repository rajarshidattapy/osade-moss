import { join } from 'node:path';

import type { Namespace, RetrievalBackend } from '@osade/contract';
import { NAMESPACES } from '@osade/contract';

import {
  type IndexDoc,
  type MetaFilter,
  type NamespaceCounts,
  type RetrievalHit,
  type RetrievalPort,
  type RetrievalQuery,
} from './port.js';
import { NAMESPACE_SETTINGS } from './settings.js';

/**
 * The Moss backend — OSADE-MOSS §M.1.2, §M.1.3.
 *
 * **This is the only file in Osade that may import `@moss-js/moss`** (lint-enforced), and it
 * does so through a dynamic import rather than a static one. Three reasons, all of which the
 * PRD anticipates:
 *
 *   - §M.10 requires the daemon to boot and work with no Moss credentials at all. A static
 *     import makes the SDK a hard dependency of daemon startup.
 *   - §M.12 Q5 flags the native addon as a day-one risk. ARCH §2.2 records what one native ABI
 *     mismatch already cost this project; a module that fails to load must degrade to FTS5
 *     (R3), not fail the boot.
 *   - It keeps `@moss-js/moss` an *optional* dependency, so a checkout that cannot build the
 *     addon still runs every test and every feature except semantic ranking.
 *
 * The SDK's types are not imported either — they would cross the seam through the type
 * checker. The surface used here is declared locally and asserted at the call, which is the
 * same trade the substrate client makes with generated types.
 */

/** §M.1.3 — one session per namespace, named `osade.<installId>.<ns>`. */
export interface MossAdapterOptions {
  readonly projectId: string;
  readonly projectKey: string;
  readonly installId: string;
  /** §M.1.3 — `pushIndex()` is never called unless this is true. Transcripts stay local. */
  readonly cloudSync?: boolean;
  readonly onWarning?: (message: string) => void;
  /** Tests inject a stand-in client; production loads the real SDK. */
  readonly loadClient?: () => Promise<MossClientLike>;
}

// ── the sliver of the SDK this adapter uses ────────────────────────────────────

export interface MossDoc {
  id: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface MossQueryResult {
  docs: { id: string; score: number; text: string; metadata?: Record<string, string> }[];
}

export interface MossSessionLike {
  readonly docCount?: number;
  addDocs(docs: MossDoc[], options?: { upsert?: boolean }): Promise<unknown>;
  deleteDocs(ids: string[]): Promise<unknown>;
  query(text: string, options: Record<string, unknown>): Promise<MossQueryResult>;
  pushIndex?(): Promise<unknown>;
  /** §M.1.3 warm boot. Optional so a stand-in client in a test need not implement it. */
  saveToDisk?(path: string): Promise<unknown>;
  loadFromDisk?(path: string): Promise<unknown>;
}

export interface MossClientLike {
  session(name: string, modelId?: string): Promise<MossSessionLike>;
}

export class MossUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MossUnavailableError';
  }
}

export class MossAdapter implements RetrievalPort {
  readonly backend: RetrievalBackend = 'moss';
  readonly #options: MossAdapterOptions;
  readonly #sessions = new Map<Namespace, MossSessionLike>();
  readonly #counts = new Map<Namespace, number>();
  #client: MossClientLike | null = null;

  private constructor(options: MossAdapterOptions) {
    this.#options = options;
  }

  /**
   * Opens the client and every namespace session.
   *
   * Eager rather than lazy: §M.1.1 says credentials are validated when a session is opened, so
   * opening all five here is how "are these credentials good?" gets answered once, at boot,
   * instead of on the first agent turn — which is on the hot path.
   */
  static async open(options: MossAdapterOptions): Promise<MossAdapter> {
    const adapter = new MossAdapter(options);
    adapter.#client = await (options.loadClient ?? loadMossClient)().catch((err: unknown) => {
      throw new MossUnavailableError(`could not load @moss-js/moss: ${describe(err)}`, { cause: err });
    });
    for (const ns of NAMESPACES) {
      await adapter.#open(ns);
    }
    return adapter;
  }

  async upsert(ns: Namespace, docs: readonly IndexDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const session = this.#session(ns);
    await session.addDocs(
      docs.map((doc) => ({ id: doc.id, text: doc.text, metadata: stringMeta(doc.meta) })),
      { upsert: true },
    );
    this.#counts.set(ns, (this.#counts.get(ns) ?? 0) + docs.length);
  }

  async remove(ns: Namespace, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#session(ns).deleteDocs([...ids]);
    this.#counts.set(ns, Math.max(0, (this.#counts.get(ns) ?? 0) - ids.length));
  }

  async query(ns: Namespace, q: string, opts: RetrievalQuery): Promise<readonly RetrievalHit[]> {
    const settings = NAMESPACE_SETTINGS[ns];
    const filter = toMossFilter(opts.filter ?? []);
    const result = await this.#session(ns).query(q, {
      topK: opts.topK,
      alpha: opts.alpha ?? settings.alpha,
      ...(filter ? { filter } : {}),
    });
    const floor = opts.minScore ?? settings.minScore;
    return result.docs
      .filter((doc) => doc.score >= floor)
      .map((doc) => ({
        id: doc.id,
        score: doc.score,
        text: doc.text,
        meta: doc.metadata ?? {},
      }));
  }

  /**
   * §M.1.4 rebuild — there is no "truncate session" in the SDK, so a drop is a fresh session
   * under a new generation suffix. The old one is left to be garbage; it was never pushed, so
   * it exists only in this process's memory.
   */
  async drop(ns: Namespace): Promise<void> {
    this.#sessions.delete(ns);
    this.#counts.set(ns, 0);
    await this.#open(ns, `${Date.now().toString(36)}`);
  }

  async counts(): Promise<readonly NamespaceCounts[]> {
    return NAMESPACES.map((ns) => ({ ns, docs: this.#counts.get(ns) ?? 0 }));
  }

  /**
   * §M.1.3 warm boot — writes each session to `~/.osade/moss/<ns>/`.
   *
   * Best-effort by design: a snapshot that fails costs one rebuild on the next boot, so it is
   * warned about and never thrown. Returns false if the SDK offers no disk persistence, which
   * keeps the caller's "did it warm-boot?" logic in one place.
   */
  async saveTo(dir: string): Promise<boolean> {
    let saved = false;
    for (const [ns, session] of this.#sessions) {
      if (!session.saveToDisk) return false;
      try {
        await session.saveToDisk(join(dir, ns));
        saved = true;
      } catch (err) {
        this.#options.onWarning?.(`moss: snapshotting the ${ns} session failed: ${describe(err)}`);
        return false;
      }
    }
    return saved;
  }

  /**
   * Restores every session from a snapshot directory.
   *
   * All or nothing: a partial restore would leave one namespace current and another stale, and
   * the caller could not tell. Returning false means "rebuild", which is always correct (R1).
   */
  async loadFrom(dir: string): Promise<boolean> {
    for (const [ns, session] of this.#sessions) {
      if (!session.loadFromDisk) return false;
      try {
        await session.loadFromDisk(join(dir, ns));
        this.#counts.set(ns, session.docCount ?? 0);
      } catch {
        // §M.1.3 — "a missing or corrupt cache triggers a rebuild. It is never an error."
        return false;
      }
    }
    return true;
  }

  /** §M.1.3 — the only place `pushIndex` is called, and only behind `retrieval.cloudSync`. */
  async close(): Promise<void> {
    if (this.#options.cloudSync !== true) return;
    for (const [ns, session] of this.#sessions) {
      await session.pushIndex?.().catch((err: unknown) => {
        this.#options.onWarning?.(`moss: pushing the ${ns} session failed: ${describe(err)}`);
      });
    }
  }

  async #open(ns: Namespace, generation?: string): Promise<void> {
    const client = this.#client;
    if (!client) throw new MossUnavailableError('moss client not opened');
    const suffix = generation ? `.${generation}` : '';
    const name = `osade.${this.#options.installId}.${ns}${suffix}`;
    try {
      const session = await client.session(name, NAMESPACE_SETTINGS[ns].model);
      this.#sessions.set(ns, session);
      this.#counts.set(ns, session.docCount ?? 0);
    } catch (err) {
      throw new MossUnavailableError(`could not open the ${ns} session: ${describe(err)}`, { cause: err });
    }
  }

  #session(ns: Namespace): MossSessionLike {
    const session = this.#sessions.get(ns);
    if (!session) throw new MossUnavailableError(`the ${ns} session is not open`);
    return session;
  }
}

/**
 * Loads the SDK at runtime.
 *
 * The specifier is built at call time so a bundler cannot hoist it into a hard requirement —
 * the daemon ships as one esbuild bundle (`scripts/bundle.mjs`), and a statically analysable
 * `import('@moss-js/moss')` would be pulled in and would fail the build on a machine where the
 * addon cannot be installed.
 */
async function loadMossClient(): Promise<MossClientLike> {
  const specifier = ['@moss-js', 'moss'].join('/');
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    MossClient?: new (projectId: string, projectKey: string) => MossClientLike;
  };
  if (!mod.MossClient) throw new Error('@moss-js/moss exports no MossClient');
  const id = process.env.MOSS_PROJECT_ID ?? '';
  const key = process.env.MOSS_PROJECT_KEY ?? '';
  return new mod.MossClient(id, key);
}

/** Moss's document schema is a string map; `undefined` values are dropped rather than sent. */
function stringMeta(meta: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Translates Osade's filter into Moss's `MetadataFilter` (§M.1.2).
 *
 * Moss takes a single condition bare and a conjunction under `$and`, so a one-element filter
 * must not be wrapped — the docs are explicit that "a single condition can be passed on its
 * own", and the wrapped form is not documented to be equivalent.
 */
export function toMossFilter(filter: MetaFilter): unknown {
  if (filter.length === 0) return null;
  const conditions = filter.map((c) => ({ field: c.field, condition: c.condition }));
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
