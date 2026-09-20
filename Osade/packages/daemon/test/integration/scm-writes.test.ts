import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { getScmFact } from '../../src/db/task-repo.js';
import { GateError, Gates, gatePolicy } from '../../src/domain/gates.js';
import { ScmClient, type ScmRequest } from '../../src/scm/client.js';
import { ScmWrites } from '../../src/scm/writes.js';

/**
 * §11.2 — every write is gated, and §11.3 — fork awareness.
 *
 * The assertions here are about refusal more than about success: the product's claim is that
 * an agent cannot write to a public surface without a human approving those exact bytes.
 */

const NOW = 1_756_000_000_000;

let db: Db;

function recorded(script: Record<string, unknown[]>): { request: ScmRequest; calls: string[] } {
  const calls: string[] = [];
  const request: ScmRequest = async (route) => {
    calls.push(route);
    const queue = script[route];
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (next instanceof Error) throw next;
    return {
      status: 200,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900' },
      data: next,
    };
  };
  return { request, calls };
}

function seed(repo: Partial<{ fork_of: string | null; upstream_remote: string | null }> = {}): void {
  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?,?,?)').run('o1', 'acme', NOW);
  db.prepare(
    `INSERT INTO repo (id, org_id, path, gh_owner, gh_name, default_branch, upstream_remote,
                       fork_of, created_at)
     VALUES ('r1','o1','/repo','acme','widget','main',?,?,?)`,
  ).run(repo.upstream_remote ?? null, repo.fork_of ?? null, NOW);
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, base_ref, base_sha, branch,
                       worktree_path, created_at)
     VALUES ('t1','r1','fix','x','manual','main','base','osade/fix','/wt',?)`,
  ).run(NOW);
}

function writes(script: Record<string, unknown[]>): {
  writer: ScmWrites;
  gates: Gates;
  calls: string[];
} {
  const gh = recorded(script);
  const gates = new Gates(db, { now: () => NOW });
  const writer = new ScmWrites(db, new ScmClient({ request: gh.request }), gates, {
    now: () => NOW,
  });
  return { writer, gates, calls: gh.calls };
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => db.close());

describe('§11.2 — no public write without an approved gate', () => {
  const PR_CREATED = {
    'POST /repos/{owner}/{repo}/pulls': [
      { number: 12, html_url: 'https://github.com/acme/widget/pull/12', head: { sha: 'deadbee' } },
    ],
    'GET /repos/{owner}/{repo}': [{ permissions: { push: true } }],
  };

  const payload = {
    title: 'fix: guard the null case',
    body: 'Closes #3.',
    head: 'osade/fix',
    base: 'main',
    draft: false,
  };

  it('refuses to open a PR on an undecided gate', async () => {
    seed();
    const { writer, gates, calls } = writes(PR_CREATED);
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });

    await expect(writer.openPr('t1', gateId, payload)).rejects.toThrow(GateError);
    // Nothing reached GitHub.
    expect(calls).toEqual([]);
  });

  it('refuses on a denied gate', async () => {
    seed();
    const { writer, gates, calls } = writes(PR_CREATED);
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    gates.decide(gateId, 'deny');

    await expect(writer.openPr('t1', gateId, payload)).rejects.toThrow(/not approved/);
    expect(calls).toEqual([]);
  });

  it('THE invariant: refuses when the payload changed after approval', async () => {
    seed();
    const { writer, gates, calls } = writes(PR_CREATED);
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    gates.decide(gateId, 'approve');

    // The human approved one PR body; something now wants to open a different one.
    await expect(
      writer.openPr('t1', gateId, { ...payload, body: 'Also refactors everything.' }),
    ).rejects.toThrow(/payload changed after approval/);
    expect(calls).toEqual([]);
  });

  it('opens the PR on an approved gate and records the fact', async () => {
    seed();
    const { writer, gates } = writes(PR_CREATED);
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    gates.decide(gateId, 'approve');

    const pr = await writer.openPr('t1', gateId, payload);
    expect(pr.number).toBe(12);

    const fact = getScmFact(db, 't1')!;
    expect(fact.pr_number).toBe(12);
    expect(fact.pr_state).toBe('open');
    expect(fact.pr_head_sha).toBe('deadbee');
  });

  it('a gate executes at most once', async () => {
    seed();
    const { writer, gates } = writes(PR_CREATED);
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    gates.decide(gateId, 'approve');

    await writer.openPr('t1', gateId, payload);
    await expect(writer.openPr('t1', gateId, payload)).rejects.toThrow(/already executed/);
  });

  it('records the failure on the gate when GitHub rejects the write', async () => {
    seed();
    const { writer, gates } = writes({
      'GET /repos/{owner}/{repo}': [{ permissions: { push: true } }],
      'POST /repos/{owner}/{repo}/pulls': [new Error('422 Validation Failed')],
    });
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    gates.decide(gateId, 'approve');

    await expect(writer.openPr('t1', gateId, payload)).rejects.toThrow(/422/);

    const row = db.prepare('SELECT * FROM gate_request WHERE id = ?').get(gateId) as {
      executed_at: number | null;
      execution_error: string | null;
    };
    // The attempt is recorded so the same approval cannot be silently retried.
    expect(row.executed_at).not.toBe(null);
    expect(row.execution_error).toContain('422');
  });

  it('a comment needs an approved gate too', async () => {
    seed();
    const { writer, gates, calls } = writes({
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': [{ html_url: 'c1' }],
    });
    const body = { body: 'Reproduced on main at 3f2a1b.' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.issue_comment', payload: body });

    await expect(writer.comment('t1', gateId, body, { issueNumber: 3 })).rejects.toThrow(
      /has not been decided/,
    );
    expect(calls).toEqual([]);

    gates.decide(gateId, 'approve');
    await expect(writer.comment('t1', gateId, body, { issueNumber: 3 })).resolves.toEqual({
      url: 'c1',
    });
  });
});

describe('§11.3 — fork awareness', () => {
  it('pushes to origin and targets the repo directly when we can push', async () => {
    seed();
    const { writer } = writes({ 'GET /repos/{owner}/{repo}': [{ permissions: { push: true } }] });

    const plan = await writer.planFork('t1');
    expect(plan.viaFork).toBe(false);
    expect(plan.head).toBe('osade/fix');
    expect(plan.prOwner).toBe('acme');
    expect(plan.prBase).toBe('main');
  });

  it('a 304 on the permission probe is not "no push access"', async () => {
    seed();
    const request: ScmRequest = async (_route, params) => {
      const headers = params.headers as { 'if-none-match'?: string } | undefined;
      if (headers?.['if-none-match']) {
        return {
          status: 304,
          headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4899' },
          data: undefined,
        };
      }
      return {
        status: 200,
        headers: {
          etag: '"abc"',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4900',
        },
        data: { permissions: { push: true } },
      };
    };
    const writer = new ScmWrites(db, new ScmClient({ request }), new Gates(db, { now: () => NOW }), {
      now: () => NOW,
    });

    await expect(writer.planFork('t1')).resolves.toMatchObject({ viaFork: false });
    await expect(writer.planFork('t1')).resolves.toMatchObject({ viaFork: false });
  });

  it('pushes to the fork and targets upstream when this checkout is a fork', async () => {
    seed({ fork_of: 'upstream-org/widget' });
    const { writer, calls } = writes({});

    const plan = await writer.planFork('t1');
    expect(plan.viaFork).toBe(true);
    // GitHub wants `owner:branch` for a cross-repository PR.
    expect(plan.head).toBe('acme:osade/fix');
    expect(plan.prOwner).toBe('upstream-org');
    expect(plan.prRepo).toBe('widget');
    // A recorded fork needs no permission probe.
    expect(calls).toEqual([]);
  });

  it('INVARIANT: never offers to push to an upstream we do not own', async () => {
    seed();
    const { writer } = writes({ 'GET /repos/{owner}/{repo}': [{ permissions: { push: false } }] });

    await expect(writer.planFork('t1')).rejects.toThrow(/no push access/);
    // …and it says what to do instead, rather than failing opaquely.
    await expect(writer.planFork('t1')).rejects.toThrow(/Create a fork first/);
  });

  it('not knowing whether we can push is not permission', async () => {
    seed();
    const warnings: string[] = [];
    const gh = recorded({ 'GET /repos/{owner}/{repo}': [new Error('503')] });
    const writer = new ScmWrites(
      db,
      new ScmClient({ request: gh.request }),
      new Gates(db, { now: () => NOW }),
      { now: () => NOW, onWarning: (m) => warnings.push(m) },
    );

    // A failed permission check must never read as "yes".
    await expect(writer.planFork('t1')).rejects.toThrow(/no push access/);
    expect(warnings.join()).toContain('could not check push access');
  });
});

describe('§11.3 — forking, behind a gate', () => {
  const FORK_PAYLOAD = { owner: 'acme', repo: 'widget' };

  it('finds a fork the user already has rather than offering to create another', async () => {
    seed();
    const { writer } = writes({
      'GET /user': [{ login: 'contributor' }],
      'GET /repos/{owner}/{repo}': [
        { fork: true, parent: { full_name: 'acme/widget' }, owner: { login: 'contributor' }, name: 'widget' },
      ],
    });

    await expect(writer.findExistingFork('t1')).resolves.toEqual({
      owner: 'contributor',
      name: 'widget',
    });
  });

  it('does not mistake an unrelated repo of the same name for a fork', async () => {
    seed();
    const { writer } = writes({
      'GET /user': [{ login: 'contributor' }],
      'GET /repos/{owner}/{repo}': [
        // Same name, but forked from somewhere else entirely.
        { fork: true, parent: { full_name: 'other-org/widget' }, owner: { login: 'contributor' }, name: 'widget' },
      ],
    });

    await expect(writer.findExistingFork('t1')).resolves.toBe(null);
  });

  it('refuses to fork without an approved gate', async () => {
    seed();
    const { writer, gates, calls } = writes({
      'POST /repos/{owner}/{repo}/forks': [{ owner: { login: 'contributor' }, name: 'widget' }],
    });
    const gateId = gates.request({ taskId: 't1', gate: 'gate.fork_create', payload: FORK_PAYLOAD });

    await expect(writer.createFork('t1', gateId, FORK_PAYLOAD)).rejects.toThrow(GateError);
    // Nothing was created under the user's account.
    expect(calls).toEqual([]);
  });

  it('gate.fork_create can never be downgraded by policy', () => {
    // Creating a public repository on someone's behalf is not something a policy may automate.
    expect(gatePolicy('gate.fork_create').overridable).toBe(false);
    expect(gatePolicy('gate.fork_create').def).toBe('human');

    seed();
    const policyGates = new Gates(db, { now: () => NOW, policies: { 'gate.fork_create': 'yolo' } });
    const gateId = policyGates.request({
      taskId: 't1',
      gate: 'gate.fork_create',
      payload: FORK_PAYLOAD,
    });
    const row = db.prepare('SELECT decided_at FROM gate_request WHERE id = ?').get(gateId) as {
      decided_at: number | null;
    };
    expect(row.decided_at).toBe(null);
  });

  it('creates the fork on approval and routes future PRs through it', async () => {
    seed();
    const { writer, gates } = writes({
      'POST /repos/{owner}/{repo}/forks': [{ owner: { login: 'contributor' }, name: 'widget' }],
    });
    const gateId = gates.request({ taskId: 't1', gate: 'gate.fork_create', payload: FORK_PAYLOAD });
    gates.decide(gateId, 'approve');

    await expect(writer.createFork('t1', gateId, FORK_PAYLOAD)).resolves.toEqual({
      owner: 'contributor',
      name: 'widget',
    });

    // §11.3 — the checkout is now the fork; upstream is where it came from.
    const plan = await writer.planFork('t1');
    expect(plan.viaFork).toBe(true);
    expect(plan.head).toBe('contributor:osade/fix');
    expect(plan.prOwner).toBe('acme');
  });

  it('adopting an existing fork writes nothing to GitHub, so it needs no gate', async () => {
    seed();
    const { writer, calls } = writes({});

    writer.adoptFork('t1', { owner: 'contributor', name: 'widget' });

    const plan = await writer.planFork('t1');
    expect(plan.viaFork).toBe(true);
    expect(plan.head).toBe('contributor:osade/fix');
    expect(calls).toEqual([]);
  });
});
