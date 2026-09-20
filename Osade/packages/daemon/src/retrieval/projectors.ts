import type { Namespace } from '@osade/contract';

import type { RetrievalTable } from '../db/migrations.js';
import type { DocMeta, IndexDoc } from './port.js';

/**
 * Projectors: one fact row in, cited documents out — OSADE-MOSS §M.1.4.
 *
 * INVARIANT: every function here is **pure and deterministic**. The indexer loads the row, the
 * projector shapes it, and nothing in between reads a clock, a file or the database. That is
 * what makes `osade index rebuild` provably equivalent to incremental indexing — the rebuild
 * test asserts an identical id set, and it can only do that if re-projecting the same row twice
 * gives the same documents.
 *
 * INVARIANT R2: nothing enters the index without provenance. Every document below carries
 * `src_table`, `src_id` and a locator. Where a row has no external URL, the locator is an
 * `osade://` link to the source row — which is what §M.2.1's "every bracketed id is a link to
 * its source row" actually needs. A synthetic locator is honest here in a way that borrowing
 * some other row's `head_sha` would not be.
 */

/**
 * The SQL the indexer runs to load rows for a table, and the function that shapes them.
 *
 * `project` takes `unknown` rather than a row type because the registry is heterogeneous: each
 * projector's row shape is private to the query that produced it. `defineProjector` below is
 * the one place that bridges the two, so the cast exists once and is checked against the row
 * type at every definition site instead of being spelled `any` six times.
 */
export interface Projector {
  readonly ns: Namespace;
  /** `%IDS%` is replaced with a `?` list. The row shape must match the projector's. */
  readonly select: string;
  readonly project: (row: unknown) => IndexDoc[];
  /**
   * Tables whose changes re-project a *different* row. Evidence rows are not documents; they
   * change the convention that cites them (§13.1), so the convention is what gets re-indexed.
   */
  readonly redirect?: { readonly table: RetrievalTable; readonly select: string };
}

function defineProjector<R>(spec: {
  ns: Namespace;
  select: string;
  project: (row: R) => IndexDoc[];
  redirect?: { table: RetrievalTable; select: string };
}): Projector {
  return {
    ns: spec.ns,
    select: spec.select,
    project: (row: unknown) => spec.project(row as R),
    ...(spec.redirect ? { redirect: spec.redirect } : {}),
  };
}

/** §M.1.5 — `<ns>:<src_table>:<src_id>`, deterministic so re-projection is idempotent. */
export function docId(ns: Namespace, table: string, id: string, chunk?: number): string {
  return chunk == null ? `${ns}:${table}:${id}` : `${ns}:${table}:${id}:${chunk}`;
}

/**
 * §M.1.5 — zero-padded to 12 digits so a lexical `$gt` equals numeric order.
 *
 * Moss metadata values are strings and §M.12 Q3 leaves it open whether comparisons are numeric
 * or lexical. Padding makes both answers correct, which is cheaper than finding out.
 */
export function paddedSeq(seq: number): string {
  return Math.max(0, Math.trunc(seq)).toString().padStart(12, '0');
}

/**
 * A sortable clock key for the `turns` namespace — epoch *seconds*, zero-padded.
 *
 * Every document in `turns` carries one, because a catch-up window spans turns, gate decisions
 * and verify runs, and those share no sequence number: a turn's `seq` counts within one task,
 * while a chat has several. One clock covers all three. Seconds rather than milliseconds so the
 * value stays inside twelve digits and lexical order keeps matching numeric order.
 */
export function paddedAt(ms: number): string {
  return paddedSeq(Math.floor(ms / 1000));
}

/** Keep a document readable and bounded. Long agent turns are mostly tool noise past this. */
const MAX_TEXT = 1_200;

