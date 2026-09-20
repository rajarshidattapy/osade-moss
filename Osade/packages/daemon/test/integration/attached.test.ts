import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { getTask } from '../../src/db/task-repo.js';
import { isAttached, taskCwd } from '../../src/domain/cwd.js';
import { LaunchTask } from '../../src/domain/launch-task.js';
import type { SubstrateClient } from '../../src/substrate/client.js';
import type { SubstrateEventSubscriber } from '../../src/substrate/event-subscriber.js';

const NOW = 1_756_000_000_000;

let dir: string;
let repo: string;
let db: Db;
let launcher: LaunchTask;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osade-attached-'));
  process.env.OSADE_HOME = join(dir, 'home');
  repo = join(dir, 'repo');
  sh(dir, ['init', '-q', '-b', 'main', 'repo']);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  db = openDb(':memory:');
  launcher = new LaunchTask(
    db,
    { request: async () => ({}) } as unknown as SubstrateClient,
    { watchPane() {}, unwatchPane() {} } as unknown as SubstrateEventSubscriber,
    { now: () => NOW },
  );
});

afterEach(() => {
  db.close();
  delete process.env.OSADE_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('attached lanes', () => {
  it('a new chat is attached: no worktree path, branch is the checkout', async () => {
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'New chat',
      intent: 'hi',
    });
    const task = getTask(db, created.taskId)!;
    expect(created.isolated).toBe(false);
    expect(task.worktree_path).toBeNull();
    expect(isAttached(task)).toBe(true);
    expect(task.branch).toBe('main');
    expect(taskCwd(task, repo)).toBe(repo);
  });

  it('a second chat in the same repo is forced isolated', async () => {
    const first = await launcher.createTask({ repoPath: repo, title: 'One', intent: 'a' });
    const second = await launcher.createTask({ repoPath: repo, title: 'Two', intent: 'b' });
    expect(first.isolated).toBe(false);
    expect(second.isolated).toBe(true);
    expect(second.isolatedBecause?.title).toBe('One');
    const a = getTask(db, first.taskId)!;
    const b = getTask(db, second.taskId)!;
    expect(a.worktree_path).toBeNull();
    expect(b.worktree_path).toBeTruthy();
    expect(b.branch).toMatch(/^osade\//);
  });

  it('isolate: true always creates a worktree even when the slot is free', async () => {
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Token refresh',
      intent: 'fix it',
      isolate: true,
    });
    const task = getTask(db, created.taskId)!;
    expect(created.isolated).toBe(true);
    expect(created.isolatedBecause).toBeUndefined();
    expect(task.worktree_path).toBeTruthy();
    expect(task.branch).toBe('osade/token-refresh/claude');
    expect(task.checkout_ref).toBeNull();
  });

  it('checkoutRef puts an isolated lane on that existing branch, not an osade/ fork', async () => {
    sh(repo, ['branch', 'feat/review']);
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Address review',
      intent: 'fix the null case',
      isolate: true,
      checkoutRef: 'feat/review',
    });
    const task = getTask(db, created.taskId)!;
    expect(created.isolated).toBe(true);
    expect(task.branch).toBe('feat/review');
    expect(task.checkout_ref).toBe('feat/review');
    expect(task.branch.startsWith('osade/')).toBe(false);
  });

  it('checkoutRef on a remote-only ref creates the local name, not origin/…', async () => {
    const origin = join(dir, 'origin.git');
    sh(dir, ['clone', '-q', '--bare', 'repo', 'origin.git']);
    sh(repo, ['remote', 'add', 'origin', origin]);
    sh(repo, ['branch', 'feat/remote-only']);
    sh(repo, ['push', '-q', '-u', 'origin', 'feat/remote-only']);
    sh(repo, ['branch', '-D', 'feat/remote-only']);

    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Remote branch',
      intent: 'work it',
      isolate: true,
      checkoutRef: 'origin/feat/remote-only',
    });
    const task = getTask(db, created.taskId)!;
    expect(task.branch).toBe('feat/remote-only');
    expect(task.checkout_ref).toBe('feat/remote-only');
  });

  it('checkoutRef is ignored on an attached lane', async () => {
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Stay put',
      intent: 'hi',
      checkoutRef: 'feat/review',
    });
    const task = getTask(db, created.taskId)!;
    expect(created.isolated).toBe(false);
    expect(task.worktree_path).toBeNull();
    expect(task.branch).toBe('main');
    expect(task.checkout_ref).toBeNull();
  });
});

