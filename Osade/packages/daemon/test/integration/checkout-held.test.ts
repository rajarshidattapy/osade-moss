import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { getScmFact, getTask } from '../../src/db/task-repo.js';
import { enqueueTurn, listTurns } from '../../src/domain/chat-turns.js';
import { BranchHeldError, LaunchTask } from '../../src/domain/launch-task.js';
import { SubstrateApiError } from '../../src/substrate/client.js';
import type { SubstrateClient } from '../../src/substrate/client.js';
import type { SubstrateEventSubscriber } from '../../src/substrate/event-subscriber.js';

const NOW = 1_756_000_000_000;

let dir: string;
let repo: string;
let db: Db;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function fakeSubscriber(): SubstrateEventSubscriber {
  return { watchPane() {}, unwatchPane() {} } as unknown as SubstrateEventSubscriber;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osade-held-'));
  process.env.OSADE_HOME = join(dir, 'home');
  repo = join(dir, 'repo');
  sh(dir, ['init', '-q', '-b', 'main', 'repo']);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  sh(repo, ['branch', 'feat/review']);
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  delete process.env.OSADE_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('existing-ref worktree exclusivity', () => {
  it('names the lane that holds the branch and creates nothing', async () => {
    const holder = new LaunchTask(
      db,
      { request: async () => ({}) } as unknown as SubstrateClient,
      fakeSubscriber(),
      { now: () => NOW },
    );
    const first = await holder.createTask({
      repoPath: repo,
      title: 'Review round one',
      intent: 'address comments',
      isolate: true,
      checkoutRef: 'feat/review',
    });
    const heldPath = getTask(db, first.taskId)!.worktree_path!;

    const creates: unknown[] = [];
    const client = {
      async request(method: string, params?: unknown): Promise<unknown> {
        if (method === 'worktree.create') {
          creates.push(params);
          throw new SubstrateApiError('worktree.create', {
            code: 'git_error',
            message: `'feat/review' is already checked out at '${heldPath}'`,
          });
        }
        return {};
      },
    } as unknown as SubstrateClient;

    const launcher = new LaunchTask(db, client, fakeSubscriber(), { now: () => NOW });
    const second = await launcher.createTask({
      repoPath: repo,
      title: 'Second try',
      intent: 'also address comments',
      isolate: true,
      checkoutRef: 'feat/review',
    });

    await expect(launcher.launch(second.taskId)).rejects.toMatchObject({
      name: 'BranchHeldError',
      message: expect.stringContaining('Review round one'),
    });
    expect(getTask(db, second.taskId)).toBeNull();
    expect(getTask(db, first.taskId)).not.toBeNull();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ branch: 'feat/review' });
  });

  it('does not pre-check occupancy — git is what rejects the second checkout', async () => {
    const client = {
      async request(method: string, params?: unknown): Promise<unknown> {
        if (method === 'worktree.create') {
          expect(params).toMatchObject({ branch: 'feat/review' });
          return {
            workspace: { workspace_id: 'w1' },
            root_pane: { pane_id: 'w1:p1' },
          };
        }
        if (method === 'tab.create') {
          return { tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } };
        }
        if (method === 'agent.start') return { agent: {}, argv: [] };
        if (method === 'agent.get') {
          return { agent: { interactive_ready: true, launch_pending: false } };
        }
        if (method === 'pane.read') {
          return { read: { text: '', revision: 1, truncated: false } };
        }
        return {};
      },
    } as unknown as SubstrateClient;

    const launcher = new LaunchTask(db, client, fakeSubscriber(), { now: () => NOW });
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'On feat',
      intent: 'go',
      isolate: true,
      checkoutRef: 'feat/review',
    });
    // createTask itself does not look up holders; launch is what talks to git.
    expect(getTask(db, created.taskId)?.checkout_ref).toBe('feat/review');
    await launcher.launch(created.taskId);
    expect(getTask(db, created.taskId)?.substrate_workspace_id).toBe('w1');
  });
});

describe('moveToBranch', () => {
  it('archives the isolated lane, opens a new one on checkoutRef, and keeps the transcript', async () => {
    const client = {
      async request(method: string): Promise<unknown> {
        if (method === 'worktree.remove' || method === 'pane.list' || method === 'pane.close') {
          return {};
        }
        return {};
      },
    } as unknown as SubstrateClient;
    const launcher = new LaunchTask(db, client, fakeSubscriber(), { now: () => NOW });
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Token refresh',
      intent: 'fix it',
      isolate: true,
    });
    enqueueTurn(db, { taskId: created.taskId, text: 'please look at auth', origin: 'human', now: NOW });

    const moved = await launcher.moveToBranch(created.taskId, 'feat/review');
    const old = getTask(db, created.taskId)!;
    const next = getTask(db, moved.taskId)!;
    expect(old.archived_at).not.toBeNull();
    expect(next.chat_id).toBe(old.chat_id);
    expect(next.checkout_ref).toBe('feat/review');
    expect(next.branch).toBe('feat/review');
    expect(listTurns(db, next.id).map((t) => t.text)).toContain('please look at auth');
  });
});

describe('existing-ref PR adoption', () => {
  it('copies an open PR on that branch so a second PR is not offered', async () => {
    const launcher = new LaunchTask(
      db,
      { request: async () => ({}) } as unknown as SubstrateClient,
      fakeSubscriber(),
      { now: () => NOW },
    );
    const first = await launcher.createTask({
      repoPath: repo,
      title: 'Original',
      intent: 'ship it',
      isolate: true,
      checkoutRef: 'feat/review',
    });
    db.prepare(
      `INSERT INTO scm_fact (task_id, pr_number, pr_url, pr_state, pr_head_ref, unresolved_threads, fetched_at)
       VALUES (?, 12, 'https://github.com/acme/widget/pull/12', 'open', 'feat/review', 0, ?)`,
    ).run(first.taskId, NOW);

    const second = await launcher.createTask({
      repoPath: repo,
      title: 'Review follow-up',
      intent: 'address comments',
      isolate: true,
      checkoutRef: 'feat/review',
      chatId: first.taskId,
    });
    const scm = getScmFact(db, second.taskId);
    expect(scm?.pr_number).toBe(12);
    expect(scm?.pr_head_ref).toBe('feat/review');
  });
});

describe('BranchHeldError', () => {
  it('is a typed error', () => {
    const err = new BranchHeldError('feat', { taskId: 't1', chatId: 'c1', title: 'One' }, '/repo');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BranchHeldError');
    expect(err.message).toContain('One');
  });
});
