import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fileChanges,
  listDir,
  listWorkingChanges,
  parseNameStatus,
  parseNumstat,
  parsePorcelain,
  readFile,
  safeResolve,
  writeFile,
} from '../../src/domain/files.js';

describe('files path guard', () => {
  it('rejects .. and absolute paths', () => {
    const root = join(tmpdir(), 'osade-files-root');
    expect(() => safeResolve(root, '../secret')).toThrow(/escapes/);
  });
});

describe('git status parsing', () => {
  it('reads porcelain flags including untracked and renames', () => {
    const flags = parsePorcelain([' M src/a.ts', '?? new.md', 'R  old.ts -> src/b.ts', ''].join('\n'));
    expect(flags.get('src/a.ts')).toBe('M');
    expect(flags.get('new.md')).toBe('?');
    expect(flags.get('src/b.ts')).toBe('M');
  });

  it('reads numstat insertions and deletions', () => {
    const stats = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tpic.png\n');
    expect(stats.get('src/a.ts')).toEqual({ insertions: 12, deletions: 3 });
    expect(stats.get('pic.png')).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe('listDir overlay', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('marks a dirty file and its parent folder with the diffstat', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osade-files-'));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'user.email', 't@t']);
    sh(dir, ['config', 'user.name', 't']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'one\n');
    writeFileSync(join(dir, 'clean.ts'), 'ok\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-qm', 'init']);
    writeFileSync(join(dir, 'src/a.ts'), 'one\ntwo\n');
    writeFileSync(join(dir, 'src/new.ts'), 'fresh\n');

    const sha = sh(dir, ['rev-parse', 'HEAD']);
    const changes = await fileChanges(dir, sha);
    const root = listDir(dir, '', changes);
    const src = root.find((e) => e.name === 'src');
    expect(src?.kind).toBe('dir');
    expect(src?.flag).not.toBeNull();
    expect((src?.insertions ?? 0) + (src?.deletions ?? 0)).toBeGreaterThan(0);

    const nested = listDir(dir, 'src', changes);
    const edited = nested.find((e) => e.name === 'a.ts');
    const added = nested.find((e) => e.name === 'new.ts');
    expect(edited?.flag).toBe('M');
    expect(added?.flag).toBe('?');
    expect(listDir(dir, '', changes).find((e) => e.name === 'clean.ts')?.flag).toBeNull();

    const working = await listWorkingChanges(dir, sha);
    expect(working.files.some((f) => f.path === 'src/a.ts' && f.flag === 'M')).toBe(true);
    expect(working.files.some((f) => f.path === 'src/new.ts' && f.flag === '?')).toBe(true);
    expect(working.outgoing?.ahead ?? 0).toBe(0);
  });

  it('still lists files after they are committed, against the task base', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osade-files-'));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'user.email', 't@t']);
    sh(dir, ['config', 'user.name', 't']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'one\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-qm', 'init']);
    const base = sh(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'src/a.ts'), 'one\ntwo\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-qm', 'agent work']);

    const listed = await listWorkingChanges(dir, base);
    expect(listed.files.some((f) => f.path === 'src/a.ts')).toBe(true);
    expect(listed.outgoing?.ahead).toBe(1);
    expect(listed.outgoing?.commits[0]?.subject).toBe('agent work');
  });

  it('refuses to read outside cwd', () => {
    dir = mkdtempSync(join(tmpdir(), 'osade-files-'));
    writeFileSync(join(dir, 'ok.ts'), 'hi\n');
    expect(() => readFile(dir, '../nope.ts')).toThrow(/escapes/);
    expect(readFile(dir, 'ok.ts').text).toContain('hi');
  });

  it('writes a file inside cwd and refuses to escape', () => {
    dir = mkdtempSync(join(tmpdir(), 'osade-files-'));
    const saved = writeFile(dir, 'src/edit.ts', 'const n = 1;\n');
    expect(saved.path).toBe('src/edit.ts');
    expect(readFile(dir, 'src/edit.ts').text).toBe('const n = 1;\n');
    expect(() => writeFile(dir, '../escape.ts', 'nope')).toThrow(/escapes/);
  });
});

describe('outgoing name-status', () => {
  it('maps added and renamed paths', () => {
    const stats = parseNumstat('4\t0\tnew.ts\n1\t1\tsrc/b.ts\n');
    const files = parseNameStatus('A\tnew.ts\nR100\told.ts\tsrc/b.ts\n', stats);
    expect(files.find((f) => f.path === 'new.ts')?.flag).toBe('A');
    expect(files.find((f) => f.path === 'src/b.ts')?.flag).toBe('M');
  });
});

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
