import type { CatchUpItem, CatchUpResult } from '@osade/contract';

import type { Db } from '../db/index.js';
import { paddedAt } from '../retrieval/projectors.js';
import type { RetrievalService } from '../retrieval/service.js';

/**
 * Catch-up and ask-history — OSADE-MOSS §M.6.5.
 *
 * What a teammate needs on rejoining is not "the last 40 messages". It is *what happened that
 * matters*: what was decided, what failed, what someone redirected. So this is a retrieval
 * query over `turns` — except for the part that must never depend on ranking.
 *
 * **Gate decisions and verify failures are fetched by exact filter, not by similarity.** A
 * catch-up that silently omitted "Priya rejected the PR" because a relevance score put it
 * eleventh would be worse than no catch-up at all, since the reader would believe they had
 * seen everything. Ranking fills the remaining budget; it never decides what is important.
 *
 * **No LLM synthesis.** The answer *is* the cited hits, rendered as a list — which is what
 * makes it instant and non-hallucinating. §M.6.5's optional "Summarise" button runs a headless
 * agent over exactly those hits and labels its output as a summary, rather than quietly
 * replacing the evidence with prose about it.
 */

export interface CatchUpOptions {
  readonly now?: () => number;
  /** §M.6.5 — at most twelve items, so rejoining is a glance rather than a reading session. */
  readonly topK?: number;
}

const DEFAULT_TOP_K = 12;

/** The fixed prompt §M.6.5 specifies. Not user input: the question is always the same one. */
const CATCH_UP_QUERY = 'decisions, failures, approvals, redirections';

export class CatchUp {
  readonly #db: Db;
  readonly #retrieval: RetrievalService | null;
  readonly #now: () => number;
  readonly #topK: number;

  constructor(db: Db, retrieval: RetrievalService | null, options: CatchUpOptions = {}) {
    this.#db = db;
    this.#retrieval = retrieval;
    this.#now = options.now ?? Date.now;
    this.#topK = options.topK ?? DEFAULT_TOP_K;
  }

  /**
   * What changed in a chat since this member last looked.
   *
   * Advancing the cursor is part of reading: calling this twice in a row returns nothing the
   * second time, which is the behaviour that makes "since you left" mean anything.
   */
  async since(login: string, chatId: string): Promise<CatchUpResult> {
    const started = performance.now();
    const cursor = this.#cursor(login, chatId);

    // The guaranteed half: every gate decision and verify failure in the window, by filter.
    const guaranteed = this.#important(chatId, cursor);

    // The ranked half fills whatever budget is left.
    const room = Math.max(0, this.#topK - guaranteed.length);
    const ranked = room > 0 ? await this.#ranked(chatId, cursor, room) : [];

    const seen = new Set(guaranteed.map((item) => item.src_id));
    const items = [...guaranteed, ...ranked.filter((item) => !seen.has(item.src_id))];

    const head = this.#head(chatId);
    this.#advance(login, chatId, head);

    return {
      chat_id: chatId,
      since_seq: cursor,
      items: items.slice(0, this.#topK),
      backend: this.#retrieval?.backend ?? 'fts5',
      retrieval_ms: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  /**
   * §M.6.5 — a free-text question over the chat's history.
   *
   * Returns cited hits, never a synthesised answer. The citation is the product.
   */
  async ask(chatId: string, question: string, limit = 10): Promise<CatchUpItem[]> {
    if (!this.#retrieval) return [];
    const hits = await this.#retrieval.query('turns', question, {
      topK: limit,
      filter: [{ field: 'chat_id', condition: { $eq: chatId } }],
    });
    return hits.map((hit) => toItem(hit.meta, hit.text, hit.score)).filter(isPresent);
  }

  /**
   * The events that are never left to ranking.
   *
   * Read straight from the fact tables rather than the index, so a lagging or degraded index
   * cannot drop them. This is the half a teammate is relying on being complete.
   */
  #important(chatId: string, sinceSeq: number): CatchUpItem[] {
    const gates = this.#db
      .prepare(
        `SELECT g.id, g.gate, g.decision, g.decided_by, g.decided_at, g.task_id
           FROM gate_request g JOIN task t ON t.id = g.task_id
          WHERE t.chat_id = ? AND g.decided_at IS NOT NULL AND g.decided_at > ?
          ORDER BY g.decided_at ASC`,
      )
      .all(chatId, sinceSeq) as {
      id: string;
      gate: string;
      decision: string | null;
      decided_by: string | null;
      decided_at: number;
      task_id: string;
    }[];

    const failures = this.#db
      .prepare(
        `SELECT v.id, v.step_name, v.cmd, v.exit_code, v.finished_at, v.task_id, v.head_sha
           FROM verify_run v JOIN task t ON t.id = v.task_id
          WHERE t.chat_id = ? AND v.finished_at > ? AND v.exit_code IS NOT NULL AND v.exit_code != 0
          ORDER BY v.finished_at ASC`,
      )
      .all(chatId, sinceSeq) as {
      id: string;
      step_name: string;
      cmd: string;
      exit_code: number;
      finished_at: number;
      task_id: string;
      head_sha: string;
    }[];

    return [
      ...gates.map((gate) => ({
        kind: gate.decision === 'approve' ? ('gate.approved' as const) : ('gate.rejected' as const),
        src_table: 'gate_request',
        src_id: gate.id,
        task_id: gate.task_id,
        text: `${gate.gate} was ${gate.decision ?? 'decided'} by ${gate.decided_by ?? 'someone'}`,
        at: gate.decided_at,
        score: null,
        guaranteed: true,
      })),
      ...failures.map((run) => ({
        kind: 'verify.fail' as const,
        src_table: 'verify_run',
        src_id: run.id,
        task_id: run.task_id,
        text: `${run.step_name} (${run.cmd}) failed with exit ${run.exit_code} at ${run.head_sha.slice(0, 8)}`,
        at: run.finished_at,
        score: null,
        guaranteed: true,
      })),
    ].sort((a, b) => a.at - b.at);
  }

  /**
   * The ranked half, then a recency fill.
   *
   * Ranking alone is not enough, and the FTS5 backend makes that obvious: the fixed prompt
   * shares no tokens with "we decided to keep the wrapper signature stable", so a purely ranked
   * catch-up returns *nothing* for a chat full of activity. A teammate who has been away for an
   * hour and is told "nothing to see" has been actively misinformed.
   *
   * So relevance orders the window; recency guarantees it is not empty. On Moss the ranked half
   * does most of the work and the fill rarely shows; on FTS5 the fill carries it. Either way
   * the promise is the same: everything important, then what else happened.
   */
  async #ranked(chatId: string, sinceMs: number, limit: number): Promise<CatchUpItem[]> {
    const items: CatchUpItem[] = [];
    const seen = new Set<string>();

    if (this.#retrieval) {
      const hits = await this.#retrieval.query('turns', CATCH_UP_QUERY, {
        topK: limit * 2,
        filter: [
          { field: 'chat_id', condition: { $eq: chatId } },
          // §M.1.5 — `at` is zero-padded epoch seconds, so a lexical `$gt` is numeric order.
          { field: 'at', condition: { $gt: paddedAt(sinceMs) } },
        ],
      });
      for (const hit of hits) {
        const item = toItem(hit.meta, hit.text, hit.score);
        if (!item || seen.has(item.src_id)) continue;
        seen.add(item.src_id);
        items.push(item);
        if (items.length >= limit) return items;
      }
    }

