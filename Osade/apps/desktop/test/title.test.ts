import { describe, expect, it } from 'vitest';

import { branchSlugFromTitle, titleFrom } from '../src/renderer/title.js';

describe('titleFrom', () => {
  it('does not title a greeting or a short first message', () => {
    expect(titleFrom('hi')).toBe('New chat');
    expect(titleFrom('hello')).toBe('New chat');
    expect(titleFrom('fix it')).toBe('New chat');
  });

  it('titles from a real sentence', () => {
    expect(titleFrom('retry the flaky poller test')).toBe('Retry the flaky poller test');
  });
});

describe('branchSlugFromTitle', () => {
  it('uses the short task id when the title is still New chat', () => {
    expect(branchSlugFromTitle('New chat', 't_ab12cd34')).toBe('ab12cd34');
  });
});
