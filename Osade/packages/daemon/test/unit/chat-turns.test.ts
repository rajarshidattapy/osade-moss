import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import {
  dispatchQueued,
  failOpenTurns,
  failUnreadyTurns,
  listTurns,
  sendTurn,
  settleAgentReply,
  turnInFlight,
} from '../../src/domain/chat-turns.js';

const NOW = 1_756_000_000_000;

let db: Db;
const prompts: string[] = [];

function seed(): void {
  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?, ?, ?)').run('o1', 'acme', NOW);
  db.prepare(
    'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('r1', 'o1', '/repo', 'main', NOW);
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, base_ref, base_sha, branch,
                       worktree_path, created_at)
     VALUES ('t1', 'r1', 'fix', 'first prompt', 'manual', 'main', 'headsha', 'osade/fix', '/wt', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO agent_fact (task_id, substrate_pane_id, substrate_state, pane_alive, state_change_seq, composer_ready)
     VALUES ('t1', 'w3:p2', 'idle', 1, 1, 1)`,
  ).run();
}

async function send(text: string) {
  return sendTurn(db, async (_id, body) => {
    prompts.push(body);
  }, { taskId: 't1', text, origin: 'human', now: NOW });
}

beforeEach(() => {
  db = openDb(':memory:');
  prompts.length = 0;
  seed();
});

afterEach(() => {
  db.close();
});

describe('chat turns — typed send, not keystrokes', () => {
  it('sends immediately when nothing is in flight', async () => {
    const turn = await send('first prompt');
    expect(turn.delivery).toBe('accepted');
    expect(prompts).toEqual(['first prompt']);
    expect(listTurns(db, 't1').map((t) => t.role)).toEqual(['user']);
  });

  it('queues a follow-up while the agent is still on the last turn', async () => {
    await send('first prompt');
    db.prepare("UPDATE agent_fact SET substrate_state = 'working' WHERE task_id = 't1'").run();
    expect(turnInFlight(db, 't1')).toBe(true);

    const held = await send('also write tests');
    expect(held.delivery).toBe('queued');
    expect(prompts).toEqual(['first prompt']);
    expect(listTurns(db, 't1').map((t) => t.text)).toEqual(['first prompt', 'also write tests']);
  });

  it('seeds the original intent when the first stored follow-up differs', async () => {
    await send('also write tests');
    expect(listTurns(db, 't1').map((t) => ({ role: t.role, text: t.text, delivery: t.delivery }))).toEqual([
      { role: 'user', text: 'first prompt', delivery: 'accepted' },
      { role: 'user', text: 'also write tests', delivery: 'accepted' },
    ]);
    expect(prompts).toEqual(['also write tests']);
  });

  it('dispatches the held turn after the pane goes quiet', async () => {
    await send('first prompt');
    db.prepare("UPDATE agent_fact SET substrate_state = 'working' WHERE task_id = 't1'").run();
    await send('also write tests');

    db.prepare(
      "UPDATE agent_fact SET substrate_state = 'done', activity_text = 'All files listed' WHERE task_id = 't1'",
    ).run();
    const reply = settleAgentReply(db, 't1', NOW);
    expect(reply?.text).toBe('All files listed');
    await dispatchQueued(db, async (_id, body) => {
      prompts.push(body);
    }, 't1', false, NOW);

    expect(prompts).toEqual(['first prompt', 'also write tests']);
    expect(listTurns(db, 't1').map((t) => ({ role: t.role, delivery: t.delivery }))).toEqual([
      { role: 'user', delivery: 'accepted' },
      { role: 'agent', delivery: 'accepted' },
      { role: 'user', delivery: 'accepted' },
    ]);
  });

  it('does not persist a Claude-named activity line as a reply', () => {
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES ('ct_1', 't1', 1, 'user', 'human', 'first prompt', 'accepted', ?)`,
    ).run(NOW);
    db.prepare("UPDATE agent_fact SET activity_text = 'claude' WHERE task_id = 't1'").run();
    expect(settleAgentReply(db, 't1', NOW)).toBeNull();
  });

  it('marks a failed prompt so it is not retried as queued', async () => {
    await expect(
      sendTurn(db, async () => {
        throw new Error('pane gone');
      }, { taskId: 't1', text: 'first prompt', origin: 'human', now: NOW }),
    ).rejects.toThrow('pane gone');
    expect(listTurns(db, 't1')[0]?.delivery).toBe('failed');
  });

  it('holds the first send as queued until the lane reports an idle composer', async () => {
    db.prepare("UPDATE agent_fact SET substrate_state = 'blocked', composer_ready = 0 WHERE task_id = 't1'").run();
    const held = await send('first prompt');
    expect(held.delivery).toBe('queued');
    expect(prompts).toEqual([]);
  });

  it('holds a send as queued when the composer is ready but no pane is bound yet', async () => {
    db.prepare(
      "UPDATE agent_fact SET substrate_pane_id = NULL, composer_ready = 1, substrate_state = 'idle' WHERE task_id = 't1'",
    ).run();
    const held = await send('first prompt');
    expect(held.delivery).toBe('queued');
    expect(prompts).toEqual([]);
  });

  it('flushes the held send once a pane is bound to the ready composer', async () => {
    db.prepare(
      "UPDATE agent_fact SET substrate_pane_id = NULL, composer_ready = 1, substrate_state = 'idle' WHERE task_id = 't1'",
    ).run();
    const held = await send('first prompt');
    expect(held.delivery).toBe('queued');
    expect(prompts).toEqual([]);
    db.prepare("UPDATE agent_fact SET substrate_pane_id = 'w3:p2' WHERE task_id = 't1'").run();
    await dispatchQueued(db, async (_id, body) => {
      prompts.push(body);
    }, 't1', false, NOW);
    expect(prompts).toEqual(['first prompt']);
    expect(listTurns(db, 't1')[0]?.delivery).toBe('accepted');
  });

  it('flushes the held first send once the composer is idle', async () => {
    db.prepare("UPDATE agent_fact SET substrate_state = 'blocked', composer_ready = 0 WHERE task_id = 't1'").run();
    await send('first prompt');
    db.prepare(
      "UPDATE agent_fact SET substrate_state = 'idle', composer_ready = 1 WHERE task_id = 't1'",
    ).run();
    await dispatchQueued(db, async (_id, body) => {
      prompts.push(body);
    }, 't1', false, NOW);
    expect(prompts).toEqual(['first prompt']);
    expect(listTurns(db, 't1')[0]?.delivery).toBe('accepted');
  });

  it('does not expire a follow-up that waited on a live turn past the ready timeout', async () => {
    await send('first prompt');
    db.prepare("UPDATE agent_fact SET substrate_state = 'working' WHERE task_id = 't1'").run();
    await send('also write tests');
    db.prepare("UPDATE agent_fact SET substrate_state = 'idle' WHERE task_id = 't1'").run();
    await dispatchQueued(db, async (_id, body) => {
      prompts.push(body);
    }, 't1', false, NOW + 60_000, { readyTimeoutMs: 45_000 });
    expect(prompts).toEqual(['first prompt', 'also write tests']);
    expect(listTurns(db, 't1').at(-1)?.delivery).toBe('accepted');
  });

  it('fails a send that never became ready, with a reason naming the agent', () => {
    db.prepare("UPDATE agent_fact SET substrate_state = 'blocked', composer_ready = 0 WHERE task_id = 't1'").run();
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES ('ct_q', 't1', 1, 'user', 'human', 'write tests', 'queued', ?)`,
    ).run(NOW);
    failUnreadyTurns(db, 't1', 'codex', 'idle composer', NOW);
    const turns = listTurns(db, 't1');
    expect(turns[0]?.delivery).toBe('failed');
    expect(turns.some((t) => t.role === 'agent' && /codex/i.test(t.text) && /idle composer/i.test(t.text))).toBe(
      true,
    );
  });

  it('settles a blocked turn from the pane surface delta, not final_message', () => {
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES ('ct_1', 't1', 1, 'user', 'human', 'write tests', 'accepted', ?)`,
    ).run(NOW);
    db.prepare("UPDATE agent_fact SET substrate_state = 'blocked', final_message = NULL WHERE task_id = 't1'").run();
    const reply = settleAgentReply(db, 't1', NOW, {
      surface:
        'banner\nwrite tests\nI will add coverage for auth.\n• Working (esc to interrupt)\ngpt-5 default · /work',
    });
    expect(reply?.text).toContain('I will add coverage for auth');
    expect(reply?.text).not.toMatch(/Working \(esc to interrupt\)/);
  });

  it('fails an in-flight turn when the pane dies mid-turn', () => {
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES ('ct_1', 't1', 1, 'user', 'human', 'write tests', 'accepted', ?)`,
    ).run(NOW);
    failOpenTurns(db, 't1', 'codex exited before finishing', NOW);
    const turns = listTurns(db, 't1');
    expect(turns[0]?.delivery).toBe('failed');
    expect(turns[0]?.error).toMatch(/exited before finishing/);
    expect(turns.some((t) => t.role === 'agent' && /exited before finishing/.test(t.text))).toBe(true);
  });
});
