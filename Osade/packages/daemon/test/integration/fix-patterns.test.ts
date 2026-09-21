import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { MigrationService } from '../../src/domain/migration.js';
import { ContextAssembler } from '../../src/retrieval/assembler.js';
import {
  FixPatterns,
  normaliseHunk,
  parseHunks,
  parseTsDiagnostics,
  patternHash,
} from '../../src/domain/fix-patterns.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * What a lane learns when verification settles — OSADE-MOSS §M.5.5, §M.5.8.
 *
 * The property that matters end to end is the last describe block: a verified fix in one lane
 * reaches a sibling's context pack. Everything above it defends the pieces that make that
 * trustworthy — the hash is a *pattern* rather than a fingerprint, and only a passing required
 * run produces one.
 */

const NOW = 1_756_000_000_000;

let dir: string;
let repo: string;
let db: Db;
let learner: FixPatterns;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function write(file: string, text: string): void {
  const full = join(repo, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function seed(): string {
  db.prepare('INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, NULL, ?, ?, ?)').run(
    'r1',
    repo,
    'main',
    NOW,
  );
  const base = sh(repo, ['rev-parse', 'HEAD']);
  for (const id of ['t1', 't2']) {
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, agent_id, created_at)
       VALUES (?, 'r1', 'migrate', 'migrate', 'api_migration', 'migration:m1', 'main', ?, ?, ?, 'claude', ?)`,
    ).run(id, base, `osade/${id}`, repo, NOW);
  }
  return base;
}

function addVerifyRun(
  id: string,
  taskId: string,
  exitCode: number,
  headSha: string,
  logPath = '/logs/x',
): void {
  db.prepare(
    `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                             required, head_sha, log_path)
     VALUES (?, ?, 'test', 'pnpm test', ?, ?, ?, 1, ?, ?)`,
  ).run(id, taskId, NOW, NOW + 10, exitCode, headSha, logPath);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osade-fp-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main', 'repo']);
  write('src/a.ts', 'export function go(q: string) {\n  return client.search(q);\n}\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  db = openDb(':memory:');
  learner = new FixPatterns(db, { now: () => NOW, onWarning: () => {} });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§M.5.5 — the hash is a pattern, not a fingerprint', () => {
  it('collapses the same change written with different variable names', () => {
    const a = '-  return client.search(q);\n+  return client.query(q, {});\n';
    const b = '-  return conn.search(term);\n+  return conn.query(term, {});\n';
    // Same shape, different locals. Five lanes applying this fix should dedupe to one line.
    expect(patternHash(a)).toBe(patternHash(b));
  });

  it('keeps genuinely different changes apart', () => {
    const rename = '-  return client.search(q);\n+  return client.query(q, {});\n';
    const removal = '-  return client.search(q);\n+  return null;\n';
    expect(patternHash(rename)).not.toBe(patternHash(removal));
  });

  it('does not rename the API surface being migrated', () => {
    // `.search` → `.query` is the whole point; α-renaming property names would collapse this
    // together with every other two-line method swap.
    const searchToQuery = normaliseHunk('-  a.search(x);\n+  a.query(x);\n');
    const fooToBar = normaliseHunk('-  a.foo(x);\n+  a.bar(x);\n');
    expect(searchToQuery).not.toBe(fooToBar);
  });

  it('ignores whitespace', () => {
    expect(patternHash('-  a.search(q);\n+  a.query(q);\n')).toBe(
      patternHash('-\ta.search( q );\n+\ta.query( q );\n'),
    );
  });
});

describe('unified diff parsing', () => {
  it('keys hunks by the new file and its line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' export function go(q: string) {',
      '-  return client.search(q);',
      '+  return client.query(q, {});',
      ' }',
    ].join('\n');

    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ file: 'src/a.ts', startLine: 1, endLine: 3 });
  });

  it('handles several files in one diff', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5,1 +5,1 @@',
      '-c',
      '+d',
    ].join('\n');
    expect(parseHunks(diff).map((h) => h.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('§M.5.8 — TypeScript diagnostics', () => {
  it('pulls file, line and message out of tsc output', () => {
    const log = [
      'src/lib/wrap.ts(12,18): error TS2554: Expected 2 arguments, but got 1.',
      'src/app/page.ts:7:3 - error TS2339: Property Q does not exist.',
      'some unrelated output',
    ].join('\n');

    const found = parseTsDiagnostics(log);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ file: 'src/lib/wrap.ts', line: 12 });
    expect(found[1]).toMatchObject({ file: 'src/app/page.ts', line: 7 });
    // The TS code is part of the recorded pattern: it names the failure class.
    expect(found[0]!.message).toBe('TS2554: Expected 2 arguments, but got 1.');
  });

  it('reports nothing for a log with no diagnostics', () => {
    expect(parseTsDiagnostics('all tests passed\n')).toEqual([]);
  });
});

describe('§M.5.5 — a passing required run publishes its fixes', () => {
  async function passWithFix(): Promise<string> {
    const base = seed();
    db.prepare(
      `INSERT INTO migration (id, provider, package, to_version, changelog_text, created_by, created_at)
       VALUES ('m1', 'npm', '@moss-js/moss', '2.0.0', 'x', 'test', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO migration_target (migration_id, repo_id, wave, arm, stratum, task_id)
       VALUES ('m1', 'r1', 0, 'digest_on', 's', 't1')`,
    ).run();
    db.prepare(
      `INSERT INTO migration_change (id, migration_id, kind, description, source, evidence)
       VALUES ('mc1', 'm1', 'rename', 'search to query', 'user', 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO call_site (id, migration_id, change_id, repo_id, file, line, via, found_by)
       VALUES ('cs1', 'm1', 'mc1', 'r1', 'src/a.ts', 2, 'direct', 'both')`,
    ).run();

    // The lane makes the fix at the known call site.
    write('src/a.ts', 'export function go(q: string) {\n  return client.query(q, {});\n}\n');
    addVerifyRun('vr1', 't1', 0, 'head1');
    await learner.learn({
      runId: 'vr1',
      taskId: 't1',
      exitCode: 0,
      required: true,
      headSha: 'head1',
      logPath: '/logs/vr1',
    });
    return base;
  }

  it('records a pattern for the hunk that touched a call site', async () => {
    await passWithFix();
    const rows = db.prepare('SELECT * FROM fix_pattern').all() as {
      task_id: string;
      file: string;
      line: number;
      pattern_hash: string;
      migration_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: 't1', file: 'src/a.ts', line: 2, migration_id: 'm1' });
    expect(rows[0]!.pattern_hash).toHaveLength(32);
  });

  it('is idempotent — re-running the learner adds nothing', async () => {
    await passWithFix();
    await learner.learn({
      runId: 'vr1',
      taskId: 't1',
      exitCode: 0,
      required: true,
      headSha: 'head1',
      logPath: '/logs/vr1',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fix_pattern').get()).toEqual({ n: 1 });
  });

  it('records nothing for a failing run', async () => {
    seed();
    write('src/a.ts', 'export function go(q: string) {\n  return client.query(q, {});\n}\n');
    addVerifyRun('vr1', 't1', 1, 'head1');
    await learner.learn({
      runId: 'vr1',
      taskId: 't1',
      exitCode: 1,
      required: true,
      headSha: 'head1',
      logPath: '/logs/vr1',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fix_pattern').get()).toEqual({ n: 0 });
  });

  it('records nothing for an optional step passing', async () => {
    seed();
    addVerifyRun('vr1', 't1', 0, 'head1');
    await learner.learn({
      runId: 'vr1',
      taskId: 't1',
      exitCode: 0,
      // An optional lint step going green is not evidence a migration worked.
      required: false,
      headSha: 'head1',
      logPath: '/logs/vr1',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fix_pattern').get()).toEqual({ n: 0 });
  });

  it('never throws, whatever the state', async () => {
    await expect(
      learner.learn({
        runId: 'nope',
        taskId: 'gone',
        exitCode: 0,
        required: true,
        headSha: 'x',
        logPath: '/does/not/exist',
      }),
    ).resolves.toBeUndefined();
  });
});

async function failWithDiagnostic(logPath: string): Promise<void> {
    seed();
    db.prepare(
      `INSERT INTO migration (id, provider, package, to_version, changelog_text, created_by, created_at)
       VALUES ('m1', 'npm', '@moss-js/moss', '2.0.0', 'x', 'test', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO migration_target (migration_id, repo_id, wave, arm, stratum, task_id)
       VALUES ('m1', 'r1', 0, 'digest_on', 's', 't1')`,
    ).run();
    db.prepare(
      `INSERT INTO migration_change (id, migration_id, kind, description, source, evidence)
       VALUES ('mc1', 'm1', 'rename', 'x', 'user', 'x')`,
    ).run();
    // Discovery proposed src/a.ts:2 and nothing else.
    db.prepare(
      `INSERT INTO call_site (id, migration_id, change_id, repo_id, file, line, via, found_by)
       VALUES ('cs1', 'm1', 'mc1', 'r1', 'src/a.ts', 2, 'direct', 'both')`,
    ).run();
    addVerifyRun('vr1', 't1', 2, 'head1', logPath);
  await learner.learn({
    runId: 'vr1',
    taskId: 't1',
    exitCode: 2,
    required: true,
    headSha: 'head1',
    logPath,
  });
}

describe('§M.5.8 — a failing run records what discovery missed', () => {

  it('records a diagnostic at a site discovery never proposed', async () => {
    const logPath = join(dir, 'fail.log');
    writeFileSync(
      logPath,
      'src/lib/wrap.ts(12,18): error TS2554: Expected 2 arguments, but got 1.\n',
    );
    await failWithDiagnostic(logPath);

    const rows = db.prepare('SELECT * FROM discovery_miss').all() as {
      file: string;
      line: number;
      pattern: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ file: 'src/lib/wrap.ts', line: 12 });
    expect(rows[0]!.pattern).toContain('Expected 2 arguments');
  });

  it('does not record a diagnostic at a site discovery did propose', async () => {
    const logPath = join(dir, 'fail.log');
    writeFileSync(logPath, 'src/a.ts(2,10): error TS2554: Expected 2 arguments, but got 1.\n');
    await failWithDiagnostic(logPath);
    expect(db.prepare('SELECT COUNT(*) AS n FROM discovery_miss').get()).toEqual({ n: 0 });
  });

  it('records nothing for a lane outside a migration', async () => {
    seed();
    const logPath = join(dir, 'fail.log');
    writeFileSync(logPath, 'src/x.ts(1,1): error TS1005: expected.\n');
    addVerifyRun('vr1', 't1', 1, 'head1', logPath);
    await learner.learn({
      runId: 'vr1',
      taskId: 't1',
      exitCode: 1,
      required: true,
      headSha: 'head1',
      logPath,
    });
    // Outside a migration there was no discovery to have missed anything, and every ordinary
    // compile error would otherwise be logged as a recall failure.
    expect(db.prepare('SELECT COUNT(*) AS n FROM discovery_miss').get()).toEqual({ n: 0 });
  });
});

describe('§M.2.2 — a verified fix reaches a sibling lane', () => {
  it('appears in the sibling digest section of the other lane\'s pack', async () => {
    seed();
    addVerifyRun('vr9', 't2', 0, 'sibhead');
    db.prepare(
      `INSERT INTO fix_pattern (id, task_id, repo_id, migration_id, verify_run_id, head_sha,
                                file, line, pattern_hash, hunk, created_at)
       VALUES ('fp1', 't2', 'r1', 'm1', 'vr9', 'sibhead', 'src/a.ts', 2, 'abc123',
               '-  return client.search(q);' || char(10) || '+  return client.query(q, {});', ?)`,
    ).run(NOW);

    const retrieval = await RetrievalService.open(db, {
      port: new Fts5Adapter(db),
      onWarning: () => {},
    });
    await retrieval.indexer.drain();

    const assembler = new ContextAssembler(db, retrieval, { now: () => NOW });
    const result = await assembler.build('t1', 'client search query rename');

    const sibling = result?.pack.items.find((item) => item.src_table === 'fix_pattern');
    expect(sibling, 'the verified fix should reach the sibling lane').toBeDefined();
    expect(result?.block).toContain('## What sibling lanes learned (verified)');
    expect(result?.block).toContain('client.query');
  });

  it('collapses two lanes reporting the same pattern into one cited line', async () => {
    seed();
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, agent_id, created_at)
       VALUES ('t3', 'r1', 'm', 'm', 'api_migration', 'migration:m1', 'main', 'base', 'osade/t3', ?, 'claude', ?)`,
    ).run(repo, NOW);

    for (const [id, task] of [
      ['fp1', 't2'],
      ['fp2', 't3'],
    ] as const) {
      addVerifyRun(`vr_${id}`, task, 0, 'sibhead');
      db.prepare(
        `INSERT INTO fix_pattern (id, task_id, repo_id, migration_id, verify_run_id, head_sha,
                                  file, line, pattern_hash, hunk, created_at)
         VALUES (?, ?, 'r1', 'm1', ?, 'sibhead', 'src/a.ts', 2, 'samehash',
                 'identical normalised change', ?)`,
      ).run(id, task, `vr_${id}`, NOW);
    }

    const retrieval = await RetrievalService.open(db, {
      port: new Fts5Adapter(db),
      onWarning: () => {},
    });
    await retrieval.indexer.drain();

    const assembler = new ContextAssembler(db, retrieval, { now: () => NOW });
    const result = await assembler.build('t1', 'identical normalised change');

    // §M.2.2 step 3 — same `pattern_hash`, one line. The budget is small; five lanes saying
    // the same thing five times is how it gets wasted.
    const fixes = result?.pack.items.filter((item) => item.src_table === 'fix_pattern') ?? [];
    expect(fixes).toHaveLength(1);
  });
});

