/**
 * Numbered, forward-only migrations, applied at daemon boot — OSADE.md §5.
 *
 * Two rules that are enforced by tests rather than by review:
 *   - No `status` column, in any table, ever (§6). `test/integration/cdc.test.ts` asserts it
 *     mechanically, by reading `PRAGMA table_info` for every table in the schema.
 *   - Every fact table gets AFTER INSERT/UPDATE/DELETE triggers writing to `change_log` (§5.4).
 *     One event path; no service emits a websocket message directly.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

/** Tables whose mutations must reach the UI. Each gets the three CDC triggers below. */
const CORE_CDC_TABLES = [
  'task',
  'agent_fact',
  'verify_run',
  'gate_request',
  'scm_fact',
  'turn_checkpoint',
] as const;

export const CDC_TABLES = [
  ...CORE_CDC_TABLES,
  'chat_turn',
  'context_pack',
  'attestation',
  'presence',
  'task_claim',
] as const;

export type CdcTable = (typeof CDC_TABLES)[number];

/**
 * `row_id` is the value the CDC poller uses to re-read the row, so it must be the task the
 * change belongs to — the ledger is keyed by task, not by row.
 */
function cdcTriggers(table: CdcTable): string {
  const taskRef = table === 'task' ? 'id' : 'task_id';
  return `
CREATE TRIGGER ${table}_cdc_insert AFTER INSERT ON ${table} BEGIN
  INSERT INTO change_log (table_name, row_id, op, at)
  VALUES ('${table}', NEW.${taskRef}, 'insert', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER ${table}_cdc_update AFTER UPDATE ON ${table} BEGIN
  INSERT INTO change_log (table_name, row_id, op, at)
  VALUES ('${table}', NEW.${taskRef}, 'update', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER ${table}_cdc_delete AFTER DELETE ON ${table} BEGIN
  INSERT INTO change_log (table_name, row_id, op, at)
  VALUES ('${table}', OLD.${taskRef}, 'delete', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
`;
}

const M001_CORE = `
-- ── identity ─────────────────────────────────────────────────────────────────
CREATE TABLE org (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  gh_login      TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE repo (
  id              TEXT PRIMARY KEY,
  org_id          TEXT REFERENCES org(id),
  path            TEXT NOT NULL UNIQUE,
  gh_owner        TEXT,
  gh_name         TEXT,
  default_branch  TEXT NOT NULL,
  upstream_remote TEXT,
  fork_of         TEXT,
  default_agent   TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repo(id),
  title         TEXT NOT NULL,
  intent        TEXT NOT NULL,
  origin_kind   TEXT NOT NULL,
  origin_ref    TEXT,
  agent_id      TEXT,
  base_ref      TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  branch        TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  -- Durable key. Stable across other workspaces closing and across a substrate restart, but the
  -- full 'wN' form only: parse_workspace_id has a positional fallback for bare integers.
  substrate_workspace_id TEXT,
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX task_repo_idx ON task(repo_id);
CREATE INDEX task_archived_idx ON task(archived_at);

-- ── facts (§5.2) — the only durable truth. No status column anywhere. ─────────
CREATE TABLE agent_fact (
  task_id          TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  substrate_pane_id    TEXT,
  substrate_state      TEXT,
  last_event       TEXT,
  last_event_at    INTEGER,
  activity_text    TEXT,
  tool_name        TEXT,
  final_message    TEXT,
  agent_session_id TEXT,
  pane_alive       INTEGER NOT NULL DEFAULT 0,
  last_probe_at    INTEGER,
  probe_failures   INTEGER NOT NULL DEFAULT 0,
  terminated       INTEGER NOT NULL DEFAULT 0,
  -- §5.4.1 the monotonic gate. Written in the same transaction as the fact it guards.
  state_change_seq INTEGER NOT NULL DEFAULT 0,
  controller_generation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_fact_pane_idx ON agent_fact(substrate_pane_id);

CREATE TABLE verify_run (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  step_name   TEXT NOT NULL,
  cmd         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code   INTEGER,
  required    INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  log_path    TEXT NOT NULL
);
CREATE INDEX verify_run_task_idx ON verify_run(task_id, head_sha);

CREATE TABLE gate_request (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  gate            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  requested_at    INTEGER NOT NULL,
  decided_at      INTEGER,
  decision        TEXT,
  decided_by      TEXT,
  executed_at     INTEGER,
  execution_error TEXT
);
CREATE INDEX gate_request_open_idx ON gate_request(task_id, decided_at);

CREATE TABLE scm_fact (
  task_id            TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  pr_number          INTEGER,
  pr_url             TEXT,
  pr_state           TEXT,
  pr_head_sha        TEXT,
  pr_draft           INTEGER,
  checks_state       TEXT,
  review_state       TEXT,
  unresolved_threads INTEGER NOT NULL DEFAULT 0,
  mergeable          TEXT,
  fetched_at         INTEGER NOT NULL,
  -- §11.1 a failed fetch is a fact, not a state change.
  fetch_failed_at    INTEGER
);

CREATE TABLE turn_checkpoint (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  ref_name    TEXT NOT NULL,
  sha         TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  trigger     TEXT NOT NULL
);
CREATE INDEX turn_checkpoint_task_idx ON turn_checkpoint(task_id, captured_at);

-- ── change data capture (§5.4) — INVARIANT: one event path ───────────────────
CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  op         TEXT NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX change_log_seq_idx ON change_log(seq);
`;