function clamp(text: string, max = MAX_TEXT): string {
  const trimmed = text.trim().replace(/\s+\n/g, '\n');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function meta(fields: Record<string, string | undefined>): DocMeta {
  return fields as unknown as DocMeta;
}

// ── chat_turn → ns 'turns' ────────────────────────────────────────────────────

interface TurnRow {
  id: string;
  task_id: string;
  chat_id: string | null;
  repo_id: string;
  seq: number;
  role: string;
  origin: string;
  text: string;
  delivery: string;
  created_at: number;
  agent_id: string | null;
  base_sha: string;
}

const CHAT_TURN = defineProjector<TurnRow>({
  ns: 'turns',
  select: `SELECT ct.id, ct.task_id, t.chat_id, t.repo_id, ct.seq, ct.role, ct.origin, ct.text,
                  ct.delivery, ct.created_at, t.agent_id, t.base_sha
             FROM chat_turn ct JOIN task t ON t.id = ct.task_id
            WHERE ct.id IN (%IDS%)`,
  project: (row) => {
    // A failed or in-flight turn is not history yet. Indexing `sending` would put text into
    // the `turns` namespace that the agent may never have received.
    if (row.delivery !== 'accepted') return [];
    const text = clamp(row.text);
    if (text.length === 0) return [];
    return [
      {
        id: docId('turns', 'chat_turn', row.id),
        text,
        meta: meta({
          ns: 'turns',
          src_table: 'chat_turn',
          src_id: row.id,
          url: `osade://task/${row.task_id}/turn/${row.seq}`,
          task_id: row.task_id,
          chat_id: row.chat_id ?? row.task_id,
          repo_id: row.repo_id,
          head_sha: row.base_sha,
          kind: row.role === 'user' ? 'turn.user' : 'turn.agent',
          seq: paddedSeq(row.seq),
          at: paddedAt(row.created_at),
          author:
            row.role === 'user'
              ? row.origin === 'automation'
                ? 'automation'
                : 'human'
              : `agent:${row.agent_id ?? 'unknown'}`,
        }),
      },
    ];
  },
});

// ── verify_run → ns 'turns' ───────────────────────────────────────────────────

interface VerifyRow {
  id: string;
  task_id: string;
  chat_id: string | null;
  repo_id: string;
  step_name: string;
  cmd: string;
  exit_code: number | null;
  required: number;
  head_sha: string;
  finished_at: number | null;
}

/**
 * The `verified` flag (§M.1.5) is set here and nowhere else.
 *
 * It means exactly one thing: a required step passed for this `head_sha`. §M.2.2's sibling-lane
 * retrieval filters on it, so widening it — to "probably fine", to an unfinished run — would
 * quietly turn the digest from evidence into rumour.
 */
const VERIFY_RUN = defineProjector<VerifyRow>({
  ns: 'turns',
  select: `SELECT v.id, v.task_id, t.chat_id, t.repo_id, v.step_name, v.cmd, v.exit_code,
                  v.required, v.head_sha, v.finished_at
             FROM verify_run v JOIN task t ON t.id = v.task_id
            WHERE v.id IN (%IDS%)`,
  project: (row) => {
    if (row.finished_at == null) return [];
    const passed = row.exit_code === 0;
    return [
      {
        id: docId('turns', 'verify_run', row.id),
        text: clamp(
          `Verification step "${row.step_name}" (${row.cmd}) ${passed ? 'passed' : `failed with exit ${row.exit_code ?? '?'}`} at ${row.head_sha.slice(0, 8)}.`,
        ),
        meta: meta({
          ns: 'turns',
          src_table: 'verify_run',
          src_id: row.id,
          run_id: row.id,
          task_id: row.task_id,
          chat_id: row.chat_id ?? row.task_id,
          repo_id: row.repo_id,
          head_sha: row.head_sha,
          kind: passed ? 'verify.pass' : 'verify.fail',
          verified: passed && row.required === 1 ? '1' : undefined,
          at: paddedAt(row.finished_at),
          author: 'automation',
        }),
      },
    ];
  },
});

// ── gate_request → ns 'turns' ─────────────────────────────────────────────────

interface GateRow {
  id: string;
  task_id: string;
  chat_id: string | null;
  repo_id: string;
  gate: string;
  decision: string | null;
  decided_by: string | null;
  decided_at: number | null;
  requested_at: number;
  execution_error: string | null;
}

const GATE_REQUEST = defineProjector<GateRow>({
  ns: 'turns',
  select: `SELECT g.id, g.task_id, t.chat_id, t.repo_id, g.gate, g.decision, g.decided_by,
                  g.decided_at, g.requested_at, g.execution_error
             FROM gate_request g JOIN task t ON t.id = g.task_id
            WHERE g.id IN (%IDS%)`,
  project: (row) => {
    const decided = row.decided_at != null;
    const what = decided
      ? `${row.gate} was ${row.decision ?? 'decided'} by ${row.decided_by ?? 'someone'}`
      : `${row.gate} is awaiting approval`;
    return [
      {
        id: docId('turns', 'gate_request', row.id),
        text: clamp(row.execution_error ? `${what}. Execution failed: ${row.execution_error}` : `${what}.`),
        meta: meta({
          ns: 'turns',
          src_table: 'gate_request',
          src_id: row.id,
          gate_id: row.id,
          task_id: row.task_id,
          chat_id: row.chat_id ?? row.task_id,
          repo_id: row.repo_id,
          kind: decided ? (row.decision === 'approve' ? 'gate.approved' : 'gate.rejected') : 'gate.requested',
          at: paddedAt(row.decided_at ?? row.requested_at),
          author: row.decided_by ?? 'automation',
        }),
      },
    ];
  },
});

// ── agent_fact → ns 'turns', transitions only ─────────────────────────────────

interface AgentFactRow {
  task_id: string;
  chat_id: string | null;
  repo_id: string;
  agent_id: string | null;
  last_event: string | null;
  substrate_state: string | null;
  final_message: string | null;
  terminated: number;
  external_block: string | null;
  last_event_at: number | null;
  base_sha: string;
}

/**
 * §M.1.4 — transitions, never the 1 Hz activity text.
 *
 * The trigger already filters most of it out; this filters the rest. Activity churn would
 * dominate the `turns` namespace and bury the events a catch-up (§M.6.5) exists to surface.
 */
const AGENT_FACT = defineProjector<AgentFactRow>({
  ns: 'turns',
  select: `SELECT a.task_id, t.chat_id, t.repo_id, t.agent_id, a.last_event, a.substrate_state,
                  a.final_message, a.terminated, a.external_block, a.last_event_at, t.base_sha
             FROM agent_fact a JOIN task t ON t.id = a.task_id
            WHERE a.task_id IN (%IDS%)`,
  project: (row) => {
    const kind = row.terminated === 1
      ? 'agent.terminated'
      : row.external_block
        ? 'agent.blocked'
        : row.last_event === 'to_review'
          ? 'agent.to_review'
          : row.last_event === 'to_in_progress'
            ? 'agent.to_in_progress'
            : null;
    if (kind == null) return [];
    const agent = row.agent_id ?? 'agent';
    const body =
      kind === 'agent.blocked'
        ? `${agent} is blocked: ${row.external_block}`
        : kind === 'agent.terminated'
          ? `${agent} was terminated.`
          : kind === 'agent.to_review'
            ? `${agent} finished a turn. ${row.final_message ?? ''}`
            : `${agent} started working.`;
    return [
      {
        id: docId('turns', 'agent_fact', row.task_id),
        text: clamp(body),
        meta: meta({
          ns: 'turns',
          src_table: 'agent_fact',
          src_id: row.task_id,
          url: `osade://task/${row.task_id}`,
          task_id: row.task_id,
          chat_id: row.chat_id ?? row.task_id,
          repo_id: row.repo_id,
          head_sha: row.base_sha,
          kind,
          at: row.last_event_at == null ? undefined : paddedAt(row.last_event_at),
          author: `agent:${agent}`,
        }),
      },
    ];
  },
});

// ── convention → ns 'conventions' ─────────────────────────────────────────────

interface ConventionRow {
  id: string;
  repo_id: string;
  category: string;
  rule_text: string;
  rationale: string | null;
  confidence: number;
  lifecycle: string;
  evidence_url: string | null;
  evidence_count: number;
}

/**
 * Only `active` conventions are indexed.
 *
 * A candidate is a rule nobody has confirmed, and §13 is explicit that an unconfirmed rule is
 * not injected into an agent's context. Indexing them would route around that decision by the
 * back door, since §M.2 injects whatever the `conventions` namespace returns.
 */
const CONVENTION = defineProjector<ConventionRow>({
  ns: 'conventions',
  select: `SELECT c.id, c.repo_id, c.category, c.rule_text, c.rationale, c.confidence, c.lifecycle,
                  (SELECT url FROM convention_evidence e WHERE e.convention_id = c.id
                    ORDER BY e.observed_at DESC LIMIT 1) AS evidence_url,
                  (SELECT COUNT(*) FROM convention_evidence e WHERE e.convention_id = c.id) AS evidence_count
             FROM convention c
            WHERE c.id IN (%IDS%)`,
  project: (row) => {
    if (row.lifecycle !== 'active') return [];
    // §13.1 — a convention with zero evidence is not a convention. Without a locator it also
    // cannot satisfy R2, so the two rules agree and this is one check for both.
    if (row.evidence_url == null) return [];
    return [
      {
        id: docId('conventions', 'convention', row.id),
        text: clamp(row.rationale ? `${row.rule_text} (${row.rationale})` : row.rule_text),
        meta: meta({
          ns: 'conventions',
          src_table: 'convention',
          src_id: row.id,
          url: row.evidence_url,
          repo_id: row.repo_id,
          kind: 'convention',
          category: row.category,
          confidence: row.confidence.toFixed(2),
          evidence_count: String(row.evidence_count),
          author: 'policy:conventions',
        }),
      },
    ];
  },
});

/** Evidence is not a document; it changes the convention that cites it. */
const CONVENTION_EVIDENCE = defineProjector<never>({
  ns: 'conventions',
  select: '',
  project: () => [],
  redirect: {
    table: 'convention',
    select: 'SELECT convention_id AS id FROM convention_evidence WHERE id IN (%IDS%)',
  },
});

/**
 * The registry. A table with no entry is not indexed, which is how `code`, `policies` and `prs`
 * stay declared-but-empty until migrations 14–16 bring their source tables.
 */
// ── code_chunk → ns 'code' (F1, §M.5.4) ──────────────────────────────────────

interface CodeChunkRow {
  id: string;
  migration_id: string;
  repo_id: string;
  file: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  kind: string;
  hop: number;
  enriched_text: string;
  base_sha: string;
}

/**
 * The `code` namespace is what makes F1's discovery beat grep.
 *
 * `enriched_text` already carries the resolved-context header the chunker wrote — "calls
 * MossClient#search via local alias m" — so an aliased import is findable by *meaning* rather
 * than by the string `search`. That enrichment is the whole mechanism, which is why this
 * projector indexes `enriched_text` and not the raw source.
 *
 * Chunks are big, so this is the one projector with a generous clamp: a truncated function body
 * is still a useful retrieval target, but a truncated context header is not, and the header is
 * written first by the chunker for exactly that reason.
 */
const CODE_CHUNK = defineProjector<CodeChunkRow>({
  ns: 'code',
  select: `SELECT id, migration_id, repo_id, file, start_line, end_line, symbol, kind, hop,
                  enriched_text, base_sha
             FROM code_chunk WHERE id IN (%IDS%)`,
  project: (row) => [
    {
      id: docId('code', 'code_chunk', row.id),
      text: clamp(row.enriched_text, 2_000),
      meta: meta({
        ns: 'code',
        src_table: 'code_chunk',
        src_id: row.id,
        head_sha: row.base_sha,
        migration_id: row.migration_id,
        repo_id: row.repo_id,
        file: row.file,
        line: String(row.start_line),
        kind: `code.${row.kind}`,
        symbol: row.symbol ?? undefined,
        hop: String(row.hop),
        author: 'code',
      }),
    },
  ],
});

// ── policy_clause → ns 'policies' (F4, §M.8.1) ───────────────────────────────

interface PolicyClauseRow {
  id: string;
  clause_ref: string;
  title: string;
  text: string;
  requires_ack: number;
  applies_to: string | null;
  policy_path: string;
  file_sha: string;
  scope: string;
  repo_id: string | null;
}

/**
 * The clause ref leads the indexed text on purpose.
 *
 * §M.1.6 gives `policies` a lower alpha (0.7) than the prose namespaces precisely because
 * clause ids and terms matter: someone writing "does this violate SEC-3.2?" should find SEC-3.2
 * by its name, not only by what it says. Putting the ref and title first gives the keyword half
 * of the hybrid query something exact to match.
 */
const POLICY_CLAUSE = defineProjector<PolicyClauseRow>({
  ns: 'policies',
  select: `SELECT c.id, c.clause_ref, c.title, c.text, c.requires_ack, c.applies_to,
                  p.path AS policy_path, p.file_sha, p.scope, p.repo_id
             FROM policy_clause c JOIN policy p ON p.id = c.policy_id
            WHERE c.id IN (%IDS%)`,
  project: (row) => [
    {
      id: docId('policies', 'policy_clause', row.id),
      text: clamp(`${row.clause_ref} ${row.title}\n${row.text}`, 2_000),
      meta: meta({
        ns: 'policies',
        src_table: 'policy_clause',
        src_id: row.id,
        // R2's locator: the file and the exact content hash the clause was read from, so an
        // approval that cited it can be re-checked against the version that was shown.
        url: `osade://policy/${row.file_sha}/${row.policy_path}#${row.clause_ref}`,
        head_sha: row.file_sha,
        kind: 'clause',
        clause_ref: row.clause_ref,
        scope: row.scope,
        repo_id: row.repo_id ?? undefined,
        requires_ack: row.requires_ack === 1 ? '1' : '0',
        applies_to: row.applies_to ?? undefined,
        author: 'policy:file',
      }),
    },
  ],
});

// ── fix_pattern → ns 'turns', verified (F1, §M.5.5) ──────────────────────────

interface FixPatternRow {
  id: string;
  task_id: string;
  chat_id: string | null;
  repo_id: string;
  migration_id: string | null;
  head_sha: string;
  file: string;
  line: number;
  pattern_hash: string;
  hunk: string;
  created_at: number;
  agent_id: string | null;
}

/**
 * The one document type that is evidence rather than context.
 *
 * `verified = '1'` is set unconditionally here because a `fix_pattern` row only exists when a
 * required verification already passed at this head — the writer does that check, so by the
 * time a row exists the claim is true by construction. §M.2.2 weights these above conventions
 * and filters the sibling digest on exactly this flag.
 */
const FIX_PATTERN = defineProjector<FixPatternRow>({
  ns: 'turns',
  select: `SELECT f.id, f.task_id, t.chat_id, f.repo_id, f.migration_id, f.head_sha, f.file,
                  f.line, f.pattern_hash, f.hunk, f.created_at, t.agent_id
             FROM fix_pattern f JOIN task t ON t.id = f.task_id
            WHERE f.id IN (%IDS%)`,
  project: (row) => [
    {
      id: docId('turns', 'fix_pattern', row.id),
      text: clamp(
        `Verified fix at ${row.file}:${row.line} (${row.head_sha.slice(0, 8)}):\n${row.hunk}`,
        1_500,
      ),
      meta: meta({
        ns: 'turns',
        src_table: 'fix_pattern',
        src_id: row.id,
        head_sha: row.head_sha,
        task_id: row.task_id,
        chat_id: row.chat_id ?? row.task_id,
        repo_id: row.repo_id,
        migration_id: row.migration_id ?? undefined,
        kind: 'fix_pattern',
        verified: '1',
        at: paddedAt(row.created_at),
        pattern_hash: row.pattern_hash,
        file: row.file,
        author: `agent:${row.agent_id ?? 'unknown'}`,
      }),
    },
  ],
});

// ── pr_record → ns 'prs' (F3, §M.7.5) ────────────────────────────────────────

interface PrRecordRow {
  id: string;
  repo_id: string;
  number: number;
  author: string;
  title: string;
  body_excerpt: string;
  diff_summary: string;
  head_sha: string;
  opened_at: number;
}

/**
 * Near-duplicate detection indexes *structure*, not prose.
 *
 * `diff_summary` is the files touched plus the normalised hunk hashes from §M.5.5 — two agents
 * solving the same issue write different words about the same change, so the title and body are
 * the weakest signal available. The body excerpt is included because it is sometimes the only
 * thing distinguishing two structurally identical PRs, but it leads with the structure.
 *
 * Raw diffs are deliberately not indexed: too large, and dominated by context lines that are
 * identical across unrelated changes.
 */
const PR_RECORD = defineProjector<PrRecordRow>({
  ns: 'prs',
  select: `SELECT id, repo_id, number, author, title, body_excerpt, diff_summary, head_sha,
                  opened_at
             FROM pr_record WHERE id IN (%IDS%)`,
  project: (row) => [
    {
      id: docId('prs', 'pr_record', row.id),
      text: clamp(`${row.title}\n${row.diff_summary}\n${row.body_excerpt}`, 2_000),
      meta: meta({
        ns: 'prs',
        src_table: 'pr_record',
        src_id: row.id,
        head_sha: row.head_sha,
        repo_id: row.repo_id,
        pr_number: String(row.number),
        kind: 'pr',
        author: `github:${row.author}`,
        opened_at: paddedSeq(Math.floor(row.opened_at / 1000)),
      }),
    },
  ],
});

export const PROJECTORS: Readonly<Record<RetrievalTable, Projector>> = {
  chat_turn: CHAT_TURN,
  verify_run: VERIFY_RUN,
  gate_request: GATE_REQUEST,
  agent_fact: AGENT_FACT,
  convention: CONVENTION,
  convention_evidence: CONVENTION_EVIDENCE,
  code_chunk: CODE_CHUNK,
  policy_clause: POLICY_CLAUSE,
  fix_pattern: FIX_PATTERN,
  pr_record: PR_RECORD,
};
