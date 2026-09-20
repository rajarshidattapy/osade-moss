import net from 'node:net';
import { randomUUID } from 'node:crypto';

import type { SubstrateMethod, SubstrateMethodParams } from './generated/index.js';

/**
 * Re-exported so callers can name a params shape without importing the generated client
 * directly — §4.2 restricts the *generated* module, not the facade.
 */
export type { SubstrateMethod, SubstrateMethodParams } from './generated/index.js';
import { apiSocketPath, OSADE_SESSION, toConnectTarget } from './socket-path.js';

/**
 * The substrate JSON API client — OSADE.md §4.2.
 *
 * INVARIANT: `packages/daemon/src/substrate/**` is the only place that opens the runtime socket or
 * imports the generated client.
 *
 * INVARIANT: **one request per connection.** `handle_connection_with_stop` reads exactly one
 * line, dispatches, writes one response and returns (`backend/src/api/server.rs:154-300`).
 * There is no multiplexing and no keep-alive, so there is deliberately no connection pool and
 * no correlation-id router here — there would be nothing to multiplex. Each connection is an
 * OS thread on the substrate's side, so prefer one blocking call (`agent.prompt` with `wait`) over
 * prompt-then-poll.
 */

export interface SubstrateErrorBody {
  code: string;
  message: string;
}

/** A structured error from substrate, carrying the code so callers can branch on it (§8.2). */
export class SubstrateApiError extends Error {
  readonly code: string;
  readonly method: string;
  constructor(method: string, body: SubstrateErrorBody) {
    super(`${method} failed: ${body.code}: ${body.message}`);
    this.name = 'SubstrateApiError';
    this.code = body.code;
    this.method = method;
  }
}

export class SubstrateTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SubstrateTransportError';
  }
}

/** Anything substrate returns in `result`. Callers narrow on `result.type`. */
export interface SubstrateResult {
  type: string;
  [key: string]: unknown;
}

export interface SubstrateClientOptions {
  /** Defaults to the `osade` named session (§2.2). */
  session?: string;
  socketPath?: string;
  /** Per-request timeout. Blocking methods pass their own, longer, budget. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class SubstrateClient {
  readonly socketPath: string;
  readonly #timeoutMs: number;

  constructor(options: SubstrateClientOptions = {}) {
    this.socketPath = options.socketPath ?? apiSocketPath(options.session ?? OSADE_SESSION);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One request, one connection.
   *
   * `timeoutMs` overrides the client default — pass a generous one for `agent.start`,
   * `agent.prompt` with `wait`, `agent.wait` and `pane.wait_for_output`, which block on the
   * server until they settle.
   */
  async request<M extends SubstrateMethod, R = SubstrateResult>(
    method: M,
    params: SubstrateMethodParams[M],
    timeoutMs?: number,
  ): Promise<R> {
    const id = `osade:${randomUUID()}`;
    const line = JSON.stringify({ id, method, params }) + '\n';
    const budget = timeoutMs ?? this.#timeoutMs;

    const response = await this.#roundTrip(line, budget, method);
    const parsed = JSON.parse(response) as {
      id?: string;
      result?: SubstrateResult;
      error?: SubstrateErrorBody;
    };

    if (parsed.error) throw new SubstrateApiError(method, parsed.error);
    if (!parsed.result) {
      throw new SubstrateTransportError(`${method}: response had neither result nor error`);
    }
    // The schema does not correlate a method with its `ResponseResult` variant — that mapping
    // lives in Rust, not in the bundle — so callers name the shape they expect and narrow on
    // `result.type` when it matters. Nothing here is hand-written from method names.
    return parsed.result as R;
  }

  /** `ping`, typed, because the boot sequence and health checks both need it (§18.1). */
  async ping(timeoutMs?: number): Promise<{
    version: string;
    protocol: number;
    capabilities?: {
      live_handoff?: boolean;
      detached_server_daemon?: boolean;
      /** Absent on substrate 0.8.2-p20 — every capability field is optional (§4.1). */
      endpoint_protocol_generation?: number | null;
    } | null;
  }> {
    const result = await this.request('ping', {}, timeoutMs);
    return result as never;
  }

  /** True when a server is listening. On Windows the `.sock` file alone proves nothing. */
  async isRunning(timeoutMs = 2_000): Promise<boolean> {
    try {
      await this.ping(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  #roundTrip(line: string, timeoutMs: number, method: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(toConnectTarget(this.socketPath));
      let buffer = '';
      let settled = false;

      const finish = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value!);
      };

      const timer = setTimeout(() => {
        finish(
          new SubstrateTransportError(
            `${method}: timed out after ${timeoutMs}ms on ${this.socketPath}`,
          ),
        );
      }, timeoutMs);

      socket.on('connect', () => socket.write(line));

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        // the substrate answers with exactly one line, then closes. Take the first and stop.
        if (newline >= 0) finish(null, buffer.slice(0, newline));
      });

      socket.on('end', () => {
        if (buffer.trim().length > 0) finish(null, buffer.trim());
        else finish(new SubstrateTransportError(`${method}: connection closed with no response`));
      });

      socket.on('error', (cause) => {
        finish(
          new SubstrateTransportError(`${method}: cannot reach the substrate at ${this.socketPath}`, { cause }),
        );
      });
    });
  }
}
