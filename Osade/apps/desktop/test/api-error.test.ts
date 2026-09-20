import { describe, expect, it } from 'vitest';

import { humanizeDaemonError } from '../src/renderer/api.js';

describe('humanizeDaemonError', () => {
  it('turns a Zod too_small dump into a short sentence', () => {
    expect(
      humanizeDaemonError(
        JSON.stringify([
          {
            code: 'too_small',
            minimum: 1,
            type: 'string',
            inclusive: true,
            exact: false,
            message: 'String must contain at least 1 character(s)',
            path: [],
          },
        ]),
      ),
    ).toBe('a required value was empty');
  });

  it('names the field when Zod reports one', () => {
    expect(
      humanizeDaemonError(
        JSON.stringify([{ code: 'too_small', type: 'string', path: ['title'], message: 'too small' }]),
      ),
    ).toBe('title is required');
  });

  it('leaves an ordinary message alone', () => {
    expect(humanizeDaemonError('unknown task')).toBe('unknown task');
  });

  it('does not put a truncated worktree git dump in the chrome', () => {
    expect(
      humanizeDaemonError('worktree.create failed: worktree_create_failed: Preparing worktree ('),
    ).toBe('could not create a worktree — see the terminal');
  });
});
