import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { cites, MigrationService, MAX_LIVE_LANES } from '../../src/domain/migration.js';
import type { ModelPort } from '../../src/knowledge/model.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * F1 end to end, against real git repositories — OSADE-MOSS §M.5.
 *
 * §M.5.10 criterion 1 is the target of the discovery tests: a repo seeded with **an aliased
 * import and a two-level wrapper**, where discovery finds every seeded site and the UI shows at
 * least two hits grep missed. The repos here are tiny but structurally exact — the shapes are
 * the point, not the size.
 *
 * Criterion 3 ("the canary reaches a passing verify run without human edits") needs a real
 * agent and is not testable here; what is testable is that the wave gate *refuses to open*
 * until a canary is green, and that is asserted below.
 */

const NOW = 1_756_000_000_000;

let dir: string;
let db: Db;
let service: MigrationService;
let retrieval: RetrievalService;

const PKG = '@moss-js/moss';

const CHANGELOG = [
  '# moss-sdk v2',
  '',
  '## Breaking changes',
  '- `search()` has been renamed to `query()`.',
  '- The options argument to `query()` is now required.',
  '- `Index.delete` has been removed; use `deleteDocs` instead.',
].join('\n');

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** A repo seeded with the two shapes grep cannot see. */
function seedRepo(name: string, files: Record<string, string>): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main', name]);
  for (const [file, text] of Object.entries(files)) {
    const full = join(path, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  sh(path, ['add', '-A']);
  sh(path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return path;
}

function registerRepo(id: string, path: string): void {
  db.prepare(
    'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, NULL, ?, ?, ?)',
  ).run(id, path, 'main', NOW);
}

/** A model that returns exactly what the test tells it to. */
function fakeModel(response: string): ModelPort {
  return { complete: async () => response };
}

const ALIASED_AND_WRAPPED: Record<string, string> = {
  // Direct, grep-visible.
  'src/direct.ts': [
    `import { search } from "${PKG}";`,
    'export function plain(q: string) { return search(q); }',
  ].join('\n'),
  // Aliased namespace import: `search` appears only as a member of `m`.
  //
  // The wrapper is named for the domain (`lookupDocs`), not for the SDK method. That is both
  // more realistic and the honest test: a wrapper called `searchDocs` still contains the
  // substring `search`, so `git grep search` finds it by accident and the comparison would
  // flatter retrieval for the wrong reason.
  'src/lib/moss.ts': [
    `import * as m from "${PKG}";`,
    'export function lookupDocs(q: string) {',
    '  return m.search(q);',
    '}',
  ].join('\n'),
  // One level out — mentions neither the package nor `search`.
  'src/lib/wrap.ts': [
    'import { lookupDocs } from "./moss";',
    'export function findAll(q: string) { return lookupDocs(q); }',
  ].join('\n'),
  // Two levels out — the site grep cannot reach at all.
  'src/app/page.ts': [
    'import { findAll } from "../lib/wrap";',
    'export function render(q: string) { return findAll(q); }',
  ].join('\n'),
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'osade-f1-'));
  db = openDb(':memory:');
  retrieval = await RetrievalService.open(db, { port: new Fts5Adapter(db), onWarning: () => {} });
  service = new MigrationService(db, { now: () => NOW, retrieval, onWarning: () => {} });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newMigration(): string {
  return service.create({
    provider: 'npm',
    package: PKG,
    fromVersion: '1.x',
    toVersion: '2.0.0',
    changelogText: CHANGELOG,
    createdBy: 'test',
  });
}

describe('§M.5.3 — the model may only cite its own input', () => {
  it('keeps changes whose evidence is in the changelog', async () => {
    const id = newMigration();
    const withModel = new MigrationService(db, {
      now: () => NOW,
      model: fakeModel(
        JSON.stringify({
          changes: [
            {
              kind: 'rename',
              old_symbol: 'search',
              new_symbol: 'query',
              description: 'search was renamed to query',
              evidence: '- `search()` has been renamed to `query()`.',
            },
          ],
        }),
      ),
    });

    const result = await withModel.extractChanges(id);
    expect(result).toEqual({ kept: 1, dropped: 0 });
    expect(withModel.changes(id)[0]).toMatchObject({ old_symbol: 'search', source: 'changelog' });
  });

  it('drops a change whose evidence was invented', async () => {
    const id = newMigration();
    const warnings: string[] = [];
    const withModel = new MigrationService(db, {
      now: () => NOW,
      onWarning: (m) => warnings.push(m),
      model: fakeModel(
        JSON.stringify({
          changes: [
            {
              kind: 'removal',
              old_symbol: 'connect',
              new_symbol: null,
              description: 'connect was removed',
              // Plausible, and nowhere in the changelog. This is the failure mode that
              // matters: a migration driven by a line the model made up looks sourced.
              evidence: '- `connect()` has been removed in v2.',
            },
          ],
        }),
      ),
    });

    const result = await withModel.extractChanges(id);
    expect(result).toEqual({ kept: 0, dropped: 1 });
    expect(withModel.changes(id)).toEqual([]);
    expect(warnings.join('\n')).toContain('did not quote the changelog');
  });

  it('cites() is whitespace-insensitive but not meaning-insensitive', () => {
    expect(cites('- `search()` has been renamed to `query()`.', '- `search()`  has been\n  renamed to `query()`.')).toBe(true);
    expect(cites(CHANGELOG, '- `connect()` has been removed.')).toBe(false);
    // Too short to be evidence of anything.
    expect(cites(CHANGELOG, 'the')).toBe(false);
  });
});

describe('§M.5.3 — nothing downstream runs before confirmation', () => {
  it('refuses targets, chunking, discovery and launch', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));

    await expect(service.setTargets(id, ['r1'])).rejects.toThrow(/unconfirmed/);
    await expect(service.chunkTargets(id)).rejects.toThrow(/unconfirmed/);
    await expect(service.discover(id)).rejects.toThrow(/unconfirmed/);
    await expect(service.launchWave(id, 0)).rejects.toThrow(/unconfirmed/);
  });

  it('records who confirmed, not just that someone did', () => {
    const id = newMigration();
    service.addChange(id, {
      kind: 'rename',
      old_symbol: 'search',
      new_symbol: 'query',
      description: 'renamed',
    });
    service.confirmChanges(id, 'github:priya');

    const view = service.view(id)!;
    expect(view.changes_confirmed_by).toBe('github:priya');
    expect(view.changes_confirmed_at).toBe(NOW);
  });

  it('will not confirm a migration with no changes at all', () => {
    const id = newMigration();
    expect(() => service.confirmChanges(id, 'test')).toThrow(/no changes/);
  });
});

