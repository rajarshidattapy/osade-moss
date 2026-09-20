import { describe, expect, it } from 'vitest';

import { heldReason, isolatedWorktreeHint, attachCheckoutHint } from '../src/renderer/branch-copy.js';

describe('branch copy', () => {
  it('names the holder when a branch is already checked out', () => {
    expect(heldReason('feat/review', { title: 'Review round one' })).toBe(
      'feat/review is already checked out by “Review round one”',
    );
  });

  it('tells the truth about moving an isolated worktree', () => {
    expect(isolatedWorktreeHint()).toMatch(/close this lane and open one on the target branch/i);
  });

  it('does not promise a silent checkout of main', () => {
    expect(attachCheckoutHint()).toMatch(/does not switch you to main/i);
  });
});