/**
 * M1 — the verify plan per repo, and lane bindings per task.
 *
 * `verify_plan` is stored per repo and carries `needs_review`: §10.1 is explicit that an
 * inferred command is never run silently the first time, so the flag is part of the durable
 * record rather than a UI state.
 *
 * `task_lane` records which the substrate tab is which. Deliberately a separate table rather than
 * columns on `task`: lanes are created lazily (`verify` on first run, §8.2 step 4) and a row
 * that appears later is cleaner than a column that is null until it is not.
 */
const M002_VERIFY = `
CREATE TABLE verify_plan (
  repo_id     TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
  steps_json  TEXT NOT NULL,
  -- §10.1 the plan is shown to the user and editable before first use.
  needs_review INTEGER NOT NULL DEFAULT 1,
  derived_at  INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE TABLE task_lane (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  lane    TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (task_id, lane)
);

-- §10.2 verification is required before gate.pr_open can be approved. That is a policy
-- default, overridable per repo, and the override is recorded rather than silent.
ALTER TABLE repo ADD COLUMN verify_required_for_pr INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repo ADD COLUMN verify_override_reason TEXT;

-- §9 rule 5 — gitignored-but-needed paths mirrored into every worktree.
ALTER TABLE repo ADD COLUMN mirror_paths_json TEXT;
`;

/**
 * M3 — repository conventions (§13).
 *
 * **Naming deviation, deliberate.** §5.3 specifies `convention.status`. This calls the column
 * `lifecycle` instead, because §20.1's mechanical rule is "no column named `status`, anywhere"
 * and that blanket form is what makes §6 unbreakable — a rule with one carve-out is a rule
 * someone widens later. A convention's lifecycle is genuinely durable data (mined, confirmed,
 * retired) rather than something derived, so only the *name* was in tension, and renaming costs
 * nothing while keeping the invariant enforceable by a linter rather than by memory.
 * Recorded as PRD-DELTA #16.
 */
const M003_CONVENTIONS = `
CREATE TABLE convention (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  -- Imperative, one sentence. §13.5 injects these verbatim.
  rule_text     TEXT NOT NULL,
  rationale     TEXT,
  confidence    REAL NOT NULL,
  -- 'candidate' | 'active' | 'retired' | 'rejected'  (§5.3 calls this 'status'; see above)
  lifecycle     TEXT NOT NULL,
  mined_at      INTEGER NOT NULL,
  last_confirmed_at INTEGER,
  retired_reason TEXT
);
CREATE INDEX convention_repo_idx ON convention(repo_id, lifecycle);

-- §13.1 INVARIANT: a convention with zero evidence rows is not a convention. The foreign key
-- makes evidence deletable only with its rule; the write path rejects unciteable rules.
CREATE TABLE convention_evidence (
  id            TEXT PRIMARY KEY,
  convention_id TEXT NOT NULL REFERENCES convention(id) ON DELETE CASCADE,
  -- 'merged_pr' | 'rejected_pr' | 'review_comment' | 'doc' | 'ci_config'
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL,
  excerpt       TEXT,
  observed_at   INTEGER NOT NULL
);
CREATE INDEX convention_evidence_idx ON convention_evidence(convention_id);

-- §13.4 — incremental re-mining needs to know how far it got.
CREATE TABLE mine_run (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  -- The newest PR considered, so the next run starts after it.
  high_water_pr INTEGER,
  observations INTEGER NOT NULL DEFAULT 0,
  candidates  INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX mine_run_repo_idx ON mine_run(repo_id, started_at);
`;

/**
 * M3 — the measurement §13.6 demands.
 *
 * "This feature exists to move one number: **review rounds to merge.** Instrument it from day
 * one." A comparison needs to know which side of the line each task fell on, and that is only
 * knowable at launch — by the time a PR merges, the conventions have changed. So the count is
 * recorded when the context file is written.
 *
 * A separate table rather than a column on `task`, for the same reason `task_lane` is separate:
 * it exists only for tasks that were actually launched, and a row that appears later is cleaner
 * than a column that is null until it is not.
 */
