import { describe, expect, it } from 'vitest';

import { highlight, parseUnified } from '../src/renderer/highlight.js';

describe('highlight', () => {
  it('colours keywords, strings, and comments in TypeScript', () => {
    const tokens = highlight(
      `const name = "osade";\n// wait\nfunction run() {}`,
      'src/app.ts',
    );
    const kinds = new Map<string, string>();
    for (const tok of tokens) {
      if (!kinds.has(tok.text) && tok.kind !== 'plain') kinds.set(tok.text, tok.kind);
    }
    expect(kinds.get('const')).toBe('kw');
    expect(kinds.get('function')).toBe('kw');
    expect(kinds.get('"osade"')).toBe('str');
    expect(kinds.get('// wait\n') ?? kinds.get('// wait')).toBe('com');
    expect(kinds.get('run')).toBe('fn');
  });
});

describe('parseUnified', () => {
  it('splits a working-tree diff into add/del/hunk lines', () => {
    const lines = parseUnified(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,2 +1,3 @@',
        ' keep',
        '-old',
        '+new',
        '+also',
      ].join('\n'),
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'ctx',
      'del',
      'add',
      'add',
    ]);
  });
});
