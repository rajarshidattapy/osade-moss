import type { ChatTurn, TaskView } from '@osade/contract';

export type LanePhase = 'starting' | 'queued' | 'sending' | 'working' | 'failed';

export interface PendingLane {
  chatId: string;
  agentId: string;
  prompt: string;
  phase: 'starting' | 'failed';
  error?: string;
}

export function lastUserTurn(task: TaskView): ChatTurn | undefined {
  const turns = task.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'user') return turns[i];
  }
  return undefined;
}

export function lanePhase(task: TaskView | null, pending?: PendingLane | null): LanePhase | null {
  if (pending?.phase === 'starting') return 'starting';
  if (pending?.phase === 'failed') return 'failed';
  if (task == null) return null;
  const last = lastUserTurn(task);
  if (last?.delivery === 'failed') return 'failed';
  if (last?.delivery === 'sending') return 'sending';
  if (task.status === 'implementing' || task.status === 'verifying') return 'working';
  if (last?.delivery === 'queued') {
    return task.agent?.composer_ready === true ? 'queued' : 'starting';
  }
  if (task.agent?.composer_ready !== true && task.status === 'queued') return 'starting';
  return null;
}

export function startingLine(agentId: string): string {
  return `starting ${agentId}`;
}