const M004_INJECTION = `
CREATE TABLE task_injection (
  task_id     TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  rule_count  INTEGER NOT NULL,
  -- Rules that were active but did not fit the §13.5 budget.
  omitted     INTEGER NOT NULL DEFAULT 0,
  injected_at INTEGER NOT NULL
);
`;

/**
 * M3 — mining progress, because mining takes minutes.
 *
 * A 300-pull-request first run is not a request-response operation. The run happens in the
 * background and the UI polls, which means progress has to live somewhere durable rather than in
 * the promise nobody is awaiting: an in-memory counter would vanish on restart and would be
 * invisible to a second window looking at the same daemon.
 *
 * `phase` doubles as the liveness signal — a row with `finished_at IS NULL` whose phase is
 * `interrupted` is a run whose daemon died, which is a different thing from a run still going.
 */
const M005_MINE_PROGRESS = `
ALTER TABLE mine_run ADD COLUMN phase TEXT;
ALTER TABLE mine_run ADD COLUMN progress_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mine_run ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0;
`;

/**
 * M6 — multi-agent chats. A chat is a set of tasks sharing `chat_id`; each task is one lane.
 * Existing rows become one-lane chats by backfilling `chat_id` from the task id.
 */
const M006_CHAT_LANES = `
ALTER TABLE task ADD COLUMN chat_id TEXT;
UPDATE task SET chat_id = id WHERE chat_id IS NULL;
CREATE INDEX task_chat_idx ON task(chat_id);
`;

/**
 * M7 — attached lanes. `worktree_path` NULL means the lane runs in the repository checkout.
 * Existing rows keep their paths (isolated). `external_block` is a fact for quota/auth exits
 * so they cannot be derived as awaiting_review.
 */
const M007_ATTACHED = `
PRAGMA foreign_keys=OFF;

CREATE TABLE task_m7 (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repo(id),
  title         TEXT NOT NULL,
  intent        TEXT NOT NULL,
  origin_kind   TEXT NOT NULL,
  origin_ref    TEXT,
  agent_id      TEXT,
  chat_id       TEXT,
  base_ref      TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  branch        TEXT NOT NULL,
  worktree_path TEXT,
  substrate_workspace_id TEXT,
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL
);

INSERT INTO task_m7 (
  id, repo_id, title, intent, origin_kind, origin_ref, agent_id, chat_id,
  base_ref, base_sha, branch, worktree_path, substrate_workspace_id, archived_at, created_at
)
SELECT
  id, repo_id, title, intent, origin_kind, origin_ref, agent_id, chat_id,
  base_ref, base_sha, branch, worktree_path, substrate_workspace_id, archived_at, created_at
FROM task;

DROP TABLE task;
ALTER TABLE task_m7 RENAME TO task;
CREATE INDEX task_repo_idx ON task(repo_id);
CREATE INDEX task_archived_idx ON task(archived_at);
CREATE INDEX task_chat_idx ON task(chat_id);

CREATE TRIGGER task_cdc_insert AFTER INSERT ON task BEGIN
  INSERT INTO change_log (table_name, row_id, op, at)
  VALUES ('task', NEW.id, 'insert', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
CREATE TRIGGER task_cdc_update AFTER UPDATE ON task BEGIN
  INSERT INTO change_log (table_name, row_id, op, at)
  VALUES ('task', NEW.id, 'update', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
CREATE TRIGGER task_cdc_delete AFTER DELETE ON task BEGIN
  INSERT INTO change_log (table_name, row_id, op, at)
  VALUES ('task', OLD.id, 'delete', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

ALTER TABLE agent_fact ADD COLUMN external_block TEXT;

PRAGMA foreign_keys=ON;
`;

const M008_CHAT_TURNS = `
CREATE TABLE chat_turn (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id),
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  origin      TEXT NOT NULL,
  text        TEXT NOT NULL,
  delivery    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX chat_turn_task_seq ON chat_turn (task_id, seq);
`;

const M009_COMPOSER_READY = `
ALTER TABLE agent_fact ADD COLUMN composer_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_fact ADD COLUMN prompt_surface TEXT;
ALTER TABLE chat_turn ADD COLUMN error TEXT;
UPDATE agent_fact SET composer_ready = 1
 WHERE pane_alive = 1 AND substrate_state IN ('idle', 'done');
`;

/**
 * M10 — isolated lanes may check out an existing branch (`checkout_ref`) instead of cutting
 * `osade/<slug>`. `pr_head_ref` is the GitHub head branch so a review loop can offer a lane
 * on that branch rather than forking it.
 */
const M010_CHECKOUT_REF = `
ALTER TABLE task ADD COLUMN checkout_ref TEXT;
ALTER TABLE scm_fact ADD COLUMN pr_head_ref TEXT;
`;

