import { describe, expect, it } from 'vitest';

import { paneDelta } from '../../src/domain/pane-delta.js';

describe('paneDelta', () => {
  it('keeps the new suffix after the captured surface and strips the user echo', () => {
    const before = 'banner\n❯ ';
    const after = 'banner\n❯ write tests\nI will add coverage for auth.\n❯ ';
    expect(paneDelta(before, after, 'write tests', ['^❯'])).toBe('I will add coverage for auth.');
  });

  it('keeps new output when the pane window slid and the prompt footer is unchanged', () => {
    const footer = `${'keep\n'.repeat(20)}❯ `;
    const before = `banner\n${footer}`;
    const after = `${footer}The files are README.md\npackage.json\n❯ `;
    expect(paneDelta(before, after, '', ['^❯'])).toContain('The files are README.md');
  });

  it('strips a working footer', () => {
    const surface =
      'banner\nwrite tests\nI will add coverage for auth.\n• Working (esc to interrupt)\ngpt-5 default · /work';
    const text = paneDelta('', surface, 'write tests', ['esc to interrupt', 'gpt-\\d', '^•']);
    expect(text).toContain('I will add coverage for auth');
    expect(text).not.toMatch(/Working \(esc to interrupt\)/);
  });
});
