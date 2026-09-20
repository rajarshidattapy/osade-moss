import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { FakeRetrieval } from '../../src/retrieval/fake.js';
import { Indexer } from '../../src/retrieval/indexer.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * OSADE-MOSS §M.1 — the retrieval layer end to end, on the backend that always exists.
 *
 * Every test here runs without a Moss key, a network or a native addon. That is deliberate and
 * is the same discipline as `ModelPort` (ARCH §13.2): a layer whose tests need credentials is a
 * layer that stops being tested.
 */

const NOW = 1_756_000_000_000;

let db: Db;

function seed(): void {
  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?, ?, ?)').run('o1', 'acme', NOW);
  db.prepare(
    'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('r1', 'o1', '/repo', 'main', NOW);
  for (const id of ['t1', 't2']) {
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, agent_id, created_at)
       VALUES (?, 'r1', 'migrate', 'migrate the sdk', 'manual', 'chat1', 'main', 'base000',
               ?, '/wt', 'claude', ?)`,
    ).run(id, `osade/${id}`, NOW);
  }
}

function addTurn(taskId: string, seq: number, text: string, role = 'user'): string {
  const id = `ct_${taskId}_${seq}`;
  db.prepare(
    `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
     VALUES (?, ?, ?, ?, 'human', ?, 'accepted', ?)`,
  ).run(id, taskId, seq, role, text, NOW + seq);
  return id;
}

function addConvention(id: string, rule: string): void {
  db.prepare(
    `INSERT INTO convention (id, repo_id, category, rule_text, confidence, lifecycle, mined_at)
     VALUES (?, 'r1', 'commit_style', ?, 0.9, 'active', ?)`,
  ).run(id, rule, NOW);
  db.prepare(
    `INSERT INTO convention_evidence (id, convention_id, kind, url, observed_at)
     VALUES (?, ?, 'merged_pr', ?, ?)`,
  ).run(`ev_${id}`, id, `https://github.com/acme/web/pull/88`, NOW);
}

beforeEach(() => {
  db = openDb(':memory:');
  seed();
});

afterEach(() => {
  db.close();
});

