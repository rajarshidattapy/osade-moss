import type { TaskView } from '@osade/contract';
import { isNeedsYou } from '@osade/contract';

import type { Db } from '../db/index.js';
import { getTaskFacts } from '../db/task-repo.js';
import { DAEMON_DEFAULT_AGENT } from './agent-catalog.js';
import { isAttached, taskCwd } from './cwd.js';
import { deriveStatus } from './derive-status.js';
import { listTurns } from './chat-turns.js';

export function toTaskView(db: Db, taskId: string, now: number): TaskView | null {
  const facts = getTaskFacts(db, taskId);
  if (!facts) return null;
  const status = deriveStatus(facts, now);
  const repo = db.prepare('SELECT default_agent, path FROM repo WHERE id = ?').get(facts.task.repo_id) as
    | { default_agent: string | null; path: string }
    | undefined;
  const attachment = isAttached(facts.task) ? 'repo' as const : 'worktree' as const;
  return {
    task: facts.task,
    status,
    agent: facts.agent,
    scm: facts.scm,
    openGates: facts.openGates,
    latestVerifyRuns: facts.verifyRuns,
    needsYou: isNeedsYou(status),
    chatId: facts.task.chat_id,
    agentId: facts.task.agent_id ?? repo?.default_agent ?? DAEMON_DEFAULT_AGENT,
    attachment,
    branch: facts.task.branch,
    cwd: repo ? taskCwd(facts.task, repo.path) : facts.task.worktree_path ?? '',
    turns: listTurns(db, taskId),
  };
}
