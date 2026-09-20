import { readFileSync } from 'node:fs';

import { osadePaths } from './paths.js';

/**
 * `config.json` — OSADE-MOSS §M.9.2.
 *
 * Non-secret settings only. `MOSS_PROJECT_ID` / `MOSS_PROJECT_KEY` and `OSADE_GITHUB_TOKEN` are
 * secrets: they arrive over the spawn handshake and are held in memory (ARCH §2.1, §12). A
 * setting that would be a security problem in a plaintext file does not belong in this file,
 * and the type below is the enforcement — there is nowhere to put one.
 *
 * Every field is optional and every read falls back to a default, because a missing or
 * malformed config must not stop the daemon booting. A user who hand-edits JSON and drops a
 * comma should get defaults and a warning, not a dead app.
 */

export interface RetrievalConfig {
  readonly enabled: boolean;
  /** §M.1.3 — `pushIndex()` is never called unless this is true. */
  readonly cloudSync: boolean;
  /** §M.2.2 step 4 — the cap is the feature (ARCH §13.3), now applied per turn. */
  readonly budgetTokens: number;
  /** §M.1.4 R3 — a query over budget is dropped for this turn; the turn still goes. */
  readonly queryTimeoutMs: number;
}

/** §M.9.2 — `server.listen` is the one setting that changes ARCH §5.5's network posture. */
export interface ServerConfig {
  readonly listen: 'loopback' | 'lan';
  readonly port: number;
  readonly sessionTtlHours: number;
}

export interface OsadeConfig {
  readonly retrieval: RetrievalConfig;
  readonly server: ServerConfig;
}

export const DEFAULT_CONFIG: OsadeConfig = {
  retrieval: { enabled: true, cloudSync: false, budgetTokens: 1_200, queryTimeoutMs: 25 },
  // Loopback by default, always. Opting into `lan` is a deliberate act, and M1 then requires
  // auth and TLS before anything binds (§M.6.1).
  server: { listen: 'loopback', port: 0, sessionTtlHours: 12 },
};

export function loadConfig(
  options: { path?: string; onWarning?: (message: string) => void } = {},
): OsadeConfig {
  const path = options.path ?? osadePaths().configJson;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No config is the normal case, not an error worth warning about.
    return DEFAULT_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OsadeConfig>;
    return {
      retrieval: { ...DEFAULT_CONFIG.retrieval, ...(parsed.retrieval ?? {}) },
      server: { ...DEFAULT_CONFIG.server, ...(parsed.server ?? {}) },
    };
  } catch (err) {
    options.onWarning?.(
      `${path} is not valid JSON, so defaults are in use: ${err instanceof Error ? err.message : String(err)}`,
    );
    return DEFAULT_CONFIG;
  }
}