describe('§M.1.4 — the retrieval log and its cursor', () => {
  it('records a row per source-table mutation, keyed by the row, not the task', () => {
    addTurn('t1', 1, 'rename search to query');
    const rows = db
      .prepare("SELECT table_name, row_id, op FROM retrieval_log WHERE table_name = 'chat_turn'")
      .all() as { table_name: string; row_id: string; op: string }[];
    expect(rows).toEqual([{ table_name: 'chat_turn', row_id: 'ct_t1_1', op: 'insert' }]);
  });

  it('keeps 1 Hz agent activity out of the log — §M.1.4', () => {
    db.prepare(
      `INSERT INTO agent_fact (task_id, last_event, substrate_state, activity_text)
       VALUES ('t1', 'activity', 'working', 'reading files')`,
    ).run();
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM retrieval_log WHERE table_name = 'agent_fact'")
      .get() as { n: number };
    expect(after.n).toBe(0);

    db.prepare("UPDATE agent_fact SET last_event = 'to_review' WHERE task_id = 't1'").run();
    const transition = db
      .prepare("SELECT COUNT(*) AS n FROM retrieval_log WHERE table_name = 'agent_fact'")
      .get() as { n: number };
    expect(transition.n).toBe(1);
  });

  it('advances the cursor and prunes what it consumed', async () => {
    addTurn('t1', 1, 'first');
    addTurn('t1', 2, 'second');
    const indexer = new Indexer(db, new FakeRetrieval());
    await indexer.drain();

    expect(indexer.lag()).toBe(0);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM retrieval_log').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('collapses repeated edits of one row into a single projection', async () => {
    const id = addTurn('t1', 1, 'first');
    for (const text of ['second', 'third', 'fourth']) {
      db.prepare('UPDATE chat_turn SET text = ? WHERE id = ?').run(text, id);
    }
    const port = new FakeRetrieval();
    await new Indexer(db, port).drain();

    const upserts = port.calls.filter((c) => c.op === 'upsert');
    expect(upserts).toHaveLength(1);
    const hits = await port.query('turns', 'fourth', { topK: 5 });
    expect(hits[0]?.text).toBe('fourth');
  });

  it('is idempotent: replaying a batch produces no duplicates (§M.1.4)', async () => {
    addTurn('t1', 1, 'rename search to query');
    const port = new FakeRetrieval();

    // Simulate the crash window: the backend was written but the cursor never advanced.
    await new Indexer(db, port).drain();
    db.prepare("UPDATE retrieval_cursor SET last_seq = 0 WHERE consumer = 'indexer'").run();
    db.prepare(
      `INSERT INTO retrieval_log (table_name, row_id, op, at) VALUES ('chat_turn', 'ct_t1_1', 'insert', ?)`,
    ).run(NOW);
    await new Indexer(db, port).drain();

    expect(port.ids('turns')).toEqual(['turns:chat_turn:ct_t1_1']);
  });

  it('removes a document when its source row is deleted', async () => {
    const id = addTurn('t1', 1, 'temporary');
    const port = new FakeRetrieval();
    const indexer = new Indexer(db, port);
    await indexer.drain();
    expect(port.ids('turns')).toHaveLength(1);

    db.prepare('DELETE FROM chat_turn WHERE id = ?').run(id);
    await indexer.drain();
    expect(port.ids('turns')).toEqual([]);
  });

  it('removes a document when the projector stops accepting the row', async () => {
    // A convention retired after being indexed must leave the index: §13 does not inject
    // retired rules, and the index is what §M.2 injects from.
    addConvention('cv_1', 'Imports go through src/lib/moss.ts.');
    const port = new FakeRetrieval();
    const indexer = new Indexer(db, port);
    await indexer.drain();
    expect(port.ids('conventions')).toEqual(['conventions:convention:cv_1']);

    db.prepare("UPDATE convention SET lifecycle = 'retired' WHERE id = 'cv_1'").run();
    await indexer.drain();
    expect(port.ids('conventions')).toEqual([]);
  });

  it('re-projects a convention when its evidence changes, not the evidence itself', async () => {
    addConvention('cv_1', 'Imports go through src/lib/moss.ts.');
    const port = new FakeRetrieval();
    await new Indexer(db, port).drain();
    // Evidence is not a document; the convention that cites it is.
    expect(port.ids()).toEqual(['conventions:convention:cv_1']);
  });
});

describe('§M.1.4 — rebuild (R1: the index is derived and disposable)', () => {
  it('drops and re-projects to an identical id set', async () => {
    addTurn('t1', 1, 'rename search to query');
    addTurn('t1', 2, 'the wrapper signature stays stable', 'agent');
    addTurn('t2', 1, 'sibling lane work');
    addConvention('cv_1', 'Imports go through src/lib/moss.ts.');
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr_1', 't1', 'test', 'pnpm test', ?, ?, 0, 1, 'head111', '/logs/vr_1')`,
    ).run(NOW, NOW + 10);

    const port = new FakeRetrieval();
    const indexer = new Indexer(db, port);
    await indexer.drain();
    const incremental = port.ids();
    expect(incremental.length).toBeGreaterThan(0);

    await indexer.rebuild();
    expect(port.ids()).toEqual(incremental);
  });

  it('a rebuild after losing the whole index restores it', async () => {
    addTurn('t1', 1, 'rename search to query');
    addConvention('cv_1', 'Imports go through src/lib/moss.ts.');

    const port = new FakeRetrieval();
    const indexer = new Indexer(db, port);
    await indexer.drain();
    const before = port.ids();

    // §M.1.3 — "the cache is disposable". Deleting it is never an error.
    await port.drop('turns');
    await port.drop('conventions');
    expect(port.ids()).toEqual([]);

    await indexer.rebuild();
    expect(port.ids()).toEqual(before);
  });
});

