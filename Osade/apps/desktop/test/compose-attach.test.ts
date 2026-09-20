import { describe, expect, it } from 'vitest';

import {
  checksAttach,
  fileAttach,
  hunkAttach,
  lineRangeFromOffsets,
  prependAttach,
  rulesAttach,
} from '../src/renderer/compose-attach.js';

describe('prependAttach', () => {
  it('puts the fence before the message so parseMentions sees it as shared preamble', () => {
    const attach = fileAttach('src/a.ts', 'x', null);
    expect(prependAttach('@claude fix this', attach)).toBe(`${attach.fence}\n\n@claude fix this`);
  });

  it('is a no-op without attach', () => {
    expect(prependAttach('hello', null)).toBe('hello');
  });
});

describe('lineRangeFromOffsets', () => {
  it('is null when there is no selection', () => {
    expect(lineRangeFromOffsets('a\nb', 1, 1)).toBeNull();
  });

  it('maps a selection onto 1-based line numbers', () => {
    expect(lineRangeFromOffsets('a\nb\nc', 0, 3)).toEqual({ from: 1, to: 2 });
  });
});

describe('fileAttach', () => {
  it('names the path when there is no selection', () => {
    const attach = fileAttach('src/foo.ts', 'hello\nworld', null);
    expect(attach.label).toBe('src/foo.ts');
    expect(attach.fence).toContain('src/foo.ts');
    expect(attach.fence).not.toContain('hello');
  });

  it('includes the selected lines', () => {
    const attach = fileAttach('src/foo.ts', 'hello\nworld\nbye', { from: 2, to: 3 });
    expect(attach.label).toBe('src/foo.ts L2–3');
    expect(attach.fence).toContain('world\nbye');
  });
});

describe('hunkAttach', () => {
  it('takes the hunk the cursor sits in', () => {
    const lines = [
      { kind: 'meta', text: 'diff --git a/a b/a' },
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: ' one' },
      { kind: 'hunk', text: '@@ -10,1 +10,1 @@' },
      { kind: 'add', text: '+two' },
    ];
    const attach = hunkAttach('a.ts', lines, 4);
    expect(attach?.fence).toContain('@@ -10,1 +10,1 @@');
    expect(attach?.fence).not.toContain(' one');
  });
});

describe('checksAttach / rulesAttach', () => {
  it('names the step and includes the log tail', () => {
    expect(checksAttach('lint', 'error at 3').fence).toContain('lint');
    expect(checksAttach('lint', 'error at 3').fence).toContain('error at 3');
  });

  it('cites the rule id and text', () => {
    const attach = rulesAttach('c_1', 'Prefer early return.');
    expect(attach.label).toBe('c_1');
    expect(attach.fence).toContain('Prefer early return.');
  });
});