    for (const turn of this.#recentTurns(chatId, sinceMs, limit - items.length + seen.size)) {
      if (seen.has(turn.src_id)) continue;
      seen.add(turn.src_id);
      items.push(turn);
      if (items.length >= limit) break;
    }
    return items;
  }

  /** Straight from the fact table, so an empty or degraded index cannot hide activity. */
  #recentTurns(chatId: string, sinceMs: number, limit: number): CatchUpItem[] {
    if (limit <= 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT ct.id, ct.text, ct.created_at, ct.role, ct.task_id
           FROM chat_turn ct JOIN task t ON t.id = ct.task_id
          WHERE t.chat_id = ? AND ct.created_at > ? AND ct.delivery = 'accepted'
          ORDER BY ct.created_at DESC
          LIMIT ?`,
      )
      .all(chatId, sinceMs, limit) as {
      id: string;
      text: string;
      created_at: number;
      role: string;
      task_id: string;
    }[];

    return rows.map((row) => ({
      kind: row.role === 'user' ? 'turn.user' : 'turn.agent',
      src_table: 'chat_turn',
      src_id: row.id,
      task_id: row.task_id,
      text: row.text.length > 400 ? `${row.text.slice(0, 399)}…` : row.text,
      at: row.created_at,
      score: null,
      guaranteed: false,
    }));
  }

  #cursor(login: string, chatId: string): number {
    const row = this.#db
      .prepare('SELECT last_seen_seq FROM member_cursor WHERE login = ? AND chat_id = ?')
      .get(login, chatId) as { last_seen_seq: number } | undefined;
    return row?.last_seen_seq ?? 0;
  }

  /**
   * The chat's current position, as a timestamp.
   *
   * A timestamp rather than a turn sequence because the window has to cover gate decisions and
   * verify runs too, and those have no `seq` — they are not turns. One clock covers all three.
   */
  #head(chatId: string): number {
    const row = this.#db
      .prepare(
        `SELECT MAX(at) AS at FROM (
           SELECT MAX(ct.created_at) AS at FROM chat_turn ct JOIN task t ON t.id = ct.task_id WHERE t.chat_id = ?
           UNION ALL
           SELECT MAX(g.decided_at) FROM gate_request g JOIN task t ON t.id = g.task_id WHERE t.chat_id = ?
           UNION ALL
           SELECT MAX(v.finished_at) FROM verify_run v JOIN task t ON t.id = v.task_id WHERE t.chat_id = ?
         )`,
      )
      .get(chatId, chatId, chatId) as { at: number | null };
    return row.at ?? this.#now();
  }

  #advance(login: string, chatId: string, seq: number): void {
    this.#db
      .prepare(
        `INSERT INTO member_cursor (login, chat_id, last_seen_seq) VALUES (?, ?, ?)
         ON CONFLICT(login, chat_id) DO UPDATE SET last_seen_seq = excluded.last_seen_seq`,
      )
      .run(login, chatId, seq);
  }
}

function toItem(
  meta: Record<string, string>,
  text: string,
  score: number,
): CatchUpItem | null {
  const srcTable = meta.src_table;
  const srcId = meta.src_id;
  if (!srcTable || !srcId) return null;
  return {
    kind: (meta.kind ?? 'turn.agent') as CatchUpItem['kind'],
    src_table: srcTable,
    src_id: srcId,
    task_id: meta.task_id ?? null,
    text,
    at: 0,
    score: Math.round(score * 1000) / 1000,
    guaranteed: false,
  };
}

function isPresent<T>(value: T | null): value is T {
  return value != null;
}
