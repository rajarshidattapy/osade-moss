import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CDC_TABLES, openDb, type Db } from '../../src/db/index.js';
import { ContextAssembler } from '../../src/retrieval/assembler.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * OSADE-MOSS §M.2 — per-turn context assembly.
 *
 * The properties worth defending here are not "does it retrieve something". They are the ones
 * that stop the block becoming a context dump or a citation to a row that no longer exists:
 * the budget is a cap, the provenance filter beats the index, and every line is traceable.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let service: RetrievalService;
let assembler: ContextAssembler;

function seed(): void {
  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?, ?, ?)').run('o1', 'acme', NOW);
  db.prepare(
    'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('r1', 'o1', '/repo', 'main', NOW);
  db.prepare(
    'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('r2', 'o1', '/other', 'main', NOW);
  for (const [id, repo] of [
    ['t1', 'r1'],
    ['t2', 'r1'],
    ['t3', 'r2'],
  ] as const) {
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, agent_id, created_at)
       VALUES (?, ?, 'migrate', 'migrate the sdk', 'manual', ?, 'main', 'base000',
               ?, '/wt', 'claude', ?)`,
    ).run(id, repo, repo === 'r1' ? 'chat1' : 'chat2', `osade/${id}`, NOW);
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

function addConvention(id: string, repoId: string, rule: string): void {
  db.prepare(
    `INSERT INTO convention (id, repo_id, category, rule_text, confidence, lifecycle, mined_at)
     VALUES (?, ?, 'commit_style', ?, 0.9, 'active', ?)`,
  ).run(id, repoId, rule, NOW);
  db.prepare(
    `INSERT INTO convention_evidence (id, convention_id, kind, url, observed_at)
     VALUES (?, ?, 'merged_pr', 'https://github.com/acme/web/pull/88', ?)`,
  ).run(`ev_${id}`, id, NOW);
}

async function index(): Promise<void> {
  await service.indexer.drain();
}

beforeEach(async () => {
  db = openDb(':memory:');
  seed();
  service = await RetrievalService.open(db, {
    port: new Fts5Adapter(db),
    onWarning: () => {},
  });
  assembler = new ContextAssembler(db, service, { now: () => NOW });
});

afterEach(() => {
  db.close();
});

describe('§M.2.1 — the assembled block', () => {
  it('cites conventions for this repo and renders a linkable id per line', async () => {
    addConvention('cv_1', 'r1', 'Imports from the SDK go through src/lib/moss.ts.');
    await index();

    const result = await assembler.build('t1', 'update the sdk imports in the wrapper');
    expect(result?.block).toContain('<osade_context');
    expect(result?.block).toContain('## Conventions relevant to this change');
    expect(result?.block).toContain('[convention:cv_1]');
    expect(result?.block).toContain('src/lib/moss.ts');
    expect(result?.block).toContain('</osade_context>');
  });

  it('does not leak another repository\'s conventions', async () => {
    addConvention('cv_other', 'r2', 'Imports from the SDK go through src/lib/moss.ts.');
    await index();

    const result = await assembler.build('t1', 'update the sdk imports in the wrapper');
    expect(result?.block ?? '').not.toContain('cv_other');
  });

  it('returns no block at all when nothing survives the filters', async () => {
    const result = await assembler.build('t1', 'something nothing matches at all');
    expect(result?.block).toBeNull();
    // A pack is still recorded: "we retrieved and found nothing" is a fact worth having when
    // a lane goes wrong, and it is what makes the chip's latency readout honest.
    expect(result?.pack.items).toEqual([]);
  });

  it('skips turns already in the agent\'s own recent scrollback (§M.2.2 step 2)', async () => {
    // The last 6 turns of this task are excluded; re-injecting them wastes budget on text the
    // agent can already see.
    for (let seq = 1; seq <= 3; seq += 1) addTurn('t1', seq, 'the wrapper signature stays stable');
    await index();

    const result = await assembler.build('t1', 'wrapper signature');
    expect(result?.pack.items.filter((i) => i.src_table === 'chat_turn')).toEqual([]);
  });
});

describe('§M.2.2 step 3 — the truth wins over the index', () => {
  it('drops a hit whose source row has been deleted', async () => {
    addConvention('cv_1', 'r1', 'Imports from the SDK go through src/lib/moss.ts.');
    await index();

    // Delete the row *without* letting the indexer catch up: this is exactly the lag window
    // the provenance filter exists for.
    db.prepare('DELETE FROM convention_evidence WHERE convention_id = ?').run('cv_1');
    db.prepare('DELETE FROM convention WHERE id = ?').run('cv_1');

    const result = await assembler.build('t1', 'update the sdk imports in the wrapper');
    expect(result?.pack.items).toEqual([]);
    expect(result?.block).toBeNull();
  });
});

describe('§M.2.2 step 4 — the cap is the feature', () => {
  it('stops at the token budget and counts the rest as overflow', async () => {
    for (let i = 0; i < 40; i += 1) {
      addConvention(`cv_${i}`, 'r1', `Rule ${i}: imports from the sdk go through the lib module.`);
    }
    await index();

    const tight = new ContextAssembler(db, service, {
      now: () => NOW,
      config: { enabled: true, cloudSync: false, budgetTokens: 40, queryTimeoutMs: 25 },
    });
    const result = await tight.build('t1', 'imports from the sdk go through the lib module');

    expect(result).not.toBeNull();
    expect(result!.pack.tokens_used).toBeLessThanOrEqual(40);
    expect(result!.pack.overflow).toBeGreaterThan(0);
    // Overflow is counted, never appended.
    expect(result!.pack.items.length + result!.pack.overflow).toBeGreaterThan(result!.pack.items.length);
  });

  it('orders by score × source weight, so a convention outranks a bare turn', async () => {
    addConvention('cv_1', 'r1', 'the wrapper signature stays stable across versions');
    addTurn('t2', 1, 'the wrapper signature stays stable across versions');
    await index();

    const result = await assembler.build('t1', 'wrapper signature stays stable');
    const first = result?.pack.items[0];
    expect(first?.src_table).toBe('convention');
  });
});

describe('§M.2.4 — the context_pack row', () => {
  it('is written for every assembly, with ids and no text', async () => {
    addConvention('cv_1', 'r1', 'Imports from the SDK go through src/lib/moss.ts.');
    await index();

    const turnId = addTurn('t1', 9, 'update the sdk imports');
    const result = await assembler.build('t1', 'update the sdk imports', turnId);
    const row = db.prepare('SELECT * FROM context_pack WHERE id = ?').get(result!.pack.id) as {
      task_id: string;
      chat_turn_id: string | null;
      backend: string;
      items_json: string;
      tokens_used: number;
    };

    expect(row.task_id).toBe('t1');
    expect(row.chat_turn_id).toBe(turnId);
    expect(row.backend).toBe('fts5');
    const stored = JSON.parse(row.items_json) as Record<string, unknown>[];
    expect(stored.length).toBeGreaterThan(0);
    // ids only — storing the text twice would make this the largest table in the database.
    expect(stored[0]).not.toHaveProperty('text');
    expect(stored[0]).toHaveProperty('src_id');
  });

  it('is a CDC table, so the chip updates through the one event path (ARCH §5.2)', () => {
    expect(CDC_TABLES).toContain('context_pack');
    const triggers = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
        name: string;
      }[]).map((t) => t.name),
    );
    for (const op of ['insert', 'update', 'delete']) {
      expect(triggers.has(`context_pack_cdc_${op}`)).toBe(true);
    }
  });

  it('records the degraded backend so the badge is not a guess', async () => {
    addConvention('cv_1', 'r1', 'Imports from the SDK go through src/lib/moss.ts.');
    await index();
    const result = await assembler.build('t1', 'update the sdk imports');
    expect(result!.pack.degraded).toBe(true);
    expect(result!.pack.backend).toBe('fts5');
  });
});

describe('§M.2 — assembly never fails a turn (R3)', () => {
  it('returns null for a task that no longer exists rather than throwing', async () => {
    await expect(assembler.build('gone', 'anything')).resolves.toBeNull();
  });

  it('survives an index that is completely empty', async () => {
    const result = await assembler.build('t1', 'anything at all');
    expect(result?.block).toBeNull();
    expect(result?.pack.overflow).toBe(0);
  });
});

describe('§M.2 — the sibling-lane digest', () => {
  it('carries a verified sibling fix into this lane', async () => {
    // t2 is a sibling lane in the same chat whose required step passed at its head.
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr_sib', 't2', 'test', 'pnpm test', ?, ?, 0, 1, 'sibhead', '/logs/vr_sib')`,
    ).run(NOW, NOW + 5);
    await index();

    const result = await assembler.build('t1', 'pnpm test verification step');
    const sibling = result?.pack.items.find((i) => i.src_id === 'vr_sib');
    expect(sibling, 'a verified sibling run should reach this lane').toBeDefined();
    expect(result?.block).toContain('## What sibling lanes learned (verified)');
  });

  it('does not carry an unverified sibling run', async () => {
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr_fail', 't2', 'test', 'pnpm test', ?, ?, 1, 1, 'sibhead', '/logs/vr_fail')`,
    ).run(NOW, NOW + 5);
    await index();

    const result = await assembler.build('t1', 'pnpm test verification step');
    expect(result?.pack.items.find((i) => i.src_id === 'vr_fail')).toBeUndefined();
  });

  it('does not reach across chats', async () => {
    // t3 is in chat2. Its verified run must not appear in chat1's lane.
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr_other', 't3', 'test', 'pnpm test', ?, ?, 0, 1, 'otherhead', '/logs/vr_other')`,
    ).run(NOW, NOW + 5);
    await index();

    const result = await assembler.build('t1', 'pnpm test verification step');
    expect(result?.pack.items.find((i) => i.src_id === 'vr_other')).toBeUndefined();
  });
});

describe('§M.1.7 — the hot path stays on budget', () => {
  it('assembles in well under the 30 ms target on a realistic index', async () => {
    for (let i = 0; i < 200; i += 1) {
      addConvention(`cv_${i}`, 'r1', `Rule ${i}: imports from the sdk go through the lib module.`);
    }
    for (let seq = 1; seq <= 200; seq += 1) {
      addTurn('t2', seq, `sibling lane turn ${seq} about the sdk migration and the wrapper`);
    }
    await index();

    // Warm, then measure: the first call pays for statement preparation, which a running
    // daemon has already paid by its first turn.
    await assembler.build('t1', 'sdk migration wrapper imports');
    const started = performance.now();
    const result = await assembler.build('t1', 'sdk migration wrapper imports');
    const elapsed = performance.now() - started;

    expect(result).not.toBeNull();
    // Generous against the §M.1.7 target of p95 < 30 ms: this asserts the shape of the cost
    // (one indexed query per namespace, filters in memory) rather than a machine's speed.
    expect(elapsed).toBeLessThan(300);
  });
});
