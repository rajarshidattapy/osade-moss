import { randomUUID } from 'node:crypto';

import type { ContextItem, ContextPack, Namespace } from '@osade/contract';

import type { RetrievalConfig } from '../config.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { Db } from '../db/index.js';
import type { MetaCondition, RetrievalHit } from './port.js';
import type { RetrievalService } from './service.js';
import { NAMESPACE_SETTINGS, SOURCE_WEIGHT, VERIFIED_SIBLING_WEIGHT } from './settings.js';

/**
 * Per-turn context assembly — OSADE-MOSS §M.2. This is the hot path.
 *
 * Every prompt Osade sends an agent goes through `build` first, and it runs once per turn per
 * lane: at 15 lanes × 40 turns that is 600 assemblies per migration, each one sitting between
 * the user pressing enter and the agent seeing the text. That is why §M.1.7 budgets it at p95
 * < 30 ms and why the query timeout is 25 ms — not because retrieval is slow, but because it is
 * multiplied by every lane on every turn.
 *
 * **The code decides; the model only reads.** Five stages, in order (§M.2.2): scope, retrieve,
 * filter, budget, record. No model ranks, summarises or chooses anything here. What the agent
 * receives is a list of rows that exist in SQLite, each one cited back to the row it came from.
 *
 * **Deviation from §M.2.1, recorded.** The PRD hooks this into `domain/chat-turns.ts` and has
 * `renderer/chat.ts` strip `<osade_context>` the way it strips `<osade_lanes>`. In this
 * codebase the lane digest is built in the *renderer* and travels inside the stored turn text,
 * which is why it needs stripping on display. Retrieval cannot work that way: it runs in the
 * daemon, where the database is. So the block is injected at `LaunchTask.prompt`, the one
 * funnel through which text reaches an agent, and is never stored on the turn. The transcript
 * stays clean without a strip, and the chip reads `context_pack` instead.
 */

/** §M.2.2 step 4 — 4 chars per token, the same estimate the injection budget uses (§13.5). */
const CHARS_PER_TOKEN = 4;

/** Turns already in the agent's own scrollback. Re-injecting them wastes the budget. */
const RECENT_TURNS = 6;

/** §M.2.2 step 2 — the sibling-lane retrieval's `kind` allowlist. */
const SIBLING_KINDS = ['fix_pattern', 'verify.pass', 'gate.rejected'];

export interface AssemblerOptions {
  readonly config?: RetrievalConfig;
  readonly now?: () => number;
  readonly onWarning?: (message: string) => void;
}

export interface AssembledContext {
  /** The `<osade_context>` block, or null when nothing survived the filters. */
  readonly block: string | null;
  readonly pack: ContextPack;
}

interface Scope {
  taskId: string;
  chatId: string;
  repoId: string;
  baseSha: string;
  /** §M.5.7 — null when this lane is not in an experiment, which is every lane before F1. */
  arm: 'digest_on' | 'digest_off' | null;
}

interface Candidate {
  hit: RetrievalHit;
  ns: Namespace;
  weight: number;
  section: Section;
}

type Section = 'conventions' | 'siblings' | 'history';

const SECTION_TITLE: Record<Section, string> = {
  conventions: 'Conventions relevant to this change',
  siblings: 'What sibling lanes learned (verified)',
  history: 'Earlier in this chat',
};

export class ContextAssembler {
  readonly #db: Db;
  readonly #retrieval: RetrievalService;
  readonly #config: RetrievalConfig;
  readonly #now: () => number;