describe('§M.1.2 — the FTS5 adapter is a real backend, not a stub', () => {
  it('finds a document by keyword and returns its provenance', async () => {
    addTurn('t1', 1, 'Rename the search method to query across the wrapper.');
    const port = new Fts5Adapter(db);
    await new Indexer(db, port).drain();

    const hits = await port.query('turns', 'rename search method', { topK: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.meta.src_table).toBe('chat_turn');
    expect(hits[0]?.meta.src_id).toBe('ct_t1_1');
    expect(hits[0]?.meta.url).toBe('osade://task/t1/turn/1');
  });

  it('applies metadata filters', async () => {
    addTurn('t1', 1, 'shared wording about the sdk migration');
    addTurn('t2', 1, 'shared wording about the sdk migration');
    const port = new Fts5Adapter(db);
    await new Indexer(db, port).drain();

    const all = await port.query('turns', 'sdk migration', { topK: 10 });
    expect(all).toHaveLength(2);

    const scoped = await port.query('turns', 'sdk migration', {
      topK: 10,
      filter: [{ field: 'task_id', condition: { $eq: 't2' } }],
    });
    expect(scoped.map((h) => h.meta.src_id)).toEqual(['ct_t2_1']);
  });

  it('is not confused by FTS5 operators in the query text', async () => {
    addTurn('t1', 1, 'the wrapper signature stays stable');
    const port = new Fts5Adapter(db);
    await new Indexer(db, port).drain();

    // A user turn routinely contains quotes and stars; an unquoted query would be a syntax error.
    const hits = await port.query('turns', 'wrapper "AND" * signature', { topK: 5 });
    expect(hits).toHaveLength(1);
  });

  it('separates namespaces', async () => {
    addTurn('t1', 1, 'imports go through the lib module');
    addConvention('cv_1', 'imports go through the lib module');
    const port = new Fts5Adapter(db);
    await new Indexer(db, port).drain();

    expect(await port.query('turns', 'imports lib', { topK: 5 })).toHaveLength(1);
    expect(await port.query('conventions', 'imports lib', { topK: 5 })).toHaveLength(1);
    expect(await port.query('policies', 'imports lib', { topK: 5 })).toHaveLength(0);
  });
});

describe('§M.1.4 R3 — retrieval never fails an operation', () => {
  it('a throwing backend degrades the result, not the caller', async () => {
    addTurn('t1', 1, 'rename search to query');
    const port = new FakeRetrieval();
    const service = await RetrievalService.open(db, { port, onWarning: () => {} });
    await service.indexer.drain();

    port.failNextQuery = new Error('moss exploded');
    const hits = await service.query('turns', 'rename search', { topK: 5 });

    // The call returned. That is the invariant.
    expect(Array.isArray(hits)).toBe(true);
    const stats = await service.stats();
    expect(stats.backend).toBe('fts5');
    expect(stats.degradedReason).toContain('moss exploded');
  });

  it('with no credentials it boots on FTS5 and says why — §M.10 row 1', async () => {
    const service = await RetrievalService.open(db, { env: {}, onWarning: () => {} });
    const stats = await service.stats();
    expect(stats.backend).toBe('fts5');
    expect(stats.mossConfigured).toBe(false);
    expect(stats.degradedReason).toContain('no Moss credentials');
  });

  it('a query over the timeout budget still returns', async () => {
    const slow = {
      backend: 'moss' as const,
      upsert: async () => {},
      remove: async () => {},
      drop: async () => {},
      counts: async () => [],
      close: async () => {},
      query: () => new Promise<never>(() => {}), // never settles
    };
    const service = await RetrievalService.open(db, {
      port: slow,
      config: { enabled: true, cloudSync: false, budgetTokens: 1_200, queryTimeoutMs: 5 },
      onWarning: () => {},
    });

    const hits = await service.query('turns', 'anything', { topK: 5 });
    expect(hits).toEqual([]);
    expect((await service.stats()).degradedReason).toContain('exceeded');
  });
});

describe('§M.1.7 — latency instrumentation', () => {
  it('records per-namespace samples without writing a row per query', async () => {
    addTurn('t1', 1, 'rename search to query');
    const service = await RetrievalService.open(db, { port: new FakeRetrieval(), onWarning: () => {} });
    await service.indexer.drain();

    for (let i = 0; i < 3; i += 1) await service.query('turns', 'rename', { topK: 5 });

    const stats = await service.stats();
    const turns = stats.namespaces.find((n) => n.ns === 'turns');
    expect(turns?.queries).toBe(3);
    expect(turns?.p50Ms).not.toBeNull();
    expect(turns?.docs).toBe(1);
  });
});
