import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';

import type { TaskView } from '@osade/contract';

import { agentColor } from './agent-color.js';
import { chatLines, type ChatLine } from './chat.js';

/** Optimistic follow-ups until the daemon's turn row arrives over CDC. */
const followUpsByTask = new Map<string, string[]>();

/**
 * Chat for one or more lanes: your text, then the agent's reply, repeating.
 *
 * Bubbles come from the daemon's durable `turns` timeline — never from a pane scrape.
 */
export function Transcript({
  tasks,
  extraUser,
  followTaskId,
  isolatedNotice,
}: {
  tasks: TaskView[];
  extraUser?: string;
  followTaskId?: string;
  isolatedNotice?: string;
}): JSX.Element {
  const [, bump] = useState(0);

  useEffect(() => {
    const text = extraUser?.trim();
    const id = followTaskId;
    if (!text || !id) return;
    const prev = followUpsByTask.get(id) ?? [];
    if (prev.includes(text)) return;
    followUpsByTask.set(id, [...prev, text]);
    bump((n) => n + 1);
  }, [extraUser, followTaskId]);

  if (tasks.length === 0 && !extraUser) {
    return (
      <div>
        {isolatedNotice && (
          <p style={{ margin: '0 0 10px', color: 'var(--ink-2)', fontSize: 'var(--t-s)' }}>
            {isolatedNotice}
          </p>
        )}
        <p style={{ margin: 0, color: 'var(--ink-3)', fontSize: 'var(--t-s)' }}>
          Nothing here yet. Write below to start this chat.
        </p>
      </div>
    );
  }

  const lanes =
    tasks.length === 0
      ? [
          {
            id: 'draft',
            agentId: 'claude',
            lines: extraUser
              ? [
                  {
                    id: 'draft',
                    role: 'user' as const,
                    agentId: 'claude',
                    text: extraUser,
                    live: false,
                  },
                ]
              : [],
          },
        ]
      : tasks.map((task) => ({
          id: task.task.id,
          agentId: task.agentId,
          lines: chatLines(task, followUpsByTask.get(task.task.id) ?? []),
        }));

  const token = lanes.flatMap((l) => l.lines).map((l) => `${l.id}:${l.text.length}`).join('|');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: '38em' }}>
      {isolatedNotice && (
        <p style={{ margin: 0, color: 'var(--ink-2)', fontSize: 'var(--t-s)' }}>{isolatedNotice}</p>
      )}
      {lanes.map((lane) => (
        <section key={lane.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lanes.length > 1 && lane.agentId && (
            <div
              className="mono"
              style={{ fontSize: 'var(--t-xs)', color: agentColor(lane.agentId), paddingLeft: 2 }}
            >
              {lane.agentId}
            </div>
          )}
          {lane.lines.map((line) => (
            <Bubble key={line.id} line={line} />
          ))}
        </section>
      ))}
      <ScrollAnchor token={token} />
    </div>
  );
}

function ScrollAnchor({ token }: { token: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    const scroller = node?.closest('[data-chat-scroll]') as HTMLElement | null;
    if (!scroller) {
      node?.scrollIntoView({ block: 'end' });
      return;
    }
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (gap < 96) scroller.scrollTop = scroller.scrollHeight;
  }, [token]);
  return <div ref={ref} />;
}

function Bubble({ line }: { line: ChatLine }): JSX.Element {
  const colour = agentColor(line.agentId);
  const mine = line.role === 'user';
  const mark = line.failed ? ' · failed' : line.live ? ' · working' : line.held ? ' · held' : '';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        gap: 3,
      }}
    >
      <span className="mono" style={{ fontSize: 'var(--t-xs)', color: mine ? 'var(--ink-3)' : colour }}>
        {mine ? 'You' : line.agentId}
        {mark}
      </span>
      <div
        style={{
          ...bodyStyle,
          background: mine ? 'var(--bg-2)' : 'var(--bg-1)',
          border: '0.5px solid var(--line)',
          borderLeft: mine ? '0.5px solid var(--line)' : `2px solid ${line.failed ? 'var(--st-fail)' : colour}`,
          opacity: line.held ? 0.7 : 1,
          color: line.failed ? 'var(--st-fail)' : undefined,
          padding: '8px 12px',
          borderRadius: 'var(--radius)',
          maxWidth: 'min(100%, 32em)',
        }}
      >
        {line.text}
      </div>
    </div>
  );
}

const bodyStyle: CSSProperties = {
  fontSize: 'var(--t-m)',
  lineHeight: 1.5,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