const M011_MEMORY_FTS = `
CREATE TABLE memory (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  scope_id       TEXT,
  kind           TEXT NOT NULL,
  text           TEXT NOT NULL,
  source_task_id TEXT,
  source_agent   TEXT,
  verified_by    TEXT,
  confidence     REAL NOT NULL,
  ecosystem_tag  TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  superseded_by  TEXT
);
CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory', content_rowid='rowid');
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

/**
 * Tables the retrieval indexer projects into Moss — OSADE-MOSS §M.1.4.
 *
 * Only tables that exist at migration 12. `policy_clause`, `code_chunk` and `pr_record` join
 * this list with the migrations that create them (14–16); a namespace with no source table
 * simply indexes nothing, which is why the port can ship before the features behind it.
 */
export const RETRIEVAL_TABLES = [
  'chat_turn',
  'gate_request',
  'verify_run',
  'agent_fact',
  'convention',
  'convention_evidence',
  // Migration 14. F1's chunks reach the `code` namespace the same way everything else reaches
  // its own: as rows, through the one indexer (R1). Nothing in F1 writes to Moss directly.
  'code_chunk',
  // Migration 16 — F4's clauses, into the `policies` namespace.
  'policy_clause',
  // Migration 17 — F1's verified fixes, into `turns` with verified = '1'.
  'fix_pattern',
  // Migration 15 — incoming pull requests, into `prs` for near-duplicate detection.
  'pr_record',
] as const;

/**
 * The subset that existed when migration 12 ran.
 *
 * A migration is a statement about a schema at a point in time, so it cannot be generated from
 * a list that later grows: adding `code_chunk` to `RETRIEVAL_TABLES` would otherwise make
 * migration 12 try to put a trigger on a table three migrations away from existing, and every
 * fresh database would fail to boot. Each later table brings its own triggers with it.
 */
const M012_TRIGGER_TABLES = [
  'chat_turn',
  'gate_request',
  'verify_run',
  'agent_fact',
  'convention',
  'convention_evidence',
] as const;

export type RetrievalTable = (typeof RETRIEVAL_TABLES)[number];

/**
 * §M.1.4 — why `change_log` could not be reused.
 *
 * `change_log.row_id` is the *task* a change belongs to, because it exists to push `TaskView`s
 * (ARCH §6.2). The indexer needs the row's own key to re-read and re-project it, and it needs
 * rows for tables that have no task at all (conventions, and later policies). It is also pruned
 * to 50 000 rows, which the indexer's cursor cannot tolerate. So: a second log, its own cursor,
 * pruned only up to what has been consumed.
 */
function retrievalTriggers(table: RetrievalTable): string {
  const key = table === 'agent_fact' ? 'task_id' : 'id';
  // §M.1.4 — activity text churns at ~1 Hz and would bury real events in the `turns`
  // namespace, so agent_fact reaches the index on transitions only.
  const gate =
    table === 'agent_fact'
      ? `WHEN NEW.last_event IN ('to_review', 'to_in_progress') OR NEW.terminated = 1 OR NEW.external_block IS NOT NULL`
      : '';
  return `
