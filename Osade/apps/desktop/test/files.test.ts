import { describe, expect, it } from 'vitest';

import { fuzzyPath } from '../src/renderer/files-search.js';

describe('fuzzyPath', () => {
  it('matches a substring or a subsequence', () => {
    expect(fuzzyPath('router', 'packages/daemon/src/server/router.ts')).toBe(true);
    expect(fuzzyPath('pdsr', 'packages/daemon/src/server/router.ts')).toBe(true);
    expect(fuzzyPath('zzz', 'packages/daemon/src/server/router.ts')).toBe(false);
  });

  it('is empty-query match-all', () => {
    expect(fuzzyPath('', 'anything')).toBe(true);
    expect(fuzzyPath('  ', 'anything')).toBe(true);
  });
});