describe('§M.5.10 criterion 1 — discovery finds what grep cannot', () => {
  async function discoverSeeded(): Promise<{ id: string }> {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, {
      kind: 'rename',
      old_symbol: 'search',
      new_symbol: 'query',
      description: 'search was renamed to query',
    });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);
    await service.chunkTargets(id);
    await retrieval.indexer.drain();
    await service.discover(id);
    return { id };
  }

  it('finds every seeded site, including the two grep misses', async () => {
    const { id } = await discoverSeeded();
    const sites = db
      .prepare('SELECT file, line, via, found_by FROM call_site WHERE migration_id = ? ORDER BY file')
      .all(id) as { file: string; line: number; via: string; found_by: string }[];

    const files = new Set(sites.map((s) => s.file));
    // All four seeded call sites are present.
    expect(files).toContain('src/direct.ts');
    expect(files).toContain('src/lib/moss.ts');
    expect(files).toContain('src/lib/wrap.ts');
    expect(files).toContain('src/app/page.ts');
  });

  it('shows at least two retrieval-only hits in the comparison', async () => {
    const { id } = await discoverSeeded();
    const view = service.view(id)!;
    const comparison = view.discovery[0]!;

    // The wrapper files contain neither the package name nor the symbol, so grep cannot see
    // them. This is the number the demo puts on screen (§M.11.2).
    expect(comparison.moss_only).toBeGreaterThanOrEqual(2);
    expect(comparison.chunks).toBeGreaterThan(0);
  });

  it('records grep-only hits too — retrieval\'s misses are not hidden', async () => {
    const id = newMigration();
    // A `search` in a comment: grep sees it, the parser correctly does not treat it as a call.
    registerRepo(
      'r1',
      seedRepo('b', {
        'src/note.ts': ['// TODO: the old search helper lived here', 'export const x = 1;'].join('\n'),
      }),
    );
    service.addChange(id, {
      kind: 'rename',
      old_symbol: 'search',
      new_symbol: 'query',
      description: 'renamed',
    });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);
    await service.chunkTargets(id);
    await retrieval.indexer.drain();
    await service.discover(id);

    const view = service.view(id)!;
    expect(view.discovery[0]!.grep_only).toBeGreaterThanOrEqual(1);
  });

  it('records what discovery cost, so the comparison survives a restart', async () => {
    const { id } = await discoverSeeded();
    const comparison = service.view(id)!.discovery[0]!;
    // §M.5.5 — retrieval latency per repo is on screen in the demo, so it is a stored fact
    // rather than something recomputed from a timer that is no longer running.
    expect(comparison.query_ms).toBeGreaterThan(0);
    expect(comparison.unparsed).toBe(0);
  });

  it('leaves every candidate unconfirmed — discovery is never an answer', async () => {
    const { id } = await discoverSeeded();
    const rows = db
      .prepare('SELECT confirmed, confirmed_by FROM call_site WHERE migration_id = ?')
      .all(id) as { confirmed: number | null; confirmed_by: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.confirmed).toBeNull();
      expect(row.confirmed_by).toBeNull();
    }
  });

  it('is idempotent — re-running discovery does not duplicate sites', async () => {
    const { id } = await discoverSeeded();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM call_site').get() as { n: number }).n;
    await service.discover(id);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM call_site').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('§M.5.4 — chunks reach the code namespace through the indexer (R1)', () => {
  it('writes chunk rows, and the indexer projects them', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);

    const { chunks } = await service.chunkTargets(id);
    expect(chunks).toBeGreaterThan(0);

    await retrieval.indexer.drain();
    const hits = await retrieval.query('code', 'search via alias', {
      topK: 20,
      filter: [{ field: 'migration_id', condition: { $eq: id } }],
    });
    expect(hits.length).toBeGreaterThan(0);
    // R2 — every indexed chunk is traceable back to its row.
    for (const hit of hits) expect(hit.meta.src_table).toBe('code_chunk');
  });

  it('re-chunking replaces rather than accumulates', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);

    const first = await service.chunkTargets(id);
    const second = await service.chunkTargets(id);
    expect(second.chunks).toBe(first.chunks);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM code_chunk').get() as { n: number }).n;
    expect(rows).toBe(first.chunks);
  });
});

