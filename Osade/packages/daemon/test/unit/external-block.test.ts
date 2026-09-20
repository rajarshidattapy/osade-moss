import { describe, expect, it } from 'vitest';

import { classifyExternalBlock } from '../../src/domain/external-block.js';

describe('classifyExternalBlock', () => {
  it('names a quota reset when the agent reports one', () => {
    expect(classifyExternalBlock('Session limit reached. Resets Sunday 3pm.')).toBe(
      'Usage limit reached. Resets Sunday 3pm.',
    );
  });

  it('names an auth failure', () => {
    expect(classifyExternalBlock('Not logged in. Please run /login')).toBe(
      'The agent is not authenticated.',
    );
  });

  it('ignores a finished turn', () => {
    expect(classifyExternalBlock('PONG')).toBeNull();
  });
});
