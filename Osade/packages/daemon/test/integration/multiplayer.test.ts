import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { CatchUp } from '../../src/server/catch-up.js';
import { AuthError, hashToken, Members, PRESENCE_TTL_MS } from '../../src/server/members.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * F2 — multiplayer lanes (OSADE-MOSS §M.6).
 *
 * §M.6.8's criteria, minus the two-laptop one: B joins and sees the ledger (criterion 1) is the
 * auth path here; B approves a gate as themselves (criterion 2) is §M.6.3's `decided_by`; B
 * returns after ten turns and catches up (criterion 3) is the last block. Criterion 4 —
 * `taskShellOpen` returning FORBIDDEN — lives in `role-matrix.test.ts`, where the whole matrix
 * is checked rather than one procedure.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let clock: number;
let members: Members;

/** A stand-in for GitHub: maps a token to the login it identifies. */
const IDENTITIES: Record<string, string> = {
  'gho_priya': 'priya',
  'gho_sam': 'sam',
  'gho_stranger': 'stranger',
};

function seed(): void {
  db.prepare('INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, NULL, ?, ?, ?)').run(
    'r1',
    '/repo',
    'main',
    NOW,
  );
  for (const id of ['t1', 't2']) {
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, created_at)
       VALUES (?, 'r1', 'x', 'x', 'manual', 'chat1', 'main', 'base', ?, '/wt', ?)`,
    ).run(id, `osade/${id}`, NOW);
  }
}

beforeEach(() => {
  clock = NOW;
  db = openDb(':memory:');
  seed();
  members = new Members(db, {
    now: () => clock,
    identify: async (token) => IDENTITIES[token] ?? null,
  });
  members.ensureOwner('alice');
});

afterEach(() => {
  db.close();
});

describe('§M.6.2 — identity is GitHub’s', () => {
  it('the host becomes the owner, once, and is never demoted', () => {
    expect(members.get('alice')).toEqual({ login: 'alice', role: 'owner' });
    members.ensureOwner('alice');
    expect(members.get('alice')?.role).toBe('owner');
  });

  it('only invited logins get in, even with a valid GitHub token', async () => {
    // A valid token proves who you are. It does not prove you were asked to this session.
    await expect(members.exchange('gho_stranger')).rejects.toThrow(/has not been invited/);
  });

  it('exchanges an invited teammate’s token for a session', async () => {
    members.invite('priya', 'maintainer', 'alice');
    const granted = await members.exchange('gho_priya');

    expect(granted).toMatchObject({ login: 'priya', role: 'maintainer' });
    expect(members.resolve(granted.token)).toEqual({ login: 'priya', role: 'maintainer' });
  });

  it('never stores the session token, only its hash', async () => {
    members.invite('priya', 'maintainer', 'alice');
    const { token } = await members.exchange('gho_priya');

    const rows = db.prepare('SELECT token_hash FROM member_session').all() as {
      token_hash: string;
    }[];
    // A database that leaks must not be replayable as a session.
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('rejects a token GitHub does not recognise', async () => {
    await expect(members.exchange('gho_nonsense')).rejects.toThrow(/does not identify anyone/);
  });

  it('refuses to invite a second owner', () => {
    // The owner is whoever's machine this is and whose token does every write. "Invite an
    // owner" would be handing over the shell (M3).
    expect(() => members.invite('sam', 'owner', 'alice')).toThrow(AuthError);
  });
});

describe('§M.6.2 — sessions expire, revoke and vanish with the member', () => {
  async function session(): Promise<string> {
    members.invite('priya', 'maintainer', 'alice');
    return (await members.exchange('gho_priya')).token;
  }

  it('expires after the TTL', async () => {
    const token = await session();
    expect(members.resolve(token)).not.toBeNull();

    clock = NOW + 13 * 60 * 60 * 1000;
    expect(members.resolve(token)).toBeNull();
  });

  it('logout revokes immediately', async () => {
    const token = await session();
    members.logout(token);
    expect(members.resolve(token)).toBeNull();
  });

  it('§M.10 — removing a teammate revokes their live sessions', async () => {
    const token = await session();
    members.remove('priya');

    // No window in which someone is "not a member" but still holds a working token.
    expect(members.resolve(token)).toBeNull();
    expect(members.get('priya')).toBeNull();
  });

  it('refuses to remove the owner', () => {
    expect(() => members.remove('alice')).toThrow(/owner cannot be removed/);
  });

  it('resolves nothing for an unknown or absent token', () => {
    expect(members.resolve(null)).toBeNull();
    expect(members.resolve('')).toBeNull();
    expect(members.resolve('made-up')).toBeNull();
  });
});

describe('§M.6.7 — presence and claims are advisory', () => {
  it('presence is derived from heartbeats, not a stored flag', () => {
    members.invite('priya', 'maintainer', 'alice');
    members.beat('priya', 't1');
    expect(members.presence('t1')).toEqual(['priya']);

    clock = NOW + PRESENCE_TTL_MS + 1;
    // No cleanup job ran. The absence is derived from the timestamp, which is why a crashed
    // client does not leave a ghost sitting in the lane.
    expect(members.presence('t1')).toEqual([]);
  });

  it('records who is driving a lane', () => {
    members.invite('priya', 'maintainer', 'alice');
    members.beat('priya', 't1');
    members.claim('t1', 'priya');
    expect(members.claimedBy('t1')).toBe('priya');

    members.release('t1', 'priya');
    expect(members.claimedBy('t1')).toBeNull();
  });

  it('a claim expires with presence, so a closed laptop does not hold a lane', () => {
    members.invite('priya', 'maintainer', 'alice');
    members.beat('priya', 't1');
    members.claim('t1', 'priya');

    clock = NOW + PRESENCE_TTL_MS + 1;
    expect(members.claimedBy('t1')).toBeNull();
  });

  it('a second claim supersedes the first rather than failing', () => {
    for (const login of ['priya', 'sam']) members.invite(login, 'maintainer', 'alice');
    members.beat('priya', 't1');
    members.claim('t1', 'priya');
    members.beat('sam', 't1');
    members.claim('t1', 'sam');

    // Advisory: a maintainer taking over is a thing that happens, and the trail shows it.
    expect(members.claimedBy('t1')).toBe('sam');
  });
});

describe('§M.6.8 criterion 3 — catch-up', () => {
  let retrieval: RetrievalService;
  let catchUp: CatchUp;

  beforeEach(async () => {
    retrieval = await RetrievalService.open(db, { port: new Fts5Adapter(db), onWarning: () => {} });
    catchUp = new CatchUp(db, retrieval, { now: () => clock });
    members.invite('priya', 'maintainer', 'alice');
  });

  function addTurn(taskId: string, seq: number, text: string, at: number): void {
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES (?, ?, ?, 'user', 'human', ?, 'accepted', ?)`,
    ).run(`ct_${taskId}_${seq}`, taskId, seq, text, at);
  }

  function addGate(id: string, taskId: string, decision: string, at: number): void {
    db.prepare(
      `INSERT INTO gate_request (id, task_id, gate, payload_json, payload_hash, requested_at,
                                 decided_at, decision, decided_by)
       VALUES (?, ?, 'gate.pr_open', '{}', 'h', ?, ?, ?, 'github:sam')`,
    ).run(id, taskId, at, at, decision);
  }

  function addFailure(id: string, taskId: string, at: number): void {
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES (?, ?, 'test', 'pnpm test', ?, ?, 1, 1, 'head', '/logs/x')`,
    ).run(id, taskId, at, at);
  }

  it('returns nothing on a second call — "since you left" means something', async () => {
    addTurn('t1', 1, 'first message about the sdk', NOW + 1);
    await retrieval.indexer.drain();

    const first = await catchUp.since('priya', 'chat1');
    expect(first.items.length).toBeGreaterThan(0);

    const second = await catchUp.since('priya', 'chat1');
    expect(second.items).toEqual([]);
  });

  it('includes every gate decision and verify failure by exact filter, not by ranking', async () => {
    // Bury the important events under noise that scores better against the fixed query.
    for (let seq = 1; seq <= 20; seq += 1) {
      addTurn('t1', seq, 'decisions failures approvals redirections chatter', NOW + seq);
    }
    addGate('g_rejected', 't1', 'deny', NOW + 30);
    addFailure('vr_failed', 't1', NOW + 31);
    await retrieval.indexer.drain();

    const result = await catchUp.since('priya', 'chat1');
    const ids = result.items.map((item) => item.src_id);

    // A catch-up that dropped "the PR was rejected" because it scored eleventh would be worse
    // than none: the reader would believe they had seen everything.
    expect(ids).toContain('g_rejected');
    expect(ids).toContain('vr_failed');
    expect(result.items.filter((item) => item.guaranteed).length).toBe(2);
  });

  it('caps the result, so rejoining is a glance', async () => {
    for (let seq = 1; seq <= 40; seq += 1) {
      addTurn('t1', seq, `turn ${seq} about decisions and failures`, NOW + seq);
    }
    await retrieval.indexer.drain();

    const result = await catchUp.since('priya', 'chat1');
    expect(result.items.length).toBeLessThanOrEqual(12);
  });

  it('reports which backend answered and how long it took', async () => {
    addTurn('t1', 1, 'something happened', NOW + 1);
    await retrieval.indexer.drain();

    const result = await catchUp.since('priya', 'chat1');
    expect(result.backend).toBe('fts5');
    expect(result.retrieval_ms).toBeGreaterThanOrEqual(0);
  });

  it('is per member — one person reading does not mark it read for everyone', async () => {
    members.invite('sam', 'viewer', 'alice');
    addTurn('t1', 1, 'a decision was made', NOW + 1);
    await retrieval.indexer.drain();

    await catchUp.since('priya', 'chat1');
    const sam = await catchUp.since('sam', 'chat1');
    expect(sam.items.length).toBeGreaterThan(0);
  });

  it('ask returns cited hits rather than an answer', async () => {
    addTurn('t1', 1, 'we decided to keep the wrapper signature stable', NOW + 1);
    await retrieval.indexer.drain();

    const hits = await catchUp.ask('chat1', 'wrapper signature');
    expect(hits.length).toBeGreaterThan(0);
    // Every item traces to a row; there is no synthesised prose anywhere in the result.
    for (const hit of hits) {
      expect(hit.src_table).toBeTruthy();
      expect(hit.src_id).toBeTruthy();
    }
  });
});