CREATE TRIGGER ${table}_ret_insert AFTER INSERT ON ${table} ${gate} BEGIN
  INSERT INTO retrieval_log (table_name, row_id, op, at)
  VALUES ('${table}', NEW.${key}, 'insert', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER ${table}_ret_update AFTER UPDATE ON ${table} ${gate} BEGIN
  INSERT INTO retrieval_log (table_name, row_id, op, at)
  VALUES ('${table}', NEW.${key}, 'update', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER ${table}_ret_delete AFTER DELETE ON ${table} BEGIN
  INSERT INTO retrieval_log (table_name, row_id, op, at)
  VALUES ('${table}', OLD.${key}, 'delete', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
`;
}

/**
 * M12 — the retrieval layer (§M.1) and the per-turn context pack (§M.2).
 *
 * `retrieval_doc` is the FTS5 adapter's storage *and* the doc-count source for stats. It is a
 * derived table like everything else under R1: `osade index rebuild` truncates it and
 * re-projects from the fact tables, and nothing reads it as truth.
 *
 * It deliberately carries no CDC triggers. The index changing is not a fact about a task, and
 * putting index churn on the one event path would push a message to every client on every
 * agent turn.
 */
const M012_RETRIEVAL = `
CREATE TABLE retrieval_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,     -- the row's own key, NOT the task id
  op         TEXT NOT NULL,     -- 'insert' | 'update' | 'delete'
  at         INTEGER NOT NULL
);
CREATE INDEX retrieval_log_seq_idx ON retrieval_log(seq);

CREATE TABLE retrieval_cursor (
  consumer TEXT PRIMARY KEY,    -- 'indexer'
  last_seq INTEGER NOT NULL
);

-- The FTS5 fallback's store (§M.1.2). Same documents, same ids, same metadata as Moss.
CREATE TABLE retrieval_doc (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL,
  text       TEXT NOT NULL,
  meta_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX retrieval_doc_ns_idx ON retrieval_doc(ns);

CREATE VIRTUAL TABLE retrieval_doc_fts USING fts5(
  text, content='retrieval_doc', content_rowid='rowid'
);
CREATE TRIGGER retrieval_doc_ai AFTER INSERT ON retrieval_doc BEGIN
  INSERT INTO retrieval_doc_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER retrieval_doc_ad AFTER DELETE ON retrieval_doc BEGIN
  INSERT INTO retrieval_doc_fts(retrieval_doc_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER retrieval_doc_au AFTER UPDATE ON retrieval_doc BEGIN
  INSERT INTO retrieval_doc_fts(retrieval_doc_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO retrieval_doc_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- §M.2.4 — one row per assembled turn. A CDC table, so the chip and the live latency
-- readout update through the one event path (ARCH §5.2).
CREATE TABLE context_pack (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  chat_turn_id  TEXT REFERENCES chat_turn(id),
  arm           TEXT,                 -- 'digest_on' | 'digest_off' | NULL (not in an experiment)
  backend       TEXT NOT NULL,        -- 'moss' | 'fts5'
  retrieval_ms  REAL NOT NULL,        -- max of the parallel queries: the wall time the turn paid
  assembly_ms   REAL NOT NULL,
  tokens_used   INTEGER NOT NULL,
  overflow      INTEGER NOT NULL,
  degraded      INTEGER NOT NULL DEFAULT 0,
  items_json    TEXT NOT NULL,        -- [{id, ns, score, src_table, src_id}] — ids only, no text
  created_at    INTEGER NOT NULL
);
CREATE INDEX context_pack_task_idx ON context_pack(task_id, created_at);
CREATE INDEX context_pack_turn_idx ON context_pack(chat_turn_id);
`;

/**
 * M14 — F1, self-maintaining APIs (OSADE-MOSS §M.5.2).
 *
 * Three things here are load-bearing and easy to misread as bookkeeping:
 *
 *   - **`migration.changes_confirmed_at`.** Extracted changes are inert until a human confirms
 *     them. This is `verify_plan.needs_review` (§10.1) applied to a second inferred artefact:
 *     work a model inferred is never run silently the first time.
 *   - **`call_site.confirmed` is nullable.** NULL means "nobody has looked yet", which is not
 *     the same as rejected. Discovery maximises recall on purpose (§M.5.5); the agent and then
 *     verification decide what was real, and collapsing the three states into a boolean would
 *     throw away the distinction the whole two-stage design rests on.
 *   - **`discovery_miss`.** A site verification found that discovery did not. Recording it is
 *     how recall improves from real failures rather than guessed test cases (§M.5.8).
 *
 * No column here is a status. `migration_target` carries no progress field: F1's progress is
 * derived from its lanes' task statuses, exactly as §M.3 requires.
 */
const M014_MIGRATION = `
CREATE TABLE migration (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  package TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  changelog_text TEXT NOT NULL,
  sdk_diff_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- §M.5.3 — nothing downstream runs until these are set.
  changes_confirmed_at INTEGER,
  changes_confirmed_by TEXT
);

CREATE TABLE migration_change (
  id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES migration(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'rename' | 'signature' | 'removal' | 'behavior'
  old_symbol TEXT,
  new_symbol TEXT,
  description TEXT NOT NULL,
  source TEXT NOT NULL,                -- 'changelog' | 'sdk_diff' | 'user'
  -- §M.5.3 INVARIANT: the changelog line or diff hunk this came from, verbatim. A row whose
  -- evidence is not present in the model's input is dropped before it reaches this table.
  evidence TEXT NOT NULL
);
CREATE INDEX migration_change_idx ON migration_change(migration_id);

CREATE TABLE migration_target (
  migration_id TEXT NOT NULL REFERENCES migration(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repo(id),
  wave INTEGER NOT NULL,               -- 0 = canary
  arm TEXT NOT NULL,                   -- 'digest_on' | 'digest_off'  (§M.5.7)
  stratum TEXT NOT NULL,               -- e.g. 'sites:6-20|loc:10k-50k'
  task_id TEXT REFERENCES task(id),    -- NULL until launched
  -- §M.5.5 — what the discovery run cost and what it could not read, per repo. Recorded
  -- rather than recomputed: the comparison is evidence, and evidence has to survive a
  -- restart to be worth putting on a screen.
  discovery_ms REAL NOT NULL DEFAULT 0,
  unparsed_files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (migration_id, repo_id)
);
CREATE INDEX migration_target_task_idx ON migration_target(task_id);

CREATE TABLE code_chunk (
  id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES migration(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  symbol TEXT,
  kind TEXT NOT NULL,                  -- 'function' | 'import' | 'call' | 'derived_wrapper'
  hop INTEGER NOT NULL DEFAULT 0,      -- transitive depth, §M.5.4
  enriched_text TEXT NOT NULL,
  base_sha TEXT NOT NULL
);
CREATE INDEX code_chunk_scope_idx ON code_chunk(migration_id, repo_id);

CREATE TABLE call_site (
  id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES migration(id) ON DELETE CASCADE,
  change_id TEXT NOT NULL REFERENCES migration_change(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  chunk_id TEXT REFERENCES code_chunk(id),
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  via TEXT NOT NULL,                   -- 'direct' | 'alias' | 'wrapper'
  score REAL,
  found_by TEXT NOT NULL,              -- 'moss' | 'grep' | 'both'
  confirmed INTEGER,                   -- NULL unknown, 1 confirmed, 0 rejected
  confirmed_by TEXT,                   -- 'agent' | 'verify'
  UNIQUE (migration_id, change_id, repo_id, file, line)
);
CREATE INDEX call_site_scope_idx ON call_site(migration_id, repo_id);

CREATE TABLE discovery_miss (
  id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES migration(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  pattern TEXT NOT NULL,
  verify_run_id TEXT NOT NULL REFERENCES verify_run(id),
  fixture_path TEXT
);
CREATE INDEX discovery_miss_idx ON discovery_miss(migration_id, repo_id);
`;

/**
 * M16 — F4, compliance on the gate (OSADE-MOSS §M.8.1).
 *
 * **INVARIANT C1: a compliance flag without a cited clause is not a flag.** That is why
 * `gate_clause.clause_id` is a foreign key and why there is no free-text column anywhere in
 * this schema for "a model thinks this might be risky". Every clause shown on an approval card
 * traces to a heading in a Markdown file at a known `file_sha`, and a reader can open it.
 *
 * **INVARIANT C2: retrieval informs; humans decide.** Nothing here blocks execution. The only
 * thing that gates the approve button is `requires_ack`, which a human wrote into a policy
 * file — and the ack is recorded with who and when, because §M.8.4's audit export has to be
 * able to say that a named person saw a named clause.
 */
const M016_POLICY = `
CREATE TABLE policy (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                 -- 'repo' | 'global'
  repo_id TEXT REFERENCES repo(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  -- The content hash of the file the clauses were read from. An approval binds to the clauses
  -- as they were, so the version has to be recoverable later (§M.8.4).
  file_sha TEXT NOT NULL,
  title TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  UNIQUE (scope, repo_id, path)
);

CREATE TABLE policy_clause (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policy(id) ON DELETE CASCADE,
  clause_ref TEXT NOT NULL,            -- e.g. 'SEC-3.2', taken from the heading
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  -- §M.8.3 — the one thing that can gate the approve button, and only because a human wrote it.
  requires_ack INTEGER NOT NULL DEFAULT 0,
  applies_to TEXT                      -- optional path globs, one per line
);
CREATE INDEX policy_clause_policy_idx ON policy_clause(policy_id);

CREATE TABLE gate_clause (
  gate_id TEXT NOT NULL REFERENCES gate_request(id) ON DELETE CASCADE,
  hunk_ref TEXT NOT NULL,              -- 'path:startLine'
  clause_id TEXT NOT NULL REFERENCES policy_clause(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  acked_by TEXT,
  acked_at INTEGER,
  PRIMARY KEY (gate_id, hunk_ref, clause_id)
);
CREATE INDEX gate_clause_gate_idx ON gate_clause(gate_id);
`;

/**
 * M17 — F1's verified fix patterns (OSADE-MOSS §M.5.5).
 *
 * A row here means: a required verification passed at this head SHA, and this normalised hunk
 * was part of what passed. That is the strongest evidence one lane can hand another, which is
 * why §M.2.2 weights it above a convention and filters the sibling digest on `verified = '1'`.
 *
 * `pattern_hash` is the dedupe key: five lanes applying the same one-line fix collapse to one
 * cited line with a count rather than five near-identical ones.
 */
const M017_FIX_PATTERN = `
CREATE TABLE fix_pattern (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  migration_id TEXT,
  verify_run_id TEXT NOT NULL REFERENCES verify_run(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  -- α-renamed identifiers, whitespace stripped, then hashed (§M.5.5).
  pattern_hash TEXT NOT NULL,
  -- The readable hunk, for the cited line the agent actually sees.
  hunk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, head_sha, file, line)
);
CREATE INDEX fix_pattern_hash_idx ON fix_pattern(pattern_hash);
CREATE INDEX fix_pattern_task_idx ON fix_pattern(task_id);
`;

/**
 * M15 — F3, human-approval attestation and slop signals (OSADE-MOSS §M.7).
 *
 * The record this table exists to make is narrow and worth stating exactly: *this Osade
 * instance attests that the GitHub user it authenticated approved this exact commit after
 * these checks passed.* It is only worth anything because A1 (§M.7.1) makes `head_sha` part of
 * what was approved — an attestation over a payload that did not pin a commit would be signing
 * a claim nobody could check.
 *
 * `statement_json` is stored verbatim rather than rebuilt on read. A signature covers bytes,
 * and bytes that get regenerated are bytes that can drift.
 *
 * **INVARIANT A2 (§M.7.5): signals are never acted on publicly without a gate.** `pr_signal`
 * has no "action" column and no "resolved" flag for that reason: nothing here closes, labels or
 * comments on anything. A maintainer replying to a duplicate goes through `gate.pr_comment`
 * like any other public speech.
 */
const M015_ATTESTATION = `
CREATE TABLE attestation (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  gate_id TEXT NOT NULL REFERENCES gate_request(id) ON DELETE CASCADE,
  -- Canonical JSON: sorted keys, no whitespace, 'v' first. Stored as signed.
  statement_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  -- 1 = this install's key vouches for the identity; 2 = the approver's own SSH key does.
  tier INTEGER NOT NULL DEFAULT 1,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attestation_task_idx ON attestation(task_id);
CREATE INDEX attestation_head_idx ON attestation(head_sha);

CREATE TABLE pr_record (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  body_excerpt TEXT NOT NULL,
  -- Structural, not free text: files touched plus normalised hunk hashes (§M.7.5).
  diff_summary TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);

CREATE TABLE pr_signal (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  -- 'near_duplicate' | 'attested' | 'attestation_stale' | 'attestation_invalid'
  kind TEXT NOT NULL,
  related_pr INTEGER,
  -- Shown, never a verdict. The label reads "similar to #412 (0.91)", never "spam".
  score REAL,
  detail_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, pr_number, kind, related_pr)
);
CREATE INDEX pr_signal_repo_idx ON pr_signal(repo_id, pr_number);
`;

/**
 * M13 — F2, multiplayer lanes (OSADE-MOSS §M.6.2).
 *
 * **GitHub login is the only identity.** There is no Osade account, no password column and no
 * local user table — because §M.6.3 needs `decided_by` to mean something outside this machine,
 * and "alice" only means something if GitHub says who alice is.
 *
 * **INVARIANT: the token is never stored.** `member_session.token_hash` is a sha256 of an
 * opaque random string; the string itself goes to the client once and is never written down.
 * A database that leaks cannot be replayed as a session. The teammate's *GitHub* token is used
 * once, to answer "who are you", and discarded — every GitHub write still uses the host's
 * token, behind gates.
 *
 * `presence` and `task_claim` are CDC tables and deliberately carry no status: who is looking
 * at a lane and who is driving it are facts, and the UI derives "is Priya here?" from a
 * heartbeat timestamp rather than from a boolean someone has to remember to clear.
 */
const M013_MEMBERS = `
CREATE TABLE member (
  login TEXT PRIMARY KEY,               -- GitHub login, the only identity
  role TEXT NOT NULL,                   -- 'owner' | 'maintainer' | 'viewer'
  invited_by TEXT NOT NULL,
  invited_at INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE TABLE member_session (
  -- sha256 of an opaque random token. The token itself is never stored, anywhere.
  token_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL REFERENCES member(login) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX member_session_login_idx ON member_session(login);

-- §M.6.5 — how far each member has read, so catch-up knows what "since you left" means.
CREATE TABLE member_cursor (
  login TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL,
  PRIMARY KEY (login, chat_id)
);

CREATE TABLE presence (                 -- CDC table; row_id = task_id
  login TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (login, task_id)
);

-- §M.6.7 — advisory. It records who is driving; it does not lock anything.
CREATE TABLE task_claim (               -- CDC table; row_id = task_id
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (task_id, login)
);

-- §M.6.2 — 'github:<login>' | 'agent:<id>' | 'automation'. Null for pre-F2 rows.
ALTER TABLE chat_turn ADD COLUMN author TEXT;
`;

/**
 * M18 — a gate keeps the clauses it was shown (OSADE-MOSS §M.8.4).
 *
 * The bug: `gate_clause.clause_id` cascaded from `policy_clause`, and a policy reload replaces
 * a changed file's clauses by deleting its `policy` row. The daemon reloads at every boot, so
 * editing a policy file — or deleting one — silently erased "clauses shown" and "clauses
 * acknowledged" from every gate that had ever cited it, *including decided ones*. The audit
 * export then reported that a named person approved with no policy in front of them.
 *
 * The fix is to record the citation as it was shown: ref, title, text, the policy file and its
 * hash, and whether it required an ack. C1 still holds — a row can only be written by copying
 * a real clause (see `GateClauses.record`) — but it no longer depends on that clause still
 * existing. `clause_id` stays, unconstrained, so a pending gate can be matched against the
 * current clause set on reload.
 *
 * `unbound_at` is when the cited clause stopped existing while the gate had not yet executed.
 * An unbound row leaves the gate's clause hash, so an approval made against the old text fails
 * its re-hash (§M.8.5 criterion 2) — but the row stays, because the approver *did* see it.
 * It is a timestamp, not a status: the gate's state is still derived (§6).
 *
 * `gate_clause` is a leaf, so the rebuild is safe: nothing references it, and dropping a child
 * table never cascades.
 */
const M018_GATE_CLAUSE_SNAPSHOT = `
CREATE TABLE gate_clause_m18 (
  gate_id TEXT NOT NULL REFERENCES gate_request(id) ON DELETE CASCADE,
  hunk_ref TEXT NOT NULL,
  clause_id TEXT NOT NULL,
  clause_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  scope TEXT NOT NULL,
  policy_path TEXT NOT NULL,
  file_sha TEXT NOT NULL,
  requires_ack INTEGER NOT NULL,
  score REAL NOT NULL,
  acked_by TEXT,
  acked_at INTEGER,
  unbound_at INTEGER,
  PRIMARY KEY (gate_id, hunk_ref, clause_id)
);

INSERT INTO gate_clause_m18
  (gate_id, hunk_ref, clause_id, clause_ref, title, text, scope, policy_path, file_sha,
   requires_ack, score, acked_by, acked_at)
SELECT gc.gate_id, gc.hunk_ref, gc.clause_id, pc.clause_ref, pc.title, pc.text, p.scope, p.path,
       p.file_sha, pc.requires_ack, gc.score, gc.acked_by, gc.acked_at
  FROM gate_clause gc
  JOIN policy_clause pc ON pc.id = gc.clause_id
  JOIN policy p ON p.id = pc.policy_id;

DROP TABLE gate_clause;
ALTER TABLE gate_clause_m18 RENAME TO gate_clause;
CREATE INDEX gate_clause_gate_idx ON gate_clause(gate_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'core tables, facts, change_log',
    sql: M001_CORE + CORE_CDC_TABLES.map(cdcTriggers).join('\n'),
  },
  {
    id: 2,
    name: 'verify plan, task lanes, repo verification policy',
    sql: M002_VERIFY,
  },
  {
    id: 3,
    name: 'repository conventions, evidence, mine runs',
    sql: M003_CONVENTIONS,
  },
  {
    id: 4,
    name: 'convention injection, recorded per launch for §13.6',
    sql: M004_INJECTION,
  },
  {
    id: 5,
    name: 'mining progress, for runs that take minutes',
    sql: M005_MINE_PROGRESS,
  },
  {
    id: 6,
    name: 'chat_id on task, backfilled for one-lane chats',
    sql: M006_CHAT_LANES,
  },
  {
    id: 7,
    name: 'nullable worktree_path for attached lanes, external_block fact',
    sql: M007_ATTACHED,
  },
  {
    id: 8,
    name: 'durable chat turns — typed send, not pane scrape',
    sql: M008_CHAT_TURNS + cdcTriggers('chat_turn'),
  },
  {
    id: 9,
    name: 'composer_ready fact, pane snapshot, failed-turn error',
    sql: M009_COMPOSER_READY,
  },
  {
    id: 10,
    name: 'checkout_ref on task, pr_head_ref on scm_fact',
    sql: M010_CHECKOUT_REF,
  },
  {
    id: 11,
    name: 'memory with FTS5 retrieval, no vector store',
    sql: M011_MEMORY_FTS,
  },
  {
    id: 12,
    name: 'retrieval log, cursor, FTS5 doc store, per-turn context packs',
    sql:
      M012_RETRIEVAL +
      M012_TRIGGER_TABLES.map(retrievalTriggers).join('\n') +
      cdcTriggers('context_pack'),
  },
  {
    id: 13,
    name: 'F2 — members, sessions, cursors, presence and lane claims',
    sql: M013_MEMBERS + cdcTriggers('presence') + cdcTriggers('task_claim'),
  },
  {
    id: 14,
    name: 'F1 — migrations, changes, targets, code chunks, call sites, discovery misses',
    sql: M014_MIGRATION + retrievalTriggers('code_chunk'),
  },
  {
    id: 15,
    name: 'F3 — attestations, PR records, and the signals a maintainer triages by',
    sql: M015_ATTESTATION + cdcTriggers('attestation') + retrievalTriggers('pr_record'),
  },
  {
    id: 16,
    name: 'F4 — policies, clauses, and the clauses bound into a gate',
    sql: M016_POLICY + retrievalTriggers('policy_clause'),
  },
  {
    id: 17,
    name: 'F1 — verified fix patterns, the evidence one lane hands another',
    sql: M017_FIX_PATTERN + retrievalTriggers('fix_pattern'),
  },
  {
    id: 18,
    name: 'F4 — gate clauses snapshot the citation, so a policy reload cannot erase the audit',
    sql: M018_GATE_CLAUSE_SNAPSHOT,
  },
];