describe('§M.5.8 — a miss becomes a regression fixture', () => {
  it('exports each miss as a file and records where it went', async () => {
    const logPath = join(dir, 'fail.log');
    writeFileSync(
      logPath,
      [
        'src/lib/wrap.ts(12,18): error TS2554: Expected 2 arguments, but got 1.',
        'src/app/page.ts(7,3): error TS2339: Property query does not exist.',
      ].join('\n'),
    );
    await failWithDiagnostic(logPath);

    const service = new MigrationService(db, { now: () => NOW, onWarning: () => {} });
    expect(service.misses('m1')).toHaveLength(2);

    const out = join(dir, 'fixtures');
    const written = await service.exportMisses('m1', out);

    expect(written).toHaveLength(2);
    for (const path of written) {
      const text = readFileSync(path, 'utf8');
      // The fixture has to carry the site *and* the diagnostic that revealed it — recall
      // improves from real failures, and a fixture without the failure is a guess.
      expect(text).toContain('Discovery miss');
      expect(text).toMatch(/- site: src\/(lib\/wrap|app\/page)\.ts:\d+/);
      expect(text).toMatch(/TS\d+:/);
    }

    // The path is recorded, so a second export does not silently orphan the first.
    const recorded = service.misses('m1').map((miss) => miss.fixture_path);
    expect(recorded.every((path) => path != null)).toBe(true);
  });

  it('writes nothing when discovery missed nothing', async () => {
    const service = new MigrationService(db, { now: () => NOW, onWarning: () => {} });
    expect(await service.exportMisses('m1', join(dir, 'empty'))).toEqual([]);
    // No directory is created for an empty export: an empty fixtures folder in a diff reads
    // as "someone deleted the fixtures".
    expect(existsSync(join(dir, 'empty'))).toBe(false);
  });
});
