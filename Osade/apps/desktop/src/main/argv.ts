/**
 * `--repo=<path>` out of a command line, wherever the runner left it.
 *
 * Its own module because the only way to test anything in `electron.ts` is to import it, and
 * importing it calls `app.setPath` — a file that redirects userData as its first executable
 * statement (§2.2) cannot also be a file a test loads.
 */

/**
 * One token, not two.
 *
 * Electron rewrites the argv it hands `second-instance`: it carries Chromium's own switches, so
 * "the element after `--repo`" is not reliably the path. It arrived once as
 * `--allow-file-access-from-files`, and the window re-scoped to a repository by that name.
 *
 * The two-token form is still read, for anyone who types it by hand, but only when what follows
 * is not itself a flag.
 */
export function repoFromArgv(argv: readonly string[]): string | null {
  const joined = argv.find((arg) => arg.startsWith('--repo='));
  if (joined) return joined.slice('--repo='.length) || null;

  const at = argv.indexOf('--repo');
  const next = at >= 0 ? argv[at + 1] : undefined;
  return next && !next.startsWith('-') ? next : null;
}
