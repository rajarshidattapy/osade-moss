import type { ChatTurn, TaskView } from '@osade/contract';

export interface ChatLine {
  id: string;
  role: 'user' | 'agent';
  agentId: string;
  text: string;
  live: boolean;
  held?: boolean;
  failed?: boolean;
}

/** Strip the sibling-lane digest so it never shows up as a chat bubble. */
export function visibleUserText(text: string): string {
  return text
    .replace(/<osade_lanes>[\s\S]*?<\/osade_lanes>\s*/g, '')
    .replace(/```photos\n[\s\S]*?```\s*/g, (block) => {
      const n = block
        .split('\n')
        .filter((line) => line.length > 0 && !line.startsWith('```')).length;
      return n > 0 ? `(${n} ${n === 1 ? 'photo' : 'photos'})\n` : '';
    })
    .replace(/The user pasted these photos\. Open each file and look at it\.\s*/g, '')
    .trim();
}

/**
 * Chat turns from the daemon's durable timeline — never from a pane scrape.
 *
 * A live agent line is overlaid from agent_fact while a turn is in flight; settled replies
 * are stored as agent turns when the pane goes quiet.
 */
export function chatLines(task: TaskView, followUps: readonly string[] = []): ChatLine[] {
  const agentId = task.agentId || 'claude';
  const turns = [...(task.turns ?? [])].sort((a, b) => a.seq - b.seq);
  const lines: ChatLine[] = [];

  if (turns.length === 0) {
    const intent = visibleUserText(task.task.intent);
    if (intent) {
      lines.push({ id: `${task.task.id}-intent`, role: 'user', agentId, text: intent, live: false });
    }
    for (let i = 0; i < followUps.length; i++) {
      const text = visibleUserText(followUps[i] ?? '');
      if (!text || text === intent) continue;
      lines.push({
        id: `${task.task.id}-follow-${i}`,
        role: 'user',
        agentId,
        text,
        live: false,
        held: true,
      });
    }
    const live = agentOverlay(task);
    if (live) lines.push(live);
    return lines;
  }

  for (const turn of turns) {
    const text = turn.role === 'user' ? visibleUserText(turn.text) : turn.text.trim();
    if (!text) continue;
    lines.push(lineFromTurn(turn, agentId, text));
  }

  const seen = new Set(lines.filter((l) => l.role === 'user').map((l) => l.text));
  for (let i = 0; i < followUps.length; i++) {
    const text = visibleUserText(followUps[i] ?? '');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push({
      id: `${task.task.id}-follow-${i}`,
      role: 'user',
      agentId,
      text,
      live: false,
      held: true,
    });
  }

  const lastTurn = turns.at(-1);
  const lastLine = lines.at(-1);
  const overlay =
    lastTurn?.role === 'user' || lastLine?.held ? agentOverlay(task) : lastTurn == null ? agentOverlay(task) : null;
  if (overlay && lastLine?.role === 'agent' && lastLine.text === overlay.text) return lines;
  if (overlay) lines.push(overlay);
  return lines;
}

function lineFromTurn(turn: ChatTurn, agentId: string, text: string): ChatLine {
  const failed = turn.delivery === 'failed';
  return {
    id: turn.id,
    role: turn.role,
    agentId,
    text: failed && turn.error ? `${text}\n${turn.error}` : text,
    live: turn.delivery === 'sending',
    held: turn.delivery === 'queued',
    failed,
  };
}

function agentOverlay(task: TaskView): ChatLine | null {
  const agentId = task.agentId || 'claude';
  const fact = task.agent;
  const final = fact?.final_message?.trim();
  if (final) {
    return { id: `${task.task.id}-agent-live`, role: 'agent', agentId, text: final, live: false };
  }
  const lastUser = [...(task.turns ?? [])].filter((t) => t.role === 'user').at(-1);
  const waiting =
    fact?.composer_ready !== true &&
    task.status !== 'implementing' &&
    task.status !== 'verifying' &&
    (lastUser?.delivery === 'queued' || ((task.turns ?? []).length === 0 && task.status === 'queued'));
  if (waiting) {
    return {
      id: `${task.task.id}-starting`,
      role: 'agent',
      agentId,
      text: `starting ${agentId}`,
      live: true,
    };
  }
  const working = task.status === 'implementing' || task.status === 'verifying' || task.status === 'queued';
  if (working) {
    const tool = fact?.tool_name?.trim();
    const activity = workingLabel(fact?.activity_text ?? '', agentId);
    const parts = [activity, tool ? `Using ${tool}` : ''].filter(Boolean);
    return {
      id: `${task.task.id}-agent-live`,
      role: 'agent',
      agentId,
      text: parts.join('\n'),
      live: true,
    };
  }
  if (task.status === 'needs_input') {
    return {
      id: `${task.task.id}-agent-live`,
      role: 'agent',
      agentId,
      text: workingLabel(fact?.activity_text ?? '', agentId) || 'Waiting for you.',
      live: false,
    };
  }
  return null;
}

function workingLabel(activity: string, agentId: string): string {
  const t = activity.trim();
  if (!t) return '…';
  if (t.toLowerCase() === (agentId || 'claude').toLowerCase()) return '…';
  if (/^claude(?:\s+code)?$/iu.test(t)) return '…';
  return t;
}
