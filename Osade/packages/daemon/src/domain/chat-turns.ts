import { randomUUID } from 'node:crypto';

import type { ChatTurn } from '@osade/contract';

import type { Db } from '../db/index.js';
import { getAgentFact } from '../db/task-repo.js';
import { DEFAULT_READY_TIMEOUT_MS } from './agent-catalog.js';
import { paneDelta } from './pane-delta.js';

export type TurnPrompt = (taskId: string, text: string, wait: boolean) => Promise<void>;

const INSERT = `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const TURN_COLS = `id, task_id, seq, role, origin, text, delivery, created_at, error`;

const SURFACE_STRIP = [
  'esc to interrupt',
  'press enter to continue',
  '^•',
  'token usage',
  'gpt-\\d',
  '^❯',
  '^›',
];

export function listTurns(db: Db, taskId: string): ChatTurn[] {
  return (
    db
      .prepare(
        `SELECT ${TURN_COLS}
           FROM chat_turn WHERE task_id = ? ORDER BY seq ASC`,
      )
      .all(taskId) as ChatTurn[]
  ).map(normalizeTurn);
}

export function copyTurns(db: Db, fromTaskId: string, toTaskId: string): void {
  for (const turn of listTurns(db, fromTaskId)) {
    insertRow(db, {
      taskId: toTaskId,
      seq: turn.seq,
      role: turn.role,
      origin: turn.origin,
      text: turn.text,
      delivery: turn.delivery === 'sending' ? 'accepted' : turn.delivery,
      now: turn.created_at,
    });
  }
}

export function composerReady(db: Db, taskId: string): boolean {
  const fact = getAgentFact(db, taskId);
  return fact?.composer_ready === true && fact.substrate_pane_id != null;
}

export function turnInFlight(db: Db, taskId: string): boolean {
  const sending = db
    .prepare(`SELECT 1 FROM chat_turn WHERE task_id = ? AND delivery = 'sending' LIMIT 1`)
    .get(taskId);
  if (sending) return true;
  const fact = getAgentFact(db, taskId);
  return fact?.substrate_state === 'working' || fact?.substrate_state === 'blocked';
}

export function readyFailMessage(agentId: string, waitingFor = 'an idle composer'): string {
  return `${agentId} never became ready — waiting for ${waitingFor}`;
}

export function surfaceAfter(before: string, after: string): string {
  return paneDelta(before, after, '');
}

export function enqueueTurn(
  db: Db,
  input: { taskId: string; text: string; origin: ChatTurn['origin']; now: number },
): ChatTurn {
  const text = input.text.trim();
  if (text.length === 0) throw new Error('Write something to send');

  return db.transaction(() => {
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM chat_turn WHERE task_id = ?').get(input.taskId) as {
        n: number;
      }
    ).n;
    if (count === 0) {
      const intent = (
        db.prepare('SELECT intent FROM task WHERE id = ?').get(input.taskId) as
          | { intent: string }
          | undefined
      )?.intent?.trim();
      if (intent && intent !== text) {
        insertRow(db, {
          taskId: input.taskId,
          seq: 1,
          role: 'user',
          origin: 'human',
          text: intent,
          delivery: 'accepted',
          now: input.now,
        });
      }
    }
    const seq =
      (
        db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_turn WHERE task_id = ?').get(
          input.taskId,
        ) as { seq: number }
      ).seq + 1;
    return insertRow(db, {
      taskId: input.taskId,
      seq,
      role: 'user',
      origin: input.origin,
      text,
      delivery: 'queued',
      now: input.now,
    });
  })();
}

export async function dispatchQueued(
  db: Db,
  prompt: TurnPrompt,
  taskId: string,
  wait = false,
  now = Date.now(),
  options: { readyTimeoutMs?: number; agentId?: string } = {},
): Promise<void> {
  const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const agentId = options.agentId ?? 'agent';

  for (;;) {
    const next = db.transaction(() => {
      if (!composerReady(db, taskId)) {
        failStaleQueued(db, taskId, now, timeoutMs, readyFailMessage(agentId));
        return null;
      }
      if (turnInFlight(db, taskId)) return null;
      const row = db
        .prepare(
          `SELECT id, text FROM chat_turn
             WHERE task_id = ? AND role = 'user' AND delivery = 'queued'
             ORDER BY seq ASC LIMIT 1`,
        )
        .get(taskId) as { id: string; text: string } | undefined;
      if (!row) return null;
      setDelivery(db, row.id, 'sending');
      return row;
    })();
    if (!next) return;
    try {
      await prompt(taskId, next.text, wait);
      setDelivery(db, next.id, 'accepted');
    } catch (err) {
      setDelivery(db, next.id, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
    const fact = getAgentFact(db, taskId);
    if (fact?.substrate_state === 'done' || fact?.substrate_state === 'blocked') {
      settleAgentReply(db, taskId, now);
      continue;
    }
    return;
  }
}

export async function sendTurn(
  db: Db,
  prompt: TurnPrompt,
  input: {
    taskId: string;
    text: string;
    origin: ChatTurn['origin'];
    now: number;
    wait?: boolean;
    readyTimeoutMs?: number;
    agentId?: string;
  },
): Promise<ChatTurn> {
  const turn = enqueueTurn(db, input);
  await dispatchQueued(db, prompt, input.taskId, input.wait === true, input.now, {
    readyTimeoutMs: input.readyTimeoutMs,
    agentId: input.agentId,
  });
  const stored = db
    .prepare(`SELECT ${TURN_COLS} FROM chat_turn WHERE id = ?`)
    .get(turn.id) as ChatTurn;
  return normalizeTurn(stored);
}

/** After a turn settles (`done` / `blocked` / `idle`), persist the agent's last words. */
export function settleAgentReply(
  db: Db,
  taskId: string,
  now: number,
  opts?: { surface?: string | null; body?: string | null },
): ChatTurn | null {
  const lastUser = db
    .prepare(
      `SELECT seq, text FROM chat_turn
         WHERE task_id = ? AND role = 'user' AND delivery = 'accepted'
         ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId) as { seq: number; text: string } | undefined;
  if (!lastUser) return null;

  const laterAgent = db
    .prepare(
      `SELECT 1 FROM chat_turn WHERE task_id = ? AND role = 'agent' AND seq > ? LIMIT 1`,
    )
    .get(taskId, lastUser.seq);
  if (laterAgent) return null;

  const fact = getAgentFact(db, taskId);
  const text = settleBody(opts, fact?.final_message ?? null, fact?.activity_text ?? null, lastUser.text);
  if (text.length === 0) return null;

  const lastAgent = db
    .prepare(
      `SELECT text FROM chat_turn WHERE task_id = ? AND role = 'agent' ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId) as { text: string } | undefined;
  if (lastAgent?.text === text) return null;

  return db.transaction(() => {
    const later = db
      .prepare(
        `SELECT id, seq FROM chat_turn WHERE task_id = ? AND seq > ? ORDER BY seq DESC`,
      )
      .all(taskId, lastUser.seq) as { id: string; seq: number }[];
    for (const row of later) {
      db.prepare('UPDATE chat_turn SET seq = ? WHERE id = ?').run(row.seq + 1, row.id);
    }
    return insertRow(db, {
      taskId,
      seq: lastUser.seq + 1,
      role: 'agent',
      origin: 'provider',
      text,
      delivery: 'accepted',
      now,
    });
  })();
}

export function failUnreadyTurns(
  db: Db,
  taskId: string,
  agentId: string,
  waitingFor: string,
  now: number,
): void {
  failOpenTurns(db, taskId, readyFailMessage(agentId, waitingFor), now);
}

/** Fail queued/sending turns, and the last accepted user turn that never got a reply. */
export function failOpenTurns(db: Db, taskId: string, message: string, now: number): void {
  const open = db
    .prepare(
      `SELECT id FROM chat_turn WHERE task_id = ? AND role = 'user' AND delivery IN ('queued', 'sending')`,
    )
    .all(taskId) as { id: string }[];
  const ids = new Set(open.map((row) => row.id));
  const lastUser = db
    .prepare(
      `SELECT id, seq, delivery FROM chat_turn
         WHERE task_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId) as { id: string; seq: number; delivery: string } | undefined;
  if (lastUser?.delivery === 'accepted') {
    const laterAgent = db
      .prepare(`SELECT 1 FROM chat_turn WHERE task_id = ? AND role = 'agent' AND seq > ? LIMIT 1`)
      .get(taskId, lastUser.seq);
    if (!laterAgent) ids.add(lastUser.id);
  }
  if (ids.size === 0) return;
  db.transaction(() => {
    for (const id of ids) setDelivery(db, id, 'failed', message);
    const seq =
      (
        db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_turn WHERE task_id = ?').get(taskId) as {
          seq: number;
        }
      ).seq + 1;
    insertRow(db, {
      taskId,
      seq,
      role: 'agent',
      origin: 'provider',
      text: message,
      delivery: 'accepted',
      now,
    });
  })();
}

