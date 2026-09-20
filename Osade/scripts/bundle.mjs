#!/usr/bin/env node
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Bundle a workspace package to runnable JavaScript.
 *
 * Osade's packages resolve to TypeScript in development — `main` is `./src/index.ts`, which is
 * what lets vitest and vite-node run the tree with no build step. That is a good default and it
 * is why nothing was ever built: it works right up until something has to run under plain node,
 * at which point `bin` points at a `.ts` file and the Electron supervisor can only start the
 * daemon by shelling out to a dev runner.
 *
 * The split that makes both work:
 *
 * - **Workspace code is bundled.** `@osade/contract` resolves to `src/index.ts`, so leaving it
 *   external would produce a dist that loads TypeScript at runtime — which is exactly the
 *   failure this exists to remove.
 * - **Real dependencies stay external.** `better-sqlite3` is a native module and cannot be
 *   bundled at all; the rest are resolved from `node_modules` the way node expects.
 *
 * Externals come from the package's own `dependencies`, minus anything `workspace:*`, so adding
 * a dependency does not silently start bundling it.
 *
 *   node scripts/bundle.mjs <package-dir> <entry> <outfile>
 */

const [packageDir, entry, outfile] = process.argv.slice(2);
if (!packageDir || !entry || !outfile) {
  process.stderr.write('usage: node scripts/bundle.mjs <package-dir> <entry> <outfile>\n');
  process.exit(2);
}

const root = resolve(packageDir);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Packages that cannot be bundled, and nothing else.
 *
 * A native module is a `.node` binary loaded at runtime; esbuild has nothing to inline and the
 * file has to exist on disk beside the output. Everything else — zod, ws, octokit, @trpc/server,
 * yaml — is JavaScript and belongs *inside* the bundle, because the alternative is shipping a
 * pnpm `node_modules` tree with a packaged app and discovering at launch which transitive
 * dependency did not come along. That is not hypothetical: the first packaged build shipped
 * better-sqlite3 alone and died on `Cannot find package 'zod'`.
 */
// better-sqlite3's JavaScript bundles fine; only its `.node` addon cannot. The addon is loaded
// by a runtime path (`OSADE_SQLITE_BINDING`), which esbuild leaves alone.
// node-pty loads conpty.dll / spawn-helper from its own package tree and cannot be inlined.
const UNBUNDLABLE = new Set(['node-pty']);

const external = Object.keys(manifest.dependencies ?? {}).filter((name) => UNBUNDLABLE.has(name));

const result = await build({
  entryPoints: [join(root, entry)],
  outfile: join(root, outfile),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  /**
   * CommonJS globals, which ESM output does not have.
   *
   * Bundled dependencies are still CommonJS underneath and reach for `require`, `__filename` and
   * `__dirname` — `bindings`, which better-sqlite3 falls back to, uses all three. Without these
   * the daemon starts, passes its drift check, and dies on `__filename is not defined` the moment
   * it opens the database.
   */
  banner: {
    js: [
      "import { createRequire as __osadeCreateRequire } from 'node:module';",
      "import { fileURLToPath as __osadeFileURLToPath } from 'node:url';",
      "import { dirname as __osadeDirname } from 'node:path';",
      'const require = __osadeCreateRequire(import.meta.url);',
      'const __filename = __osadeFileURLToPath(import.meta.url);',
      'const __dirname = __osadeDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
process.stdout.write(
  `${manifest.name}: ${outfile} (${Math.round(bytes / 1024)} kB)\n` +
    `  external: ${external.join(', ') || '(none)'}\n`,
);
