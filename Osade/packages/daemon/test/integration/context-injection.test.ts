import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { LaunchTask } from '../../src/domain/launch-task.js';
import { ContextAssembler } from '../../src/retrieval/assembler.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import type { SubstrateClient } from '../../src/substrate/client.js';
import type { SubstrateEventSubscriber } from '../../src/substrate/event-subscriber.js';

/**
 * OSADE-MOSS §M.2 — the context block reaches the agent and never the transcript.
 *
 * This is the property the whole design of §M.2.1 turns on, and it is the one a future change
 * is most likely to break: it would be easy, and wrong, to prepend the block in `sendTurn`
 * where the row is written. Then the block becomes part of `chat_turn.text`, the renderer needs
 * a strip rule like the one `<osade_lanes>` needs, and `copyTurns` starts duplicating stale
 * context into new lanes.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let launcher: LaunchTask;
let prompts: string[];

function seed(): void {
  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?, ?, ?)').run('o1', 'acme', NOW);
  db.prepare(
    'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('r1', 'o1', '/repo', 'main', NOW);
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                       branch, worktree_path, agent_id, created_at)
     VALUES ('t1', 'r1', 'migrate', 'migrate the sdk', 'manual', 'chat1', 'main', 'base000',
             'osade/t1', '/wt', 'claude', ?)`,
  ).run(NOW);
  // A live, idle pane, so `prompt` gets past its readiness check.
  db.prepare(
    `INSERT INTO agent_fact (task_id, substrate_pane_id, substrate_state, pane_alive, composer_ready)
     VALUES ('t1', 'w1:p1', 'idle', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO convention (id, repo_id, category, rule_text, confidence, lifecycle, mined_at)
     VALUES ('cv_1', 'r1', 'commit_style', 'Imports from the SDK go through src/lib/moss.ts.', 0.9, 'active', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO convention_evidence (id, convention_id, kind, url, observed_at)
     VALUES ('ev_1', 'cv_1', 'merged_pr', 'https://github.com/acme/web/pull/88', ?)`,
  ).run(NOW);
}

/** Answers just enough of the substrate protocol for `prompt` to run, and records the text. */
function fakeSubstrate(): SubstrateClient {
  return {
    request: async (method: string, params: unknown) => {
      if (method === 'agent.get') {
        return { agent: { interactive_ready: true, agent_status: 'idle', launch_pending: false } };
      }
      if (method === 'pane.read') return { read: { text: '', revision: 1, truncated: false } };
      if (method === 'agent.prompt') {
        prompts.push((params as { text: string }).text);
        return {};
      }
      return {};
    },
  } as unknown as SubstrateClient;
}

async function buildLauncher(withAssembler: boolean): Promise<LaunchTask> {
  const service = await RetrievalService.open(db, {
    port: new Fts5Adapter(db),
    onWarning: () => {},
  });
  await service.indexer.drain();
  const assembler = new ContextAssembler(db, service, { now: () => NOW });
  return new LaunchTask(
    db,
    fakeSubstrate(),
    { watchPane() {}, unwatchPane() {} } as unknown as SubstrateEventSubscriber,
    {
      now: () => NOW,
      defaultAgent: 'claude',
      ...(withAssembler ? { assembler } : {}),
    },
  );
}

beforeEach(async () => {
  db = openDb(':memory:');
  prompts = [];
  seed();
  launcher = await buildLauncher(true);
});

afterEach(() => {
  db.close();
});

describe('§M.2 — context reaches the agent', () => {
  it('prefixes the prompt with the cited block', async () => {
    await launcher.sendTurn('t1', 'update the sdk imports in the wrapper');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('<osade_context');
    expect(prompts[0]).toContain('[convention:cv_1]');
    expect(prompts[0]).toContain('src/lib/moss.ts');
    // The user's words are still there, after the block.
    expect(prompts[0]).toContain('update the sdk imports in the wrapper');
    expect(prompts[0]!.indexOf('</osade_context>')).toBeLessThan(
      prompts[0]!.indexOf('update the sdk imports'),
    );
  });

  it('leaves the durable transcript exactly what the human typed', async () => {
    await launcher.sendTurn('t1', 'update the sdk imports in the wrapper');

    const turns = db
      .prepare("SELECT text FROM chat_turn WHERE role = 'user' ORDER BY seq")
      .all() as { text: string }[];
    const sent = turns.at(-1)!;
    expect(sent.text).toBe('update the sdk imports in the wrapper');
    for (const turn of turns) expect(turn.text).not.toContain('osade_context');
  });

  it('records a pack linked to the turn it was assembled for', async () => {
    await launcher.sendTurn('t1', 'update the sdk imports in the wrapper');

    const pack = db
      .prepare('SELECT task_id, chat_turn_id, tokens_used FROM context_pack')
      .get() as { task_id: string; chat_turn_id: string | null; tokens_used: number };
    expect(pack.task_id).toBe('t1');
    expect(pack.chat_turn_id).not.toBeNull();
    expect(pack.tokens_used).toBeGreaterThan(0);

    const turn = db
      .prepare('SELECT text FROM chat_turn WHERE id = ?')
      .get(pack.chat_turn_id) as { text: string };
    expect(turn.text).toBe('update the sdk imports in the wrapper');
  });
});

describe('§M.2 — a daemon without an assembler is unchanged', () => {
  it('sends the turn exactly as before and records no pack', async () => {
    const plain = await buildLauncher(false);
    await plain.sendTurn('t1', 'update the sdk imports in the wrapper');

    expect(prompts).toEqual(['update the sdk imports in the wrapper']);
    const packs = db.prepare('SELECT COUNT(*) AS n FROM context_pack').get() as { n: number };
    expect(packs.n).toBe(0);
  });
});

describe('§M.2 R3 — assembly never fails a turn', () => {
  it('an assembler that throws still gets the prompt through', async () => {
    const broken = {
      build: async () => {
        throw new Error('retrieval exploded');
      },
    } as unknown as ContextAssembler;

    const warnings: string[] = [];
    const launching = new LaunchTask(
      db,
      fakeSubstrate(),
      { watchPane() {}, unwatchPane() {} } as unknown as SubstrateEventSubscriber,
      {
        now: () => NOW,
        defaultAgent: 'claude',
        assembler: broken,
        onWarning: (m) => warnings.push(m),
      },
    );

    await launching.sendTurn('t1', 'update the sdk imports');

    expect(prompts).toEqual(['update the sdk imports']);
    expect(warnings.join('\n')).toContain('retrieval exploded');
    // And the turn is recorded as delivered, not failed.
    const turn = db
      .prepare("SELECT delivery FROM chat_turn WHERE role = 'user' ORDER BY seq DESC LIMIT 1")
      .get() as { delivery: string };
    expect(turn.delivery).toBe('accepted');
  });
});
