#!/usr/bin/env node
import { main, processIo } from './cli.js';
import { OsadeCliError } from './client.js';

/**
 * The `osade` command.
 *
 * A shim, deliberately: `cli.ts` exports `main` and executes nothing on import, so it can be
 * driven by a test that reads what a user would have seen. Running the command is this file's
 * only job.
 *
 * The obvious alternative — one file that runs itself when it detects it is the entry point —
 * was tried and does not work. Under a runner like `vite-node`, `process.argv[1]` is the
 * *runner's* CLI rather than this script, so the check is false and the command silently does
 * nothing: `--help` printed no help and an unknown command exited 0. A guess about how the
 * process was started is not a thing to build the entry point on.
 *
 * `process.argv` is read here, at the use site, and never imported as a binding. §20.1 forbids
 * destructuring `process.env` for exactly this reason and it applies just as well one property
 * over: a runner that rewrites argv does it by *reassigning* `process.argv`, so a binding
 * captured at import time keeps pointing at the array from before the rewrite — which still has
 * the script path in it, and every argument lands one place to the right.
 */
main(process.argv.slice(2)).then(
  (code) => {
    // Not `process.exit(0)`: letting the process end on its own gives stdout time to flush.
    if (code !== 0) process.exit(code);
  },
  (err: Error) => {
    // §19.4 — say what broke. A stack trace is for a bug in Osade, not for a daemon that is
    // simply not running.
    processIo.err(`${err instanceof OsadeCliError ? err.message : err.stack}\n`);
    process.exit(1);
  },
);
