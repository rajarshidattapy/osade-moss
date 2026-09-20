import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureRepoRules, readRepoRules, repoRulesPath, writeRepoRules } from '../../src/knowledge/repo-rules.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('repo rules.md', () => {
  it('creates an empty .osade/rules.md once and leaves existing text alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'osade-rules-'));
    const first = ensureRepoRules(dir);
    expect(first).toBe(repoRulesPath(dir));
    expect(readFileSync(first, 'utf8')).toBe('');
    writeFileSync(first, 'keep PRs small\n', 'utf8');
    ensureRepoRules(dir);
    expect(readRepoRules(dir)).toBe('keep PRs small\n');
  });

  it('writes pasted text', () => {
    dir = mkdtempSync(join(tmpdir(), 'osade-rules-'));
    mkdirSync(dir, { recursive: true });
    writeRepoRules(dir, '- no drive-by refactors\n');
    expect(readRepoRules(dir)).toBe('- no drive-by refactors\n');
  });
});
