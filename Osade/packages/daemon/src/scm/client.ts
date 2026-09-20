import { Octokit } from 'octokit';

/**
 * The GitHub client — OSADE.md §11.
 *
 * INVARIANT: `packages/daemon/src/scm/**` is the only directory permitted to import an SCM SDK.
 * Enforced by lint (§20.1). Everything above this layer speaks in facts, not in Octokit types.
 *
 * INVARIANT (§2.1): the daemon never holds a GitHub token in its config file. Tokens live in
 * Electron `safeStorage` and reach the daemon at spawn over an env handshake, held in memory
 * only. Nothing here writes a token to disk.
 */

/** §11.1 — back off below this fraction of the rate limit remaining. */
const RATE_LIMIT_FLOOR = 0.2;

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  resetAt: number;
}

export interface ScmClientOptions {
  token?: string | undefined;
  /** Injected in tests so a recorded fixture can stand in for the network. */
  request?: ScmRequest;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/** The narrow shape the poller needs, so a fixture can implement it without Octokit. */
export type ScmRequest = (
  route: string,
  params: Record<string, unknown>,
) => Promise<{ status: number; headers: Record<string, string | undefined>; data: unknown }>;

export class ScmError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ScmError';
    this.status = status;
  }
}

/**
 * A read that changed nothing.
 *
 * §11.1 — a 304 is a successful poll with no new data, and is not an error. Distinguishing it
 * from a failure matters: one refreshes `fetched_at`, the other writes `fetch_failed_at`.
 */
export const NOT_MODIFIED = Symbol('not-modified');

export class ScmClient {
  readonly #request: ScmRequest;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;
  /** §11.1 — conditional requests. Keyed by route+params, holding the last ETag. */
  readonly #etags = new Map<string, string>();
  #rateLimit: RateLimit | null = null;

  constructor(options: ScmClientOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});

    if (options.request) {
      this.#request = options.request;
    } else {
      const octokit = new Octokit({ auth: options.token });
      this.#request = async (route, params) => {
        const response = await octokit.request(route, params);
        return {
          status: response.status,
          headers: response.headers as Record<string, string | undefined>,
          data: response.data,
        };
      };
    }
  }

  get rateLimit(): RateLimit | null {
    return this.#rateLimit;
  }

  /**
   * True when the rate limit is low enough that non-essential polling should stop.
   *
   * §11.1 — back off at <20% remaining. Checked by the poller before every cycle rather than
   * after a 403, because being told you are rate limited is already too late.
   */
  get shouldBackOff(): boolean {
    if (!this.#rateLimit) return false;
    if (this.#rateLimit.limit <= 0) return false;
    if (this.#now() / 1000 > this.#rateLimit.resetAt) return false;
    return this.#rateLimit.remaining / this.#rateLimit.limit < RATE_LIMIT_FLOOR;
  }

  /**
   * A conditional GET.
   *
   * Returns `NOT_MODIFIED` when GitHub answers 304 — which does not count against the rate
   * limit, and is why ETags are not optional at a 30-second cadence.
   */
  async get<T>(
    route: string,
    params: Record<string, unknown> = {},
    options: { conditional?: boolean } = {},
  ): Promise<T | typeof NOT_MODIFIED> {
    const key = cacheKey(route, params);
    const etag = options.conditional === false ? undefined : this.#etags.get(key);

    try {
      const response = await this.#request(route, {
        ...params,
        headers: etag ? { 'if-none-match': etag } : undefined,
      });

      this.#readRateLimit(response.headers);

      if (response.status === 304) return NOT_MODIFIED;

      const nextEtag = response.headers.etag;
      if (nextEtag) this.#etags.set(key, nextEtag);
      return response.data as T;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      // Octokit throws on 304 in some configurations; treat it as the non-event it is.
      if (status === 304) return NOT_MODIFIED;
      this.#readRateLimit((err as { response?: { headers?: Record<string, string> } }).response?.headers ?? {});
      throw new ScmError((err as Error).message, status);
    }
  }

  /** A write. Never called except behind an approved gate — §11.2. */
  async write<T>(route: string, params: Record<string, unknown>): Promise<T> {
    try {
      const response = await this.#request(route, params);
      this.#readRateLimit(response.headers);
      return response.data as T;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      throw new ScmError((err as Error).message, status);
    }
  }

  /** §11.1 — rate limit headers are read from every response, not polled separately. */
  #readRateLimit(headers: Record<string, string | undefined>): void {
    const limit = Number(headers['x-ratelimit-limit']);
    const remaining = Number(headers['x-ratelimit-remaining']);
    const reset = Number(headers['x-ratelimit-reset']);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;

    this.#rateLimit = { limit, remaining, resetAt: Number.isFinite(reset) ? reset : 0 };

    if (this.shouldBackOff) {
      this.#onWarning(
        `GitHub rate limit low: ${remaining}/${limit} remaining until ` +
          `${new Date(this.#rateLimit.resetAt * 1000).toISOString()}`,
      );
    }
  }
}

function cacheKey(route: string, params: Record<string, unknown>): string {
  const stable = Object.entries(params)
    .filter(([k]) => k !== 'headers')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  return `${route}?${stable}`;
}
