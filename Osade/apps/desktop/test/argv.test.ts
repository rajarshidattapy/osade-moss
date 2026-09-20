import { describe, expect, it } from 'vitest';

import { repoFromArgv } from '../src/main/argv.js';

/**
 * The argv a second instance sees is not the argv it was spawned with.
 *
 * This is a regression test for a real one: `osade .` in a second repository re-scoped the
 * window to `--allow-file-access-from-files`, because Electron had inserted its own switches
 * into the array and the path was no longer the element after `--repo`.
 */
describe('repoFromArgv', () => {
  it('reads the joined form out of an argv Electron has rewritten', () => {
    const argv = [
      'C:/app/electron.exe',
      '--allow-file-access-from-files',
      '--repo=C:/code/otherrepo',
      '--original-process-start-time=13411',
    ];
    expect(repoFromArgv(argv)).toBe('C:/code/otherrepo');
  });

  it('does not mistake a following switch for the path', () => {
    expect(repoFromArgv(['electron.exe', '--repo', '--allow-file-access-from-files'])).toBeNull();
  });

  it('still reads the two-token form someone typed by hand', () => {
    expect(repoFromArgv(['electron.exe', '.', '--repo', 'C:/code/repo'])).toBe('C:/code/repo');
  });

  it('is null when there is no repository, and for an empty value', () => {
    expect(repoFromArgv(['electron.exe', 'apps/desktop'])).toBeNull();
    expect(repoFromArgv(['electron.exe', '--repo='])).toBeNull();
    expect(repoFromArgv(['electron.exe', '--repo'])).toBeNull();
  });

  it('takes a path containing an equals sign whole', () => {
    expect(repoFromArgv(['--repo=C:/code/a=b'])).toBe('C:/code/a=b');
  });
});
