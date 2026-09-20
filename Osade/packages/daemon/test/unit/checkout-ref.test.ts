import { describe, expect, it } from 'vitest';

import {
  localCheckoutName,
  parseAlreadyCheckedOut,
} from '../../src/domain/git.js';

describe('localCheckoutName', () => {
  it('strips remote-tracking prefixes so the worktree gets a local branch', () => {
    expect(localCheckoutName('feat/review')).toBe('feat/review');
    expect(localCheckoutName('origin/feat/review')).toBe('feat/review');
    expect(localCheckoutName('refs/heads/feat/review')).toBe('feat/review');
    expect(localCheckoutName('refs/remotes/origin/feat/review')).toBe('feat/review');
  });
});

describe('parseAlreadyCheckedOut', () => {
  it('reads the branch and path git reports', () => {
    expect(
      parseAlreadyCheckedOut("fatal: 'feat/review' is already checked out at '/repo'"),
    ).toEqual({ branch: 'feat/review', path: '/repo' });
  });

  it('returns null for any other worktree failure', () => {
    expect(parseAlreadyCheckedOut('could not create a worktree')).toBeNull();
  });
});