export function failStaleQueued(
  db: Db,
  taskId: string,
  now: number,
  timeoutMs: number,
  message: string,
): void {
  const rows = db
    .prepare(
      `SELECT id, created_at FROM chat_turn
         WHERE task_id = ? AND role = 'user' AND delivery = 'queued'`,
    )
    .all(taskId) as { id: string; created_at: number }[];
  for (const row of rows) {
    if (now - row.created_at >= timeoutMs) setDelivery(db, row.id, 'failed', message);
  }
}

function settleBody(
  opts: { surface?: string | null; body?: string | null } | undefined,
  finalMessage: string | null,
  activityText: string | null,
  userText: string,
): string {
  if (opts?.body != null) return opts.body.trim();
  if (opts?.surface != null) {
    return paneDelta('', opts.surface, userText, SURFACE_STRIP);
  }
  return settleText(finalMessage, activityText);
}

function settleText(finalMessage: string | null, activityText: string | null): string {
  const final = finalMessage?.trim() ?? '';
  if (final.length > 0) return final;
  const activity = activityText?.trim() ?? '';
  if (activity.length === 0) return '';
  if (/^claude(?:\s+code)?$/iu.test(activity)) return '';
  return activity;
}

function setDelivery(db: Db, id: string, delivery: ChatTurn['delivery'], error?: string | null): void {
  db.prepare('UPDATE chat_turn SET delivery = ?, error = ? WHERE id = ?').run(
    delivery,
    error ?? null,
    id,
  );
}

function insertRow(
  db: Db,
  row: {
    taskId: string;
    seq: number;
    role: ChatTurn['role'];
    origin: ChatTurn['origin'];
    text: string;
    delivery: ChatTurn['delivery'];
    now: number;
  },
): ChatTurn {
  const id = `ct_${randomUUID().slice(0, 8)}`;
  db.prepare(INSERT).run(id, row.taskId, row.seq, row.role, row.origin, row.text, row.delivery, row.now);
  return {
    id,
    task_id: row.taskId,
    seq: row.seq,
    role: row.role,
    origin: row.origin,
    text: row.text,
    delivery: row.delivery,
    created_at: row.now,
    error: null,
  };
}

function normalizeTurn(row: ChatTurn): ChatTurn {
  return { ...row, error: row.error ?? null };
}
