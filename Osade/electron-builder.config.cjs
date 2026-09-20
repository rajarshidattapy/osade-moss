const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Packaging — OSADE.md §18.1.
 *
 * What a packaged Osade has to contain, and why each piece is here:
 *
 *   - the Electron app (main, preload, renderer)
 *   - the **daemon**, as built JavaScript, plus `better-sqlite3` — native, so it ships as files
 *     rather than bundled
 *   - a **Node runtime**, because the daemon cannot run on Electron's. `better-sqlite3` is built
 *     for one ABI (NODE_MODULE_VERSION 127 for Node 22, 130 for Electron 33) and the daemon also
 *     runs under the CLI and the tests. One runtime, one build.
 *   - the **substrate** binary Osade supervises, with the notices its licence requires
 *
 * JavaScript rather than YAML for one reason: electron-builder resolves the Electron version
 * from the *root* package.json, and Osade's electron is a devDependency of `apps/desktop`, where
 * it belongs. Pinning it here would work until the two drifted, and the failure would be a
 * packaged app running an Electron nobody tested. So it is read from the package that declares
 * it.
 *
 * **Nothing here signs anything.** Signing needs certificates this repo does not and must not
 * contain; electron-builder reads `CSC_LINK` / `CSC_KEY_PASSWORD` (and the notarisation
 * variables on macOS) from the environment when they are set. An unsigned build is fine to test
 * and not fine to hand to a user — SmartScreen and Gatekeeper will both refuse it.
 */

const desktop = JSON.parse(readFileSync(join(__dirname, 'apps/desktop/package.json'), 'utf8'));
const declaredElectron = desktop.devDependencies && desktop.devDependencies.electron;
if (!declaredElectron) throw new Error('apps/desktop does not declare electron');

module.exports = {
  appId: 'dev.osade.app',
  productName: 'Osade',
  copyright: 'Copyright © 2026 Osade contributors',
  electronVersion: declaredElectron.replace(/^[\^~]/, ''),

  // The app is `apps/desktop`, not the repo root — and that is load-bearing, not tidiness. The
  // root package.json is `"type": "module"` (vitest, vite-node, the ESM tooling), while the
  // Electron main compiles to CommonJS. Packaging the root manifest made Electron parse
  // `require(...)` as ESM and fail at load — which in a packaged app is a modal dialog nobody
  // sees, so the process just hangs. `apps/desktop/package.json` declares no type, so CommonJS.
  directories: { app: 'apps/desktop', output: 'release', buildResources: 'build' },

  files: ['dist/**/*', 'package.json', '!**/*.map'],

  // Everything the app *spawns* rather than imports. These stay real files on disk because they
  // are executed, not required.
  extraResources: [
    { from: 'packages/daemon/dist', to: 'daemon' },
    // Only the addon itself. better-sqlite3's JavaScript is bundled into the daemon, and
    // `OSADE_SQLITE_BINDING` points at this file, so neither `bindings` nor a node_modules tree
    // has to ship. The first packaged build shipped the whole package and still failed, first on
    // `zod` and then on `bindings`.
    {
      from: 'packages/daemon/node_modules/better-sqlite3/build/Release',
      to: 'daemon',
      filter: ['better_sqlite3.node'],
    },
    // §17 — the same surface for humans and agents, so the CLI ships too.
    { from: 'packages/cli/dist', to: 'cli' },
    {
      from: 'vendor/runtime/0.8.2-p20',
      to: 'runtime',
      filter: ['LICENSE', 'RUST-CRATES.md', 'pin.json', 'third-party/**', '*/osade-runtime*'],
    },
    // Populated by scripts/fetch-node-runtime.mjs.
    { from: 'vendor/node/${platform}-${arch}', to: 'node' },
    { from: 'assets/osade.png', to: 'osade.png' },
  ],

  // Copied from assets/osade.png by scripts/make-icon.mjs; electron-builder converts PNG to .ico/.icns.
  win: {
    icon: 'build/icon.png',
    target: [{ target: 'nsis', arch: ['x64'] }],
    // electron-builder signs with `CSC_LINK` (a .pfx, as a path or base64) and
    // `CSC_KEY_PASSWORD`. Absent, it builds unsigned and SmartScreen will warn on every
    // download until the certificate earns reputation — which an EV certificate starts with and
    // an OV one has to accumulate.
    signtoolOptions: {
      signingHashAlgorithms: ['sha256'],
      // RFC 3161. Without a timestamp the signature dies with the certificate, which means
      // every release ever shipped stops validating the day the cert expires.
      rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    },
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Osade',
  },

  mac: {
    icon: 'build/icon.png',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.developer-tools',
    // Gatekeeper needs all three: a hardened runtime, a Developer ID signature, and notarisation.
    // Miss any one and the app is refused with a message that does not say which.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Reads APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID, or APPLE_API_KEY +
    // APPLE_API_KEY_ID + APPLE_API_ISSUER. Off when they are absent, so a local build still runs.
    notarize: Boolean(
      process.env.APPLE_TEAM_ID || process.env.APPLE_API_KEY_ID,
    ),
  },

  linux: {
    icon: 'build/icon.png',
    target: [{ target: 'AppImage', arch: ['x64', 'arm64'] }],
    category: 'Development',
  },
};
