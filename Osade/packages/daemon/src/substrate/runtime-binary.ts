import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUBSTRATE_PIN } from './generated/index.js';

/**
 * The runtime executable the daemon runs its boot drift check against (§4.1.1).
 *
 * Osade ships the runtime as `osade-runtime` and should never depend on a user having installed
 * anything else: a packaged machine has nothing useful on PATH. The desktop supervisor resolves
 * the same binary and hands it over as `OSADE_SUBSTRATE_BIN`; this is the lookup for when the
 * daemon is started on its own (`osade-daemon start`, the e2e suites).
 *
 * In order: the explicit override, the packaged layout (`resources/daemon/` beside
 * `resources/runtime/<target>/`), the vendored copy in a checkout, and last a bare name for PATH.
 */

/** Rust target triples by Node platform and arch — the directory names under `vendor/runtime/`. */
const TARGETS: Readonly<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

export const RUNTIME_EXECUTABLE =
  process.platform === 'win32' ? 'osade-runtime.exe' : 'osade-runtime';

export function runtimeTarget(): string | undefined {
  return TARGETS[`${process.platform}-${process.arch}`];
}

export function runtimeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OSADE_SUBSTRATE_BIN;
  if (explicit) return explicit;

  const target = runtimeTarget();
  let here: string | undefined;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = undefined;
  }

  if (target && here) {
    const packaged = join(here, '..', 'runtime', target, RUNTIME_EXECUTABLE);
    if (existsSync(packaged)) return packaged;

    // A checkout runs this from src/ or from a bundle in dist/, at different depths, so walk up
    // to the repository rather than counting `..`s that are right for only one of them.
    let dir = here;
    for (let depth = 0; depth < 6; depth += 1) {
      const vendored = join(dir, 'vendor', 'runtime', SUBSTRATE_PIN.key, target, RUNTIME_EXECUTABLE);
      if (existsSync(vendored)) return vendored;
      dir = dirname(dir);
    }
  }

  return RUNTIME_EXECUTABLE;
}
