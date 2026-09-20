import { describe, expect, it } from 'vitest';

import { parseGitHubRemote } from '../../src/domain/git.js';

/**
 * §11 — reading a repo's GitHub identity from its remote.
 *
 * The consequential failure is not "we couldn't parse it": it is parsing the *wrong* owner and
 * sending someone a pull request. So the null cases matter more than the happy ones.
 */
describe('parseGitHubRemote', () => {
  it('reads HTTPS remotes, with and without .git', () => {
    expect(parseGitHubRemote('https://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      name: 'widget',
    });
    expect(parseGitHubRemote('https://github.com/acme/widget')).toEqual({
      owner: 'acme',
      name: 'widget',
    });
  });

  it('reads SSH remotes — a repo cloned over SSH is not a different repo', () => {
    expect(parseGitHubRemote('git@github.com:acme/widget.git')).toEqual({
      owner: 'acme',
      name: 'widget',
    });
    expect(parseGitHubRemote('ssh://git@github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      name: 'widget',
    });
  });

  it('reads git:// remotes', () => {
    expect(parseGitHubRemote('git://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      name: 'widget',
    });
  });

  it('tolerates surrounding whitespace, as `git remote get-url` returns', () => {
    expect(parseGitHubRemote('  https://github.com/acme/widget.git\n')).toEqual({
      owner: 'acme',
      name: 'widget',
    });
  });

  it('keeps names that contain dots without eating them', () => {
    expect(parseGitHubRemote('https://github.com/acme/widget.js.git')).toEqual({
      owner: 'acme',
      name: 'widget.js',
    });
  });

  it('returns null for non-GitHub hosts rather than guessing', () => {
    // Guessing here would address a pull request to a stranger.
    expect(parseGitHubRemote('https://gitlab.com/acme/widget.git')).toBe(null);
    expect(parseGitHubRemote('git@bitbucket.org:acme/widget.git')).toBe(null);
    expect(parseGitHubRemote('https://github.example.com/acme/widget')).toBe(null);
  });

  it('returns null for a local or malformed remote', () => {
    expect(parseGitHubRemote('/srv/git/widget')).toBe(null);
    expect(parseGitHubRemote('')).toBe(null);
    expect(parseGitHubRemote('https://github.com/acme')).toBe(null);
  });
});
