import { describe, expect, it } from 'vitest';

import type { ChatTurn, TaskView } from '@osade/contract';

import { chatLines, visibleUserText } from '../src/renderer/chat.js';
import { lanePhase, startingLine } from '../src/renderer/delivery.js';

describe('visibleUserText', () => {
  it('drops the sibling-lane digest', () => {
    expect(
      visibleUserText('<osade_lanes>\n- codex on osade/x/codex: working\n</osade_lanes>\n\nreal work'),
    ).toBe('real work');
  });

  it('collapses pasted photos to a count', () => {
    expect(
      visibleUserText(
        '```photos\n/a.png\n/b.png\n```\n\nThe user pasted these photos. Open each file and look at it.\n\nwhat is this?',
      ),
    ).toBe('(2 photos)\nwhat is this?');
  });
});

describe('chatLines', () => {
  it('is a user bubble plus a live agent line, never a terminal dump', () => {
    const lines = chatLines(
      view({
        intent: 'Retry the flaky poller test',
        status: 'implementing',
        activity: 'Editing retry.ts',
      }),
    );
    expect(lines.map((l) => l.role)).toEqual(['user', 'agent']);
    expect(lines[0]!.text).toBe('Retry the flaky poller test');
    expect(lines[1]!.text).toBe('Editing retry.ts');
    expect(lines[1]!.live).toBe(true);
    expect(lines.some((l) => l.text.includes('\x1b[') || l.text.includes('claude --'))).toBe(false);
  });

  it('keeps a follow-up that is not the original intent', () => {
    const lines = chatLines(view({ intent: 'first', status: 'implementing', activity: 'Working' }), [
      'first',
      'also write tests',
    ]);
    expect(lines.filter((l) => l.role === 'user').map((l) => l.text)).toEqual(['first', 'also write tests']);
    expect(lines.find((l) => l.text === 'also write tests')?.held).toBe(true);
  });

  it('uses the agent final_message when there is one', () => {
    const lines = chatLines(
      view({ intent: 'ping', status: 'awaiting_review', final: 'PONG' }),
    );
    expect(lines.at(-1)).toMatchObject({ role: 'agent', text: 'PONG', live: false });
  });

  it('does not invent a status-label reply when the agent is done', () => {
    const lines = chatLines(view({ intent: 'list the files', status: 'awaiting_review' }));
    expect(lines.map((l) => l.role)).toEqual(['user']);
    expect(lines[0]!.text).toBe('list the files');
  });

  it('is user, reply, user, reply from durable turns — not a pane scrape', () => {
    const lines = chatLines(
      view({
        intent: 'list the files',
        status: 'awaiting_review',
        turns: [
          turn(1, 'user', 'list the files'),
          turn(2, 'agent', 'README.md\npackage.json'),
          turn(3, 'user', 'show the files present, list them down'),
          turn(4, 'agent', 'src/main.ts'),
        ],
      }),
    );
    expect(lines.map((l) => ({ role: l.role, text: l.text }))).toEqual([
      { role: 'user', text: 'list the files' },
      { role: 'agent', text: 'README.md\npackage.json' },
      { role: 'user', text: 'show the files present, list them down' },
      { role: 'agent', text: 'src/main.ts' },
    ]);
  });

  it('shows a queued follow-up as held', () => {
    const lines = chatLines(
      view({
        intent: 'first',
        status: 'implementing',
        activity: 'Working',
        turns: [turn(1, 'user', 'first'), { ...turn(2, 'user', 'also write tests'), delivery: 'queued' }],
      }),
    );
    expect(lines.find((l) => l.text === 'also write tests')).toMatchObject({ held: true, live: false });
  });

  it('shows a starting line while the composer is not ready', () => {
    const lines = chatLines(
      view({
        intent: 'write tests',
        status: 'queued',
        turns: [{ ...turn(1, 'user', 'write tests'), delivery: 'queued' }],
      }),
    );
    expect(lines.find((l) => l.role === 'agent')?.text).toBe('starting claude');
  });

  it('surfaces a failed delivery in the transcript with the error', () => {
    const lines = chatLines(
      view({
        intent: 'write tests',
        status: 'queued',
        turns: [
          { ...turn(1, 'user', 'write tests'), delivery: 'failed' },
          turn(2, 'agent', 'codex never became ready (waiting for idle composer).'),
        ],
      }),
    );
    expect(lines.find((l) => l.role === 'user')).toMatchObject({ text: 'write tests', failed: true });
    expect(lines.find((l) => l.role === 'agent')?.text).toMatch(/never became ready/);
  });
});

describe('lanePhase', () => {
  it('is starting before createTask returns', () => {
    expect(lanePhase(null, { chatId: 'c1', agentId: 'codex', prompt: 'x', phase: 'starting' })).toBe(
      'starting',
    );
    expect(startingLine('codex')).toBe('starting codex');
  });

  it('is starting while a queued send waits for an idle composer', () => {
    expect(
      lanePhase(
        view({
          intent: 'write tests',
          status: 'queued',
          turns: [{ ...turn(1, 'user', 'write tests'), delivery: 'queued' }],
        }),
      ),
    ).toBe('starting');
  });
});

function turn(seq: number, role: ChatTurn['role'], text: string): ChatTurn {
  return {
    id: `ct_${seq}`,
    task_id: 't1',
    seq,
    role,
    origin: role === 'user' ? 'human' : 'provider',
    text,
    delivery: 'accepted',
    created_at: seq,
  };
}

function view(over: {
  intent?: string;
  status?: TaskView['status'];
  activity?: string;
  final?: string;
  turns?: ChatTurn[];
}): TaskView {
  return {
    task: {
      id: 't1',
      repo_id: 'r1',
      chat_id: 'c1',
      title: 'Token refresh',
      intent: over.intent ?? 'x',
      origin_kind: 'manual',
      origin_ref: null,
      agent_id: 'claude',
      base_ref: 'main',
      base_sha: 'abc',
      branch: 'osade/token-refresh/claude',
      worktree_path: '/wt',
      substrate_workspace_id: null,
      archived_at: null,
      created_at: 1,
    },
    status: over.status ?? 'queued',
    agent:
      over.activity == null && over.final == null
        ? null
        : {
            task_id: 't1',
            substrate_pane_id: null,
            substrate_state: 'working',
            last_event: 'activity',
            last_event_at: 1,
            activity_text: over.activity ?? null,
            tool_name: null,
            final_message: over.final ?? null,
            agent_session_id: null,
            pane_alive: true,
            last_probe_at: null,
            probe_failures: 0,
            terminated: false,
            external_block: null,
            state_change_seq: 1,
            controller_generation: 0,
          },
    scm: null,
    openGates: [],
    latestVerifyRuns: [],
    needsYou: false,
    chatId: 'c1',
    agentId: 'claude',
    attachment: 'worktree',
    branch: 'osade/token-refresh/claude',
    cwd: '/wt',
    turns: over.turns,
  };
}