describe('§M.5.7 — strata and arms', () => {
  it('assigns an arm to every target and alternates within a stratum', async () => {
    const id = newMigration();
    for (const n of [1, 2, 3, 4]) {
      registerRepo(`r${n}`, seedRepo(`repo${n}`, ALIASED_AND_WRAPPED));
    }
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1', 'r2', 'r3', 'r4']);

    const targets = service.targets(id);
    expect(targets).toHaveLength(4);
    for (const target of targets) {
      expect(['digest_on', 'digest_off']).toContain(target.arm);
      expect(target.stratum).toMatch(/^sites:.*\|loc:/);
    }
    // Identical repos land in one stratum, so alternation balances the arms exactly.
    const on = targets.filter((t) => t.arm === 'digest_on').length;
    expect(on).toBe(2);
  });

  it('the arm is fixed at assignment, and the assembler reads it', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);

    const before = service.targets(id)[0]!.arm;
    await service.setTargets(id, ['r1']);
    expect(service.targets(id)[0]!.arm).toBe(before);
  });

  it('puts one repo per stratum into wave 0', async () => {
    const id = newMigration();
    for (const n of [1, 2, 3, 4]) registerRepo(`r${n}`, seedRepo(`repo${n}`, ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1', 'r2', 'r3', 'r4']);

    const canaries = service.targets(id).filter((t) => t.wave === 0);
    expect(canaries.length).toBeGreaterThanOrEqual(1);
    expect(canaries.length).toBeLessThanOrEqual(3);
  });
});

describe('§M.5.6 — waves are gated on evidence, not a timer', () => {
  it('refuses wave 1 until a canary is green', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);

    expect(service.canaryGreen(id)).toBe(false);
    await expect(service.launchWave(id, 1)).rejects.toThrow(/gated/);
  });

  it('opens wave 1 once a wave-0 lane has a passing required run', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);

    // Stand in for a launched canary that went green.
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, created_at)
       VALUES ('t_canary', 'r1', 'x', 'x', 'api_migration', ?, 'main', 'base', 'osade/x', '/wt', ?)`,
    ).run(`migration:${id}`, NOW);
    db.prepare('UPDATE migration_target SET task_id = ? WHERE migration_id = ?').run('t_canary', id);
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr', 't_canary', 'test', 'pnpm test', ?, ?, 0, 1, 'head', '/logs/vr')`,
    ).run(NOW, NOW + 5);

    expect(service.canaryGreen(id)).toBe(true);
  });

  it('a failing canary does not open the gate', async () => {
    const id = newMigration();
    registerRepo('r1', seedRepo('a', ALIASED_AND_WRAPPED));
    service.addChange(id, { kind: 'rename', old_symbol: 'search', new_symbol: 'query', description: 'x' });
    service.confirmChanges(id, 'test');
    await service.setTargets(id, ['r1']);

    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, created_at)
       VALUES ('t_canary', 'r1', 'x', 'x', 'api_migration', ?, 'main', 'base', 'osade/x', '/wt', ?)`,
    ).run(`migration:${id}`, NOW);
    db.prepare('UPDATE migration_target SET task_id = ? WHERE migration_id = ?').run('t_canary', id);
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr', 't_canary', 'test', 'pnpm test', ?, ?, 1, 1, 'head', '/logs/vr')`,
    ).run(NOW, NOW + 5);

    expect(service.canaryGreen(id)).toBe(false);
  });

  it('reports the live-lane cap rather than hiding a queue', () => {
    const view = service.view(newMigration());
    expect(view?.maxLiveLanes).toBe(MAX_LIVE_LANES);
  });
});

describe('§M.5 — the view', () => {
  it('is null for an unknown migration rather than throwing', () => {
    expect(service.view('mig_nope')).toBeNull();
  });

  it('marks an unconfirmed migration as such', () => {
    const id = newMigration();
    const view = service.view(id)!;
    expect(view.changes_confirmed_at).toBeNull();
    expect(view.package).toBe(PKG);
  });
});
