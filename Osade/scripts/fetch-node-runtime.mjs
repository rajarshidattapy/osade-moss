#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fetch the Node runtime the packaged app runs the daemon on — OSADE.md §18.1.
 *
 * The daemon cannot run on Electron's Node. `better-sqlite3` is compiled for one ABI at a time
 * (`NODE_MODULE_VERSION` 127 for Node 22, 130 for Electron 33), and the daemon also runs
 * standalone under the CLI and the test suite — so pinning it to Electron would mean maintaining
 * two ABI-matched builds of every native module and two ways to get it wrong. §2 already treats
 * the daemon as an independent process that outlives the window. This makes the runtime match.
 *
 * Shipping a Node is the cheaper half of that trade: one binary per platform against a second
 * native toolchain for every dependency, forever.
 *
 * **Verified against Node's own SHASUMS256.txt**, fetched per release. Not a checksum committed
 * here — nodejs.org publishes the manifest, and copying it into this repo would just be a second
 * place for it to be wrong.
 *
 *   node scripts/fetch-node-runtime.mjs [--all]
 */

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = join(ROOT, 'vendor', 'node');

/** Pinned. Bump deliberately: this is the runtime the shipped daemon executes on. */
export const NODE_VERSION = 'v22.23.2';

const TARGETS = {
  'win32-x64': { archive: `node-${NODE_VERSION}-win-x64.zip`, bin: 'node.exe' },
  'darwin-arm64': { archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, bin: 'bin/node' },
  'darwin-x64': { archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`, bin: 'bin/node' },
  'linux-x64': { archive: `node-${NODE_VERSION}-linux-x64.tar.gz`, bin: 'bin/node' },
  'linux-arm64': { archive: `node-${NODE_VERSION}-linux-arm64.tar.gz`, bin: 'bin/node' },
};

function shasums() {
  const url = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
  const text = execFileSync('curl', ['-sSL', '--fail', url], { encoding: 'utf8' });
  const map = new Map();
  for (const line of text.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) map.set(name, hash);
  }
  return map;
}

/** unzip first, bsdtar as the fallback; both from inside the directory, never with a drive path. */
function unpack(archive, dir) {
  if (archive.endsWith('.zip')) {
    try {
      execFileSync('unzip', ['-o', '-q', archive], { cwd: dir });
      return;
    } catch {
      execFileSync('tar', ['-xf', archive], { cwd: dir });
      return;
    }
  }
  execFileSync('tar', ['-xzf', archive], { cwd: dir });
}

function fetchOne(target, sums) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`no Node build mapped for ${target}`);

  const expected = sums.get(spec.archive);
  if (!expected) throw new Error(`${spec.archive} is not in SHASUMS256.txt for ${NODE_VERSION}`);

  const dir = join(OUT, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const archive = join(dir, spec.archive);
  process.stdout.write(`${target} … `);
  execFileSync('curl', ['-sSL', '--fail', '-o', archive, `https://nodejs.org/dist/${NODE_VERSION}/${spec.archive}`]);

  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (actual !== expected) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `checksum mismatch for ${spec.archive}\n  expected ${expected}\n  got      ${actual}`,
    );
  }

  unpack(spec.archive, dir);
  rmSync(archive, { force: true });

  // Keep the executable, discard npm, headers, docs — ~50 MB of things the daemon never uses.
  const extracted = readdirSync(dir).find((entry) => entry.startsWith('node-'));
  if (!extracted) throw new Error('the archive did not contain a node- directory');
  const binary = join(dir, extracted, spec.bin);
  if (!existsSync(binary)) throw new Error(`no ${spec.bin} inside ${extracted}`);

  renameSync(binary, join(dir, target.startsWith('win32') ? 'node.exe' : 'node'));
  rmSync(join(dir, extracted), { recursive: true, force: true });

  process.stdout.write('ok\n');
}

function main() {
  const all = process.argv.includes('--all');
  const sums = shasums();
  const targets = all ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`];

  for (const target of targets) fetchOne(target, sums);

  process.stdout.write(
    `\nNode ${NODE_VERSION} in vendor/node/, verified against nodejs.org's SHASUMS256.txt.\n` +
      `The packaged app points OSADE_NODE_BIN at it; see OSADE.md §18.1.\n`,
  );
}

main();
