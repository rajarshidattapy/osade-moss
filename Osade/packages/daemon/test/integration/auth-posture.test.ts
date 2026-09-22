import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { Gates } from '../../src/domain/gates.js';
import type { LaunchTask } from '../../src/domain/launch-task.js';
import type { ScmPoller } from '../../src/scm/poller.js';
import type { ScmWrites } from '../../src/scm/writes.js';
import type { Triage } from '../../src/domain/triage.js';
import type { VerifyRunner } from '../../src/domain/verify-run.js';
import { CatchUp } from '../../src/server/catch-up.js';
import { Members } from '../../src/server/members.js';
import { startDaemonServer, type RunningDaemon } from '../../src/server/index.js';

/**
 * F2's posture, over HTTP, against the real server — OSADE-MOSS §M.6.8.
 *
 * The role matrix and the member registry each have their own unit coverage. What they do not
 * prove is that the *listener* wires them together: that a bearer token becomes a session, that
 * a missing one is refused, and that the websocket closes before the snapshot goes out. Those
 * are seams, and a seam is exactly the thing a unit test cannot reach.
 *
 * §M.6.8 criterion 4 — `taskShellOpen` returning FORBIDDEN for a maintainer — is asserted here
 * over the wire rather than against the matrix, because the matrix being right is worth nothing
 * if the middleware does not consult it.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let home: string;
let daemon: RunningDaemon;
let members: Members;

const IDENTITIES: Record<string, string> = { gho_priya: 'priya', gho_sam: 'sam' };

/** The daemon needs these wired; none of them is reached by the calls below. */
function stub<T>(): T {
  return {} as T;
}

async function call(
  path: string,
  options: { token?: string; input?: unknown; method?: 'GET' | 'POST' } = {},
): Promise<{ status: number; body: TrpcResponse }> {
  const base = `http://127.0.0.1:${daemon.port}/${path}`;
  const url =
    (options.method ?? 'GET') === 'GET'
      ? `${base}?input=${encodeURIComponent(JSON.stringify(options.input ?? {}))}`
      : base;

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.method === 'POST' ? { body: JSON.stringify(options.input ?? {}) } : {}),
  });
  return { status: response.status, body: (await response.json()) as never };
}

/**
 * The router is created without a transformer, so an error arrives as
 * `{ error: { message, code, data: { code } } }` — not the superjson-wrapped `error.json.*`
 * shape. Reading the wrong one returns `undefined` for every failure, which makes every
 * assertion here pass vacuously; hence the explicit type rather than an inline reach.
 */
interface TrpcResponse {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
}

function errorCode(body: TrpcResponse): string | undefined {
  return body.error?.data?.code;
}

