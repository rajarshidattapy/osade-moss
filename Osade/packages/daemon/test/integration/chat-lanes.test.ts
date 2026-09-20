import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isOrchestratorId } from '@osade/contract';

import { openDb, type Db } from '../../src/db/index.js';
import { getTask } from '../../src/db/task-repo.js';
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
  dir = mkdtempSync(join(tmpdir(), 'osade-lanes-'));
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

describe('chat lanes — createTask', () => {
  it('new chats are one-lane: chat_id equals the task id', async () => {
    const created = await launcher.createTask({
      repoPath: repo,
      title: 'Token refresh',
      intent: 'fix it',
    });
    const task = getTask(db, created.taskId)!;
    expect(task.chat_id).toBe(created.taskId);
    expect(created.isolated).toBe(false);
    expect(task.worktree_path).toBeNull();
    expect(task.branch).toBe('main');
  });

  it('a second lane reuses chat_id, slug and base_ref', async () => {
    const first = await launcher.createTask({
      repoPath: repo,
      title: 'Token refresh',
      intent: 'fix it',
      agentId: 'claude',
    });
    const second = await launcher.createTask({
      repoPath: repo,
      title: 'Token refresh',
      intent: 'tests',
      chatId: first.taskId,
      agentId: 'codex',
    });
    const a = getTask(db, first.taskId)!;
    const b = getTask(db, second.taskId)!;
    expect(b.chat_id).toBe(a.chat_id);
    expect(second.isolated).toBe(true);
    expect(b.branch).toBe('osade/token-refresh/codex');
    expect(b.agent_id).toBe('codex');
  });

  it('rejects an unknown agentId', async () => {
    await expect(
      launcher.createTask({
        repoPath: repo,
        title: 'x',
        intent: 'x',
        agentId: 'not-an-agent',
      }),
    ).rejects.toThrow(/unknown agent/i);
  });

  it('home: true reuses the plan chat and stays attached', async () => {
    const first = await launcher.createTask({
      repoPath: repo,
      title: 'Plan',
      intent: 'plan work',
      home: true,
    });
    const again = await launcher.createTask({
      repoPath: repo,
      title: 'Plan',
      intent: 'plan work',
      home: true,
    });
    expect(again.taskId).toBe(first.taskId);
    expect(again.isolated).toBe(false);
    const task = getTask(db, first.taskId)!;
    expect(task.worktree_path).toBeNull();
    expect(isOrchestratorId(task.chat_id)).toBe(true);
  });

  it('home: true stays attached even when another chat holds the checkout', async () => {
    await launcher.createTask({ repoPath: repo, title: 'One', intent: 'a' });
    const plan = await launcher.createTask({
      repoPath: repo,
      title: 'Plan',
      intent: 'plan work',
      home: true,
    });
    expect(plan.isolated).toBe(false);
    const task = getTask(db, plan.taskId)!;
    expect(task.worktree_path).toBeNull();
  });
});