describe('the checkout you opened is the default', () => {
  it('attaches to feat/foo and does not check out main', async () => {
    sh(repo, ['checkout', '-q', '-b', 'feat/foo']);
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'New chat',
      intent: 'hi',
      baseRef: 'main',
    });
    const task = getTask(db, created.taskId)!;
    expect(created.isolated).toBe(false);
    expect(task.worktree_path).toBeNull();
    expect(task.branch).toBe('feat/foo');
    expect(task.base_ref).toBe('feat/foo');
    expect(task.base_sha).toBe(sh(repo, ['rev-parse', 'HEAD']));
    expect(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/foo');
  });

  it('an isolated lane without checkoutRef forks from HEAD, not the stored default branch', async () => {
    await launcher.createTask({ repoPath: repo, title: 'On main', intent: 'hold the checkout' });
    sh(repo, ['checkout', '-q', '-b', 'feat/foo']);
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Token refresh',
      intent: 'fix it',
      isolate: true,
    });
    const task = getTask(db, created.taskId)!;
    expect(task.branch).toMatch(/^osade\//);
    expect(task.base_ref).toBe('feat/foo');
    expect(task.base_sha).toBe(sh(repo, ['rev-parse', 'HEAD']));
    expect(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/foo');
  });
});

describe('multiple branches via worktrees', () => {
  it('two isolated lanes on two existing branches get two worktree.create calls', async () => {
    sh(repo, ['branch', 'feat/a']);
    sh(repo, ['branch', 'feat/b']);
    const creates: unknown[] = [];
    const client = {
      async request(method: string, params?: unknown): Promise<unknown> {
        if (method === 'worktree.create') {
          creates.push(params);
          const n = creates.length;
          return {
            workspace: { workspace_id: `w${n}` },
            root_pane: { pane_id: `w${n}:p1` },
          };
        }
        if (method === 'tab.create') {
          return { tab: { tab_id: 't' }, root_pane: { pane_id: 'p2' } };
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
    const launching = new LaunchTask(
      db,
      client,
      { watchPane() {}, unwatchPane() {} } as unknown as SubstrateEventSubscriber,
      { now: () => NOW },
    );
    const a = await launching.createTask({
      repoPath: repo,
      title: 'On A',
      intent: 'a',
      isolate: true,
      checkoutRef: 'feat/a',
    });
    const b = await launching.createTask({
      repoPath: repo,
      title: 'On B',
      intent: 'b',
      isolate: true,
      checkoutRef: 'feat/b',
    });
    await launching.launch(a.taskId);
    await launching.launch(b.taskId);
    expect(creates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: 'feat/a' }),
        expect.objectContaining({ branch: 'feat/b' }),
      ]),
    );
    expect(creates).toHaveLength(2);
    expect(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('two isolated lanes on two existing branches get two worktree paths', async () => {
    sh(repo, ['branch', 'feat/a']);
    sh(repo, ['branch', 'feat/b']);
    const a = await launcher.createTask({
      repoPath: repo,
      title: 'On A',
      intent: 'a',
      isolate: true,
      checkoutRef: 'feat/a',
    });
    const b = await launcher.createTask({
      repoPath: repo,
      title: 'On B',
      intent: 'b',
      isolate: true,
      checkoutRef: 'feat/b',
    });
    const ta = getTask(db, a.taskId)!;
    const tb = getTask(db, b.taskId)!;
    expect(ta.branch).toBe('feat/a');
    expect(tb.branch).toBe('feat/b');
    expect(ta.worktree_path).toBeTruthy();
    expect(tb.worktree_path).toBeTruthy();
    expect(ta.worktree_path).not.toBe(tb.worktree_path);
    expect(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });
});