function dataOf<T>(body: TrpcResponse): T {
  return body.result?.data as T;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'osade-auth-'));
  process.env.OSADE_HOME = home;
  db = openDb(':memory:');
  db.prepare('INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, NULL, ?, ?, ?)').run(
    'r1',
    '/repo',
    'main',
    NOW,
  );
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                       branch, worktree_path, created_at)
     VALUES ('t1', 'r1', 'x', 'x', 'manual', 'chat1', 'main', 'base', 'osade/x', '/wt', ?)`,
  ).run(NOW);

  members = new Members(db, {
    now: () => NOW,
    identify: async (token) => IDENTITIES[token] ?? null,
  });
  members.ensureOwner('alice');
  members.invite('priya', 'maintainer', 'alice');
  members.invite('sam', 'viewer', 'alice');

  daemon = await startDaemonServer({
    db,
    launcher: stub<LaunchTask>(),
    gates: new Gates(db, { now: () => NOW }),
    verifier: stub<VerifyRunner>(),
    triage: stub<Triage>(),
    scmWrites: stub<ScmWrites>(),
    poller: stub<ScmPoller>(),
    members,
    catchUp: new CatchUp(db, null, { now: () => NOW }),
    now: () => NOW,
    onWarning: () => {},
  });
});

afterEach(async () => {
  await daemon.close();
  db.close();
  delete process.env.OSADE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('§M.6.2 — the door', () => {
  it('health needs no session at all', async () => {
    const result = await call('health');
    expect(result.body.error).toBeUndefined();
  });

  it('everything else refuses an anonymous caller once members exist', async () => {
    const result = await call('taskList');
    expect(errorCode(result.body)).toBe('UNAUTHORIZED');
  });

  it('refuses a token that was never issued', async () => {
    const result = await call('taskList', { token: 'made-up' });
    expect(errorCode(result.body)).toBe('UNAUTHORIZED');
  });

  it('accepts a session minted through authExchange', async () => {
    const granted = await call('authExchange', {
      method: 'POST',
      input: { githubToken: 'gho_priya' },
    });
    const token = dataOf<{ token: string }>(granted.body).token;

    const listed = await call('taskList', { token });
    expect(listed.body.error).toBeUndefined();
  });

  it('refuses a GitHub token belonging to someone who was never invited', async () => {
    const result = await call('authExchange', {
      method: 'POST',
      input: { githubToken: 'gho_stranger' },
    });
    expect(errorCode(result.body)).toBe('UNAUTHORIZED');
  });
});

describe('§M.6.8 criterion 4 — the role matrix is consulted, not just declared', () => {
  async function tokenFor(githubToken: string): Promise<string> {
    const granted = await call('authExchange', { method: 'POST', input: { githubToken } });
    return dataOf<{ token: string }>(granted.body).token;
  }

  it('a maintainer calling taskShellOpen gets FORBIDDEN', async () => {
    const token = await tokenFor('gho_priya');
    const result = await call('taskShellOpen', {
      method: 'POST',
      token,
      input: { taskId: 't1' },
    });

    // M3 — the lane shell is a real shell on the host. Trust between colleagues does not
    // change what the daemon would be handing out.
    expect(errorCode(result.body)).toBe('FORBIDDEN');
  });

  it('names the role it wanted, so the refusal is actionable', async () => {
    const token = await tokenFor('gho_sam');
    const result = await call('taskClaim', { method: 'POST', token, input: { taskId: 't1' } });
    expect(errorCode(result.body)).toBe('FORBIDDEN');
    expect(result.body.error?.message).toContain('maintainer');
    expect(result.body.error?.message).toContain('viewer');
  });

  it('a viewer may read and may say they are present', async () => {
    const token = await tokenFor('gho_sam');
    expect((await call('taskList', { token })).body.error).toBeUndefined();

    const beat = await call('presenceBeat', { method: 'POST', token, input: { taskId: 't1' } });
    expect(beat.body.error).toBeUndefined();
  });

  it('a maintainer may drive a lane', async () => {
    const token = await tokenFor('gho_priya');
    const claim = await call('taskClaim', { method: 'POST', token, input: { taskId: 't1' } });
    expect(claim.body.error).toBeUndefined();
  });

  it('an owner-only membership change is refused to a maintainer', async () => {
    const token = await tokenFor('gho_priya');
    const result = await call('memberInvite', {
      method: 'POST',
      token,
      input: { login: 'mallory', role: 'maintainer' },
    });
    expect(errorCode(result.body)).toBe('FORBIDDEN');
    expect(members.get('mallory')).toBeNull();
  });
});

describe('§M.6.2 — the websocket closes before the snapshot', () => {
  function connect(query: string): Promise<{ closed: number | null; sawMessage: boolean }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws${query}`);
      let sawMessage = false;
      const done = (closed: number | null): void => {
        socket.removeAllListeners();
        socket.terminate();
        resolve({ closed, sawMessage });
      };
      socket.on('message', () => {
        sawMessage = true;
        // A snapshot arrived, so the connection was accepted. Stop here.
        done(null);
      });
      socket.on('close', (code) => done(code));
      socket.on('error', () => done(-1));
      setTimeout(() => done(null), 2_000).unref?.();
    });
  }

  it('refuses an unauthenticated socket without sending the ledger', async () => {
    const result = await connect('');
    // The snapshot is the *whole ledger*. Sending it and then checking would be a disclosure
    // with a polite error attached.
    expect(result.sawMessage).toBe(false);
    expect(result.closed).toBe(4401);
  });

  it('refuses a socket whose token is not a session', async () => {
    const result = await connect('?token=made-up');
    expect(result.sawMessage).toBe(false);
    expect(result.closed).toBe(4401);
  });

  it('accepts an authenticated socket and sends it the snapshot', async () => {
    const granted = await call('authExchange', {
      method: 'POST',
      input: { githubToken: 'gho_sam' },
    });
    const token = dataOf<{ token: string }>(granted.body).token;

    const result = await connect(`?token=${encodeURIComponent(token)}`);
    expect(result.sawMessage).toBe(true);
  });

  it('a revoked member cannot open a socket any more', async () => {
    const granted = await call('authExchange', {
      method: 'POST',
      input: { githubToken: 'gho_sam' },
    });
    const token = dataOf<{ token: string }>(granted.body).token;

    members.remove('sam');

    const result = await connect(`?token=${encodeURIComponent(token)}`);
    expect(result.sawMessage).toBe(false);
    expect(result.closed).toBe(4401);
  });

  it('accepts the host token, so the owner window is not locked out', async () => {
    const result = await connect(`?token=${encodeURIComponent(hostToken())}`);
    expect(result.sawMessage).toBe(true);
  });
});

/**
 * The bug: once anyone was invited, the desktop window and the CLI — which never sent a token,
 * because on a single-user loopback daemon there was nothing to send — got UNAUTHORIZED from
 * their own daemon. The host token is how they prove they are the owner without an exchange.
 */
describe('§M.6.2 — the host token', () => {
  it('makes the caller the owner', async () => {
    const result = await call('memberInvite', {
      method: 'POST',
      token: hostToken(),
      input: { login: 'mallory', role: 'viewer' },
    });
    expect(result.body.error).toBeUndefined();
    expect(members.get('mallory')?.role).toBe('viewer');
  });

  it('acts as the owner login, so decided_by names a real person', async () => {
    const claim = await call('taskClaim', { method: 'POST', token: hostToken(), input: { taskId: 't1' } });
    expect(dataOf<{ claimedBy: string }>(claim.body).claimedBy).toBe('alice');
  });

  it('is not a session a logout can revoke', async () => {
    await call('authLogout', { method: 'POST', token: hostToken() });
    const listed = await call('taskList', { token: hostToken() });
    expect(listed.body.error).toBeUndefined();
  });

  it('is only accepted verbatim', async () => {
    const token = hostToken();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const result = await call('taskList', { token: tampered });
    expect(errorCode(result.body)).toBe('UNAUTHORIZED');
  });
});

function hostToken(): string {
  return readFileSync(join(home, 'daemon.token'), 'utf8').trim();
}
