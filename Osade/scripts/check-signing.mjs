#!/usr/bin/env node

/**
 * Refuse to build a release nobody can safely install — OSADE.md §18.1.
 *
 * electron-builder signs when the credentials are in the environment and builds happily without
 * them when they are not. That default is right for a local build and wrong for a release: an
 * unsigned artefact looks exactly like a signed one until a user downloads it, at which point
 * SmartScreen calls it unrecognised and Gatekeeper refuses to open it at all. The failure lands
 * on the person least able to diagnose it.
 *
 * So `pnpm package` checks first. `pnpm package:dir` does not — an unpacked build is for testing
 * and never leaves the machine.
 *
 * `OSADE_ALLOW_UNSIGNED=1` overrides, deliberately loudly. There are real reasons to want an
 * unsigned installer (reproducing a packaging bug, a CI dry run) and none of them should be the
 * quiet default.
 *
 *   node scripts/check-signing.mjs
 */

/** Windows: a .pfx and its password, as a path or base64. */
function windows() {
  const link = process.env.WIN_CSC_LINK ?? process.env.CSC_LINK;
  const password = process.env.WIN_CSC_KEY_PASSWORD ?? process.env.CSC_KEY_PASSWORD;

  if (!link) return ['CSC_LINK — the code-signing certificate (.pfx path, or base64 of one)'];
  if (!password) return ['CSC_KEY_PASSWORD — the certificate password'];
  return [];
}

/**
 * macOS: a Developer ID signature *and* notarisation. Both, or Gatekeeper refuses the app
 * without saying which one is missing.
 */
function macos() {
  const missing = [];

  const identity = process.env.CSC_LINK ?? process.env.CSC_NAME;
  if (!identity) {
    missing.push('CSC_LINK or CSC_NAME — the Developer ID Application certificate');
  }

  const appleId =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  const apiKey =
    process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  if (!appleId && !apiKey) {
    missing.push(
      'notarisation credentials — either APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, ' +
        'or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER',
    );
  }

  return missing;
}

function main() {
  // AppImage carries no signature either gatekeeper checks; nothing to require.
  const checks = { win32: windows, darwin: macos };
  const check = checks[process.platform];
  if (!check) {
    process.stdout.write(`signing: nothing required on ${process.platform}.\n`);
    return;
  }

  const missing = check();
  if (missing.length === 0) {
    process.stdout.write('signing: credentials present.\n');
    return;
  }

  if (process.env.OSADE_ALLOW_UNSIGNED === '1') {
    process.stderr.write(
      'signing: BUILDING UNSIGNED — OSADE_ALLOW_UNSIGNED=1.\n' +
        `  missing: ${missing.join('\n           ')}\n` +
        '  This artefact will be refused or warned about on a user machine. Do not publish it.\n',
    );
    return;
  }

  process.stderr.write(
    `\nRefusing to build a release: it would be unsigned.\n\n` +
      `Missing:\n  ${missing.join('\n  ')}\n\n` +
      `An unsigned build is indistinguishable from a signed one until someone downloads it —\n` +
      `then SmartScreen calls it unrecognised, or Gatekeeper refuses to open it.\n\n` +
      `Set the variables above, or:\n` +
      `  pnpm package:dir              an unpacked build for testing, never published\n` +
      `  OSADE_ALLOW_UNSIGNED=1 pnpm package   if you mean it\n\n` +
      `Certificates are read from the environment and never committed.\n\n`,
  );
  process.exit(1);
}

main();