  constructor(db: Db, retrieval: RetrievalService, options: AssemblerOptions = {}) {
    this.#db = db;
    this.#retrieval = retrieval;
    this.#config = options.config ?? DEFAULT_CONFIG.retrieval;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Assembles one turn's context and records the pack.
   *
   * Returns `null` for a task that no longer exists rather than throwing: R3 says retrieval
   * never fails an operation, and a lane being torn down mid-send is a real race, not a bug.
   */
  async build(taskId: string, turnText: string, chatTurnId?: string): Promise<AssembledContext | null> {
    const assemblyStarted = performance.now();
    const scope = this.#scope(taskId);
    if (!scope) return null;

    // ── 2. retrieve, in parallel ────────────────────────────────────────────
    const retrievalStarted = performance.now();
    const wantSiblings = scope.arm !== 'digest_off';
    const [conventions, history, siblings] = await Promise.all([
      this.#retrieval.query('conventions', turnText, {
        topK: 8,
        filter: [eq('repo_id', scope.repoId)],
      }),
      this.#retrieval.query('turns', turnText, {
        topK: 8,
        filter: [eq('chat_id', scope.chatId), eq('task_id', scope.taskId)],
      }),
      wantSiblings
        ? this.#retrieval.query('turns', turnText, {
            topK: 12,
            filter: [
              eq('chat_id', scope.chatId),
              { field: 'task_id', condition: { $ne: scope.taskId } },
              eq('verified', '1'),
              { field: 'kind', condition: { $in: SIBLING_KINDS } },
            ],
          })
        : Promise.resolve([] as readonly RetrievalHit[]),
    ]);
    // The wall time the turn actually paid is the slowest query, not their sum (§M.2.4).
    const retrievalMs = performance.now() - retrievalStarted;

    // ── 3. filter, in code, after retrieval ─────────────────────────────────
    const recent = this.#recentTurnIds(scope.taskId);
    const candidates: Candidate[] = [
      ...conventions.map((hit) => candidate(hit, 'conventions', 'conventions')),
      ...history
        .filter((hit) => !recent.has(hit.meta.src_id ?? ''))
        .map((hit) => candidate(hit, 'turns', 'history')),
      ...siblings.map((hit) => ({
        hit,
        ns: 'turns' as const,
        weight: VERIFIED_SIBLING_WEIGHT,
        section: 'siblings' as const,
      })),
    ];

    const kept = this.#dedupe(this.#fresh(this.#present(candidates), scope));

    // ── 4. budget ───────────────────────────────────────────────────────────
    kept.sort((a, b) => b.hit.score * b.weight - a.hit.score * a.weight);
    const budgetChars = this.#config.budgetTokens * CHARS_PER_TOKEN;
    const chosen: Candidate[] = [];
    let usedChars = 0;
    let overflow = 0;
    for (const item of kept) {
      const cost = renderItem(item).length + 1;
      if (usedChars + cost > budgetChars) {
        // §M.2.2 step 4 — the remainder is counted, not appended. ARCH §13.3: the cap is the
        // feature. Silently spilling over is how a context file becomes a context dump.
        overflow += 1;
        continue;
      }
      chosen.push(item);
      usedChars += cost;
    }

    // ── 5. record ───────────────────────────────────────────────────────────
    const degraded = this.#retrieval.backend === 'fts5';
    const pack: ContextPack = {
      id: `cp_${randomUUID().slice(0, 8)}`,
      task_id: scope.taskId,
      chat_turn_id: chatTurnId ?? null,
      arm: scope.arm,
      backend: this.#retrieval.backend,
      retrieval_ms: round(retrievalMs),
      assembly_ms: round(performance.now() - assemblyStarted),
      tokens_used: Math.ceil(usedChars / CHARS_PER_TOKEN),
      overflow,
      degraded,
      items: chosen.map(toContextItem),
      created_at: this.#now(),
    };
    this.#record(pack);

    return { block: renderBlock(pack, chosen), pack };
  }

  #scope(taskId: string): Scope | null {
    const row = this.#db
      .prepare('SELECT id, chat_id, repo_id, base_sha FROM task WHERE id = ?')
      .get(taskId) as
      | { id: string; chat_id: string | null; repo_id: string; base_sha: string }
      | undefined;
    if (!row) return null;
    return {
      taskId: row.id,
      chatId: row.chat_id ?? row.id,
      repoId: row.repo_id,
      baseSha: row.base_sha,
      arm: this.#arm(row.id),
    };
  }

  /**
   * §M.5.7 — which arm of the digest experiment this lane is in.
   *
   * Read from `migration_target`, never computed here: the arm is fixed when targets are
   * assigned, and a lane that could be re-randomised mid-run would make the comparison
   * meaningless. A lane outside a migration has no arm, and `null` means "run the full
   * pipeline" — not "digest off".
   */
  #arm(taskId: string): 'digest_on' | 'digest_off' | null {
    const row = this.#db
      .prepare('SELECT arm FROM migration_target WHERE task_id = ?')
      .get(taskId) as { arm: string } | undefined;
    return row?.arm === 'digest_off' ? 'digest_off' : row?.arm === 'digest_on' ? 'digest_on' : null;
  }

  #recentTurnIds(taskId: string): Set<string> {
    const rows = this.#db
      .prepare('SELECT id FROM chat_turn WHERE task_id = ? ORDER BY seq DESC LIMIT ?')
      .all(taskId, RECENT_TURNS) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /**
   * §M.2.2 step 3, provenance — drop any hit whose source row is gone.
   *
   * The index may lag the truth, and the truth wins. This is the filter that makes a stale
   * index a *slower* index rather than a lying one, which is what lets R1 treat the whole
   * thing as disposable.
   */
  #present(candidates: Candidate[]): Candidate[] {
    if (candidates.length === 0) return candidates;
    const byTable = new Map<string, Set<string>>();
    for (const item of candidates) {
      const table = item.hit.meta.src_table;
      const id = item.hit.meta.src_id;
      if (!table || !id) continue;
      const bucket = byTable.get(table) ?? new Set<string>();
      bucket.add(id);
      byTable.set(table, bucket);
    }
    const alive = new Set<string>();
    for (const [table, ids] of byTable) {
      // Table names come from the projector registry, never from user input.
      const key = table === 'agent_fact' ? 'task_id' : 'id';
      const list = [...ids];
      const placeholders = new Array(list.length).fill('?').join(', ');
      const rows = this.#db
        .prepare(`SELECT ${key} AS id FROM ${table} WHERE ${key} IN (${placeholders})`)
        .all(...list) as { id: string }[];
      for (const row of rows) alive.add(`${table}\u0000${row.id}`);
    }
    return candidates.filter((item) =>
      alive.has(`${item.hit.meta.src_table}\u0000${item.hit.meta.src_id}`),
    );
  }

  /**
   * §M.2.2 step 3, freshness.
   *
   * The PRD's rule is git ancestry against the lane's base or head. That is a subprocess per
   * item on a path budgeted at 30 ms, so this does the same job in SQL: a verified item is
   * dropped when its source task has since recorded a *newer* finished run at a different
   * `head_sha`. The case it exists to prevent — citing a fix that a later run invalidated — is
   * covered; what it does not catch is a fix on a branch that was never merged toward this
   * lane. Tightening it to true ancestry belongs with F1, where lanes share a base (§M.5.6).
   */
  #fresh(candidates: Candidate[], scope: Scope): Candidate[] {
    const verified = candidates.filter((item) => item.hit.meta.head_sha && item.hit.meta.task_id);
    if (verified.length === 0) return candidates;
    const heads = new Map<string, string>();
    for (const item of verified) {
      const taskId = item.hit.meta.task_id!;
      if (heads.has(taskId)) continue;
      const row = this.#db
        .prepare(
          `SELECT head_sha FROM verify_run
            WHERE task_id = ? AND finished_at IS NOT NULL
            ORDER BY finished_at DESC LIMIT 1`,
        )
        .get(taskId) as { head_sha: string } | undefined;
      if (row) heads.set(taskId, row.head_sha);
    }
    return candidates.filter((item) => {
      const sha = item.hit.meta.head_sha;
      const taskId = item.hit.meta.task_id;
      if (!sha || !taskId) return true;
      const latest = heads.get(taskId);
      // No finished run yet, or this item is at the latest one, or it is this lane's own base.
      return latest == null || latest === sha || sha === scope.baseSha;
    });
  }

  /**
   * §M.2.2 step 3, dedupe.
   *
   * `pattern_hash` (§M.5.5) arrives with F1. Until then the normalised text is the hash, which
   * collapses the case this is actually for: five lanes reporting the same one-line fix.
   */
  #dedupe(candidates: Candidate[]): Candidate[] {
    const seen = new Map<string, Candidate>();
    for (const item of candidates) {
      const key = `${item.section}\u0000${item.hit.meta.pattern_hash ?? normalise(item.hit.text)}`;
      const existing = seen.get(key);
      if (!existing || item.hit.score > existing.hit.score) seen.set(key, item);
    }
    return [...seen.values()];
  }

  #record(pack: ContextPack): void {
    this.#db
      .prepare(
        `INSERT INTO context_pack
           (id, task_id, chat_turn_id, arm, backend, retrieval_ms, assembly_ms,
            tokens_used, overflow, degraded, items_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pack.id,
        pack.task_id,
        pack.chat_turn_id,
        pack.arm,
        pack.backend,
        pack.retrieval_ms,
        pack.assembly_ms,
        pack.tokens_used,
        pack.overflow,
        pack.degraded ? 1 : 0,
        // §M.2.4 — ids only. The text is reconstructible from the source rows, and storing it
        // twice would make context_pack the largest table in the database.
        JSON.stringify(pack.items.map(({ id, ns, score, src_table, src_id }) => ({
          id,
          ns,
          score,
          src_table,
          src_id,
        }))),
        pack.created_at,
      );
  }
}

function candidate(hit: RetrievalHit, ns: Namespace, section: Section): Candidate {
  return { hit, ns, weight: SOURCE_WEIGHT[ns], section };
}

function eq(field: string, value: string): MetaCondition {
  return { field, condition: { $eq: value } };
}

function toContextItem(item: Candidate): ContextItem {
  return {
    id: item.hit.id,
    ns: item.ns,
    score: round(item.hit.score),
    src_table: item.hit.meta.src_table ?? 'unknown',
    src_id: item.hit.meta.src_id ?? 'unknown',
    text: item.hit.text,
    url: item.hit.meta.url ?? null,
  };
}

/** `[conv:412] rule text` — every bracketed id is a link to its source row (§M.2.1). */
function renderItem(item: Candidate): string {
  const table = item.hit.meta.src_table ?? 'row';
  const id = item.hit.meta.src_id ?? '?';
  return `- [${table}:${id}] ${item.hit.text.replace(/\s*\n\s*/g, ' ')}`;
}

function renderBlock(pack: ContextPack, chosen: readonly Candidate[]): string | null {
  if (chosen.length === 0) return null;
  const lines: string[] = [
    `<osade_context budget="${pack.tokens_used}" overflow="${pack.overflow}" pack="${pack.id}">`,
  ];
  for (const section of ['conventions', 'siblings', 'history'] as const) {
    const items = chosen.filter((item) => item.section === section);
    if (items.length === 0) continue;
    lines.push(`## ${SECTION_TITLE[section]}`);
    for (const item of items) lines.push(renderItem(item));
  }
  lines.push('</osade_context>');
  return lines.join('\n');
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export { NAMESPACE_SETTINGS };
