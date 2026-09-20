# Osade × Moss — PRD

Four features built on Osade's existing core, with Moss as the shared retrieval layer:

| # | Feature | YC Fall 2026 RFS | One line |
| --- | --- | --- | --- |
| F1 | Self-maintaining APIs | Self-Maintaining APIs | An SDK ships a breaking change; Osade finds affected call sites across repos and runs one gated agent lane per repo to a verified PR |
| F2 | Multiplayer lanes | Multiplayer AI | Teammates join the same live session, catch up instantly, redirect agents and approve gates under their own identity |
| F3 | Human-approval attestation | Proving You're Human (inverted) | Every Osade PR carries a signed record that a named human approved that exact commit; maintainers get near-duplicate PR detection |
| F4 | Compliance on the gate | AI-Native Compliance | Every diff-bearing gate shows the policy clauses its hunks touch; the gate trail exports as audit evidence |

Hackathon track: **Multiplayer AI and Collaborative Agents** (YC Fall 2026 × Moss, Zero Latency Builder Sprint).

**Numbering.** Sections in this document are `§M.n`. A bare `§n` points into `docs/OSADE.md`;
`ARCH §n` points into `docs/ARCHITECTURE.md`. Every existing invariant in ARCH §5 still holds.
Where this PRD deliberately changes one (§M.6.1 changes ARCH §5.5's network posture), it says so
and names the replacement guarantee.

---

## §M.0 Goal and non-goals

### §M.0.1 Goal

The goal is unchanged from §0.1: reduce the maintainer's review cost per contribution. The four
features serve it as follows:

- **F1** produces contributions that are *mechanical and verifiable*, which are the cheapest kind
  of PR to review.
- **F2** lets a team, rather than one person, carry the review and approval load.
- **F3** lets a maintainer know, before reading a diff, that a named human approved this exact commit.
- **F4** puts the rules a change must obey in front of the approver at the moment of approval.

Moss is on the **hot path** in all four. The hackathon's judging question is "where does speed
matter?". The answer is §M.2: retrieval runs on every agent turn, across N parallel lanes, so its
latency multiplies.

### §M.0.2 Non-goals

1. **Moss is not a database.** It is never a source of truth, never written except by the indexer
   (§M.1.4), and always rebuildable from SQLite.
2. **No model decides anything.** Retrieval surfaces cited context. Verification decides
   correctness, and humans decide approval and compliance. There is no "AI says this is compliant".
3. **Osade still never merges** (§1 non-goal 3).
4. **No agent framework.** Agents remain the user's installed CLIs (Claude Code, Codex, OpenCode).
   No LangChain, CrewAI or equivalent enters the tree.
5. **No auto-discovery of dependents on GitHub** in the sprint. F1 targets are repos the user names.
6. **TypeScript only** for F1 call-site discovery in the sprint.
7. **No remote terminal access** for teammates (§M.6.6).
8. **No automatic public speech.** Slop detection (F3) and compliance flags (F4) never comment,
   close or label anything on GitHub without a gate.

---

## §M.1 The retrieval layer (shared foundation)

### §M.1.1 Moss facts this design relies on

These facts come from docs.moss.dev as read on 2026-09-20. Anything not verified is listed in
§M.12 (open questions).

- The JS SDK is `@moss-js/moss`, constructed as `new MossClient(projectId, projectKey)`.
- A **session** (`client.session(name, modelId?)` → `SessionIndex`) is an in-process index:
  - `addDocs`, `deleteDocs`, `getDocs` and `query` run in memory with no per-operation network call.
  - `query` is hybrid (keyword + semantic) and takes `{ topK, alpha, filter, embedding }`.
  - Credentials are validated when the session is opened.
  - `pushIndex()` optionally uploads the session to the cloud.
  - `saveToDisk(path)` / `loadFromDisk(path)` persist a session locally.
- The document shape is `{ id, text, metadata? }`. Metadata is a string map, and upserts replace
  documents with the same `id`.
- Metadata filters support `$eq $ne $gt $gte $lt $lte $in $nin`, composed with `$and` / `$or`.
  They are evaluated in memory on a session.
- Models: `moss-minilm` (the default) and `moss-mediumlm`, both embedded in-process, plus `custom`
  (bring your own vectors).
- `alpha` blends semantic and keyword scoring: 1.0 is pure semantic, 0.0 pure keyword, and the
  default is 0.8.
- The free Developer plan allows **3 indexes** per project. Local queries are never metered.

### §M.1.2 Placement

- Moss runs **inside the daemon**, never in Electron and never in the renderer.
  - The daemon already owns every other shared resource.
  - It is the only process teammates reach (F2).
  - The daemon runs on Node ≥ 22 (ARCH §2.2), which matches Moss's Node / Electron-main usage.
- New directory: `packages/daemon/src/retrieval/`.
  - **Enforced by lint:** `@moss-js/moss` may be imported only under `retrieval/**`. This is the
    same pattern as `scm/**` and `substrate/**` (ARCH §17).
- Everything above that directory speaks through a port:

```ts
// retrieval/port.ts: no Moss types cross this line
export interface RetrievalPort {
  upsert(ns: Namespace, docs: IndexDoc[]): Promise<void>
  remove(ns: Namespace, ids: string[]): Promise<void>
  query(ns: Namespace, q: string, opts: RetrievalQuery): Promise<RetrievalHit[]>
  stats(): RetrievalStats            // doc counts, p50/p95 query ms, backend: 'moss' | 'fts5'
}

export type Namespace = 'turns' | 'conventions' | 'policies' | 'code' | 'prs'

export interface IndexDoc {
  id: string                          // see §M.1.5
  text: string
  meta: Record<string, string>        // string map, matching Moss's document schema
}

export interface RetrievalQuery {
  topK: number
  alpha?: number                      // per-namespace default, §M.1.6
  filter?: MetaFilter                 // Osade's own filter type, translated in the adapter
  minScore?: number
}

export interface RetrievalHit { id: string; score: number; text: string; meta: Record<string, string> }
```

Adapters:

- `MossAdapter`: the real backend.
- `Fts5Adapter`: the fallback. It runs over the existing SQLite FTS5 machinery (migration 11
  pattern) and supports the same filter subset, applied as SQL `WHERE` clauses on the metadata.
- `FakeRetrieval`: an in-memory implementation for unit tests. It means no test needs a Moss key
  or a network, the same reasoning as `ModelPort` in ARCH §13.2.

### §M.1.3 Sessions, not cloud indexes; local-only by default

Each namespace is one Moss **session**, named `osade.<installId>.<ns>`.

- **Local-only.** `pushIndex()` is never called unless `config.json` sets
  `retrieval.cloudSync: true`. Transcripts, code chunks and policy text do not leave the machine by
  default. This is ARCH §2.2 state containment applied to Moss.
- **Warm boot.** On clean shutdown and every 10 minutes, each session is saved with
  `saveToDisk(~/.osade/moss/<ns>/)`. On boot the daemon tries `loadFromDisk` first.
- **The cache is disposable.** A missing or corrupt cache triggers a rebuild (§M.1.4). It is never
  an error.
- **Index budget.** The Developer plan's 3-index limit applies to cloud indexes. Whether un-pushed
  sessions count against it is §M.12 Q1. If they do, the adapter collapses all namespaces into a
  single session with a mandatory `ns` metadata filter. The port does not change; only the
  adapter does.

### §M.1.4 The indexer: the only writer

**INVARIANT R1: Moss is a derived view. The indexer is its only writer, SQLite is its only
input, and it can be dropped and rebuilt at any time.**

The existing `change_log` is unsuitable as the indexer's input:

- It is keyed by task (`row_id = task_id`, ARCH §6.2) because it exists to push `TaskView`s.
- It is pruned to 50 000 rows.
- It does not cover non-task tables such as conventions and policies.

So migration 12 adds a second log with its own consumer:

```sql
CREATE TABLE retrieval_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,     -- the row's own key, NOT the task id
  op         TEXT NOT NULL,     -- 'insert' | 'update' | 'delete'
  at         INTEGER NOT NULL
);
CREATE TABLE retrieval_cursor (
  consumer TEXT PRIMARY KEY,    -- 'indexer'
  last_seq INTEGER NOT NULL
);
```

- Triggers are generated by `retrievalTriggers()`, alongside `cdcTriggers()`, for:
  `chat_turn`, `gate_request`, `verify_run`, `agent_fact` (a filtered subset, see below),
  `convention`, `convention_evidence`, `policy_clause`, `code_chunk`, `pr_record`.
- `retrieval/indexer.ts` runs every 250 ms:
  1. Read `retrieval_log` rows after the cursor, `LIMIT 500`.
  2. Collapse them to the latest op per `(table, row_id)`.
  3. Load each row from SQLite and project it to `IndexDoc[]` with a pure projector function per table.
  4. Call `upsert` / `remove`.
  5. Advance the cursor in **one transaction** with a `retrieval_log` prune up to the cursor.
- **The Moss write and the cursor advance cannot be atomic across the SQLite / Moss boundary.**
  So the indexer is **idempotent by construction**: ids are deterministic (§M.1.5) and Moss
  upserts replace by id. The failure order is: write Moss, then advance the cursor. A crash
  between the two replays the batch harmlessly.
- `agent_fact` is indexed only for transitions (`to_review`, `to_in_progress`, `blocked`,
  `terminated`), never for 1 Hz activity text. Activity churn would dominate the `turns`
  namespace and bury real events.
- **Rebuild.** `osade index rebuild [--ns <ns>]` and the tRPC `indexRebuild` drop the sessions and
  re-project every row from the source tables. The rebuild is also triggered automatically when:
  - the cache fails to load,
  - the model id changes, or
  - `retrieval_log` has been pruned past the cursor, which cannot happen in normal operation but
    is checked anyway.
- **Enforced by:**
  - a lint selector: `RetrievalPort#upsert` / `#remove` may only be called from `retrieval/indexer.ts`;
  - `test/integration/retrieval-rebuild.test.ts`: index, drop, rebuild, and assert an identical id set;
  - `test/unit/projectors.test.ts`: every projector is pure and deterministic.

**INVARIANT R2: nothing enters the index without provenance.** Every `IndexDoc.meta` carries
`src_table`, `src_id`, and at least one of `url` / `head_sha` / `run_id` / `gate_id`. The
projector type makes these fields required, so a projector that omits them does not compile.

**INVARIANT R3: retrieval never fails an operation.** These all degrade the result, never the
caller:

- a query timeout (25 ms budget),
- a Moss exception, or
- a failure to open a session (for example, no network at boot while credentials are validated).

In each case the adapter switches to `Fts5Adapter`, sets `stats().backend = 'fts5'`, and the UI
shows a degraded-retrieval badge. This follows the same discipline as the failed probe
(ARCH §5.1): a degraded dependency changes a fact about confidence, never a task's state.

### §M.1.5 Document ids and metadata

- The id is `<ns>:<src_table>:<src_id>[:<chunk_n>]`. It is deterministic, so re-projection is idempotent.
- Metadata keys are shared across namespaces. All values are strings (Moss's schema).

| key | meaning |
| --- | --- |
| `ns` | namespace (redundant under per-ns sessions; mandatory under the collapsed fallback) |
| `src_table`, `src_id` | provenance (R2) |
| `repo_id`, `task_id`, `chat_id` | scope filters |
| `migration_id`, `change_id` | F1 scope |
| `kind` | e.g. `turn.user`, `turn.agent`, `gate.decided`, `verify.fail`, `fix_pattern`, `clause` |
| `verified` | `'1'` only when backed by a passing `verify_run` for the same `head_sha` |
| `head_sha` | freshness filter |
| `seq` | zero-padded to 12 digits so lexical `$gt` equals numeric order (see §M.12 Q3) |
| `author` | `github:<login>`, `agent:<id>` or `policy:<name>` |
| `url` | evidence link where one exists |

### §M.1.6 Per-namespace settings

| ns | model | default alpha | why |
| --- | --- | --- | --- |
| `turns` | `moss-minilm` | 0.8 | natural-language history |
| `conventions` | `moss-minilm` | 0.8 | prose rules |
| `policies` | `moss-minilm` | 0.7 | prose, but clause ids and terms matter |
| `code` | `moss-mediumlm` (see §M.12 Q4) | 0.5 | identifiers carry half the signal; pure semantic loses exact symbol matches |
| `prs` | `moss-minilm` | 0.8 | title, body and summary similarity |

### §M.1.7 Latency instrumentation

Every `query` records wall time. The daemon keeps a 1 000-sample ring per namespace and exposes
p50 / p95 through `retrievalStats`. Samples are **not** stored per query in SQLite: that would put
a write on the hot path to measure the hot path. Per-turn totals are durable, in `context_pack`
(§M.2.4).

**Targets** (sprint acceptance, measured on the demo laptop):

- Moss `query` p50 < 10 ms and p95 < 20 ms per namespace, at ≤ 50 000 docs per namespace.
- Full context assembly (§M.2), including filters and budget, p95 < 30 ms.

---

## §M.2 Per-turn context assembly (the hot path)

This is where Moss earns its place. Every `agent.prompt` Osade sends goes through the context
assembler first.

### §M.2.1 Where it hooks in

`domain/chat-turns.ts` already builds each prompt:

- a shared preamble,
- the per-agent body, and
- an `<osade_lanes>` sibling digest, which `renderer/chat.ts` strips from the visible transcript.

The assembler replaces the static digest with a retrieved block:

```text
<osade_context budget="1200" used="1034" overflow="7" pack="cp_01J…">
## Conventions relevant to this change
- [conv:412] Imports from `@moss-js/moss` go through `src/lib/moss.ts`. (evidence: PR #88, #91, #97)
## What sibling lanes learned (verified)
- [fix:acme-web@3f1c] `client.search(q)` → `client.query(idx, q, {topK})`; tests pass. (lane 3, run r_77)
## Earlier in this chat
- [turn:1432] Reviewer (github:priya) asked to keep the wrapper signature stable.
</osade_context>
```

- `renderer/chat.ts` strips `<osade_context>` exactly as it strips `<osade_lanes>`.
- The UI instead shows a collapsed "context pack" chip on each turn: item count, tokens used,
  overflow count and retrieval ms. It expands to the cited items.
- Every bracketed id is a link to its source row.

### §M.2.2 The pipeline

`ContextAssembler.build(taskId, turnText): ContextPack` has five stages. The code decides; the
model only reads.

1. **Scope.** Build filters from the task: `repo_id`, `chat_id`, and `migration_id` when the task
   belongs to an F1 migration.
2. **Retrieve.** Run the namespace queries in parallel (`Promise.all`), each with its own `topK`
   and `alpha`:
   - `conventions`: k = 8, filter `repo_id`.
   - `turns`: k = 8, filter `chat_id`, excluding turns already in the agent's own recent context
     (the last 6 turns of this task).
   - `turns` again for **sibling lanes**, k = 12, filter `migration_id` (or `chat_id`),
     `task_id $ne self`, `verified $eq '1'`, `kind $in ['fix_pattern', 'verify.fail_resolved', 'gate.rejected']`.
     **This retrieval only runs when the lane's A/B arm is `digest_on` (§M.5.7).**
3. **Filter, in code, after retrieval.**
   - *Freshness:* drop items whose `head_sha` is not an ancestor of, or equal to, the lane's
     current base or head. This is the same rule as stale verification (ARCH §8).
   - *Dedupe:* collapse items with the same `pattern_hash` (§M.5.5) into one line with a count.
   - *Score floor:* drop hits below the namespace's `minScore`, calibrated during the sprint.
   - *Provenance:* drop any hit whose `src_id` no longer exists in SQLite. The index may lag the
     truth, and the truth wins.
4. **Budget.** Items are ordered by `score × source_weight`, where source_weight is: sibling
   verified fix 1.3, convention 1.0, turn 0.8. Items are appended until the token budget is reached
   (default 1 200, per-repo configurable, estimated at 4 chars per token). The remainder is counted
   as `overflow`, **not appended**. This is the rule from ARCH §13.3 that the cap is the feature,
   now applied per turn.
5. **Record.** Write one `context_pack` row, then render the block.

### §M.2.3 Why per turn and not only at launch

`CONTEXT.md` (ARCH §13.3) is written once, at launch. A lane that runs 40 turns while 10 sibling
lanes are finishing sees none of their verified fixes, because they didn't exist when its file was
written.

Per-turn retrieval keeps each lane current. The cost is one assembly per turn per lane. At 15 lanes
× 40 turns that is 600 assemblies per migration, each on the critical path before the prompt is
sent. This is exactly the workload the hackathon brief describes: fast retrieval that meaningfully
improves the product. `CONTEXT.md` is still written at launch as the stable baseline.

### §M.2.4 `context_pack` table (migration 12, CDC table)

```sql
CREATE TABLE context_pack (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id),
  chat_turn_id  TEXT REFERENCES chat_turn(id),
  arm           TEXT,                 -- 'digest_on' | 'digest_off' | NULL (not in an experiment)
  backend       TEXT NOT NULL,        -- 'moss' | 'fts5'
  retrieval_ms  REAL NOT NULL,        -- sum of wall time of parallel queries (max, not sum)
  assembly_ms   REAL NOT NULL,
  tokens_used   INTEGER NOT NULL,
  overflow      INTEGER NOT NULL,
  items_json    TEXT NOT NULL,        -- [{id, ns, score, src_table, src_id}] — ids only, no text
  created_at    INTEGER NOT NULL
);
```

- `items_json` stores ids, not text. The text is reconstructible from the source rows, and storing
  it twice would make `context_pack` the largest table in the database.
- Adding it to `CDC_TABLES` means the per-turn chip and the live latency readout update through
  the one event path (ARCH §5.2).

---

## §M.3 Data model changes

The migrations are numbered, forward-only and transactional (ARCH §6). **No new column is a status.**

| # | adds | feature |
| --- | --- | --- |
| 12 | `retrieval_log` + triggers, `retrieval_cursor`, `context_pack` (CDC) | §M.1, §M.2 |
| 13 | `member`, `member_session`, `member_cursor`, `presence` (CDC), `task_claim` (CDC), `chat_turn.author` | F2 |
| 14 | `migration`, `migration_change`, `migration_target`, `code_chunk`, `call_site`, `discovery_miss` | F1 |
| 15 | `attestation` (CDC), `pr_record`, `pr_signal` | F3 |
| 16 | `policy`, `policy_clause`, `gate_clause` | F4 |

Table definitions live in each feature section. The existing `deriveStatus` table (ARCH §8)
**does not change**:

- F1 progress is derived from its lanes' task statuses.
- F2 adds no task states.
- A stale F3 attestation is a PR-level fact (§M.7.4).
- F4 is advisory context on gates that already exist.

---

## §M.4 Contract and API surface

Every procedure declares a contract `.output()` (ARCH §6.4). The new procedures:

| procedure | kind | feature | role required (F2) |
| --- | --- | --- | --- |
| `retrievalStats` | query | shared | viewer |
| `indexRebuild` | mutation | shared | owner |
| `contextPackGet` | query | shared | viewer |
| `migrationCreate`, `migrationChangesConfirm`, `migrationTargetsSet` | mutation | F1 | maintainer |
| `migrationDiscover`, `migrationLaunchWave` | mutation | F1 | maintainer |
| `migrationView` | query | F1 | viewer |
| `authExchange`, `authLogout` | mutation | F2 | — |
| `memberInvite`, `memberRemove`, `memberSetRole` | mutation | F2 | owner |
| `presenceBeat` | mutation | F2 | viewer |
| `catchUp`, `askHistory` | query | F2 | viewer |
| `taskClaim`, `taskRelease` | mutation | F2 | maintainer |
| `attestationGet`, `attestationVerify` | query | F3 | viewer |
| `prSignals` | query | F3 | viewer |
| `policyReload` | mutation | F4 | maintainer |
| `gateClauses` | query | F4 | viewer |
| `auditExport` | query | F4 | maintainer |

- The CLI mirrors them (§17 symmetry): `osade migrate …`, `osade share`, `osade join`,
  `osade catchup`, `osade ask`, `osade attest verify`, `osade audit export`, `osade index rebuild`.
- `TaskView` gains only small fields: `turns[].author`, `presence[]` (logins viewing this task),
  `claimedBy`, and `lastContextPack` (the chip summary). Full packs are fetched on demand.
  This deliberately avoids growing the per-push payload any further. `turns` on `TaskView` is
  already the heaviest field; moving it to its own stream is out of scope here but noted in §M.12.

---

## §M.5 F1: Self-maintaining APIs

### §M.5.1 User story

> The SDK my team maintains (or depends on) ships v2 with renamed methods. I paste the changelog,
> point Osade at our 4 repos, and watch parallel agents migrate each one. I approve each PR after
> seeing that it passed that repo's own checks.

### §M.5.2 Tables (migration 14)

```sql
CREATE TABLE migration (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, package TEXT NOT NULL,
  from_version TEXT, to_version TEXT NOT NULL,
  changelog_text TEXT NOT NULL, sdk_diff_ref TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  changes_confirmed_at INTEGER, changes_confirmed_by TEXT
);
CREATE TABLE migration_change (
  id TEXT PRIMARY KEY, migration_id TEXT NOT NULL REFERENCES migration(id),
  kind TEXT NOT NULL,                  -- 'rename' | 'signature' | 'removal' | 'behavior'
  old_symbol TEXT, new_symbol TEXT, description TEXT NOT NULL,
  source TEXT NOT NULL,                -- 'changelog' | 'sdk_diff' | 'user'
  evidence TEXT NOT NULL               -- the changelog line or diff hunk it came from
);
CREATE TABLE migration_target (
  migration_id TEXT NOT NULL REFERENCES migration(id), repo_id TEXT NOT NULL REFERENCES repo(id),
  wave INTEGER NOT NULL,               -- 0 = canary
  arm TEXT NOT NULL,                   -- 'digest_on' | 'digest_off'
  stratum TEXT NOT NULL,               -- e.g. 'sites:6-20|loc:10k-50k'
  task_id TEXT REFERENCES task(id),    -- NULL until launched
  PRIMARY KEY (migration_id, repo_id)
);
CREATE TABLE code_chunk (
  id TEXT PRIMARY KEY, migration_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  file TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  symbol TEXT, kind TEXT NOT NULL,     -- 'function' | 'import' | 'call' | 'derived_wrapper'
  hop INTEGER NOT NULL DEFAULT 0,      -- transitive depth, §M.5.4
  enriched_text TEXT NOT NULL, base_sha TEXT NOT NULL
);
CREATE TABLE call_site (
  id TEXT PRIMARY KEY, migration_id TEXT NOT NULL, change_id TEXT NOT NULL REFERENCES migration_change(id),
  repo_id TEXT NOT NULL, chunk_id TEXT REFERENCES code_chunk(id),
  file TEXT NOT NULL, line INTEGER NOT NULL,
  via TEXT NOT NULL,                   -- 'direct' | 'alias' | 'wrapper'
  score REAL, found_by TEXT NOT NULL,  -- 'moss' | 'grep' | 'both'
  confirmed INTEGER,                   -- NULL unknown, 1 agent/verify confirmed, 0 rejected
  confirmed_by TEXT                    -- 'agent' | 'verify'
);
CREATE TABLE discovery_miss (
  id TEXT PRIMARY KEY, migration_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  file TEXT NOT NULL, line INTEGER NOT NULL, pattern TEXT NOT NULL,
  verify_run_id TEXT NOT NULL REFERENCES verify_run(id), fixture_path TEXT
);
```

### §M.5.3 Stage 1: changes from the changelog

- The input is changelog text, optionally with an SDK diff (two package versions, or a git range
  in the SDK repo).
- A **headless run** of an installed agent (ARCH §13.2 `ModelPort`) extracts `migration_change`
  rows as JSON, which zod validates against the contract.
- **The model may only cite changelog lines or diff hunks that are in its input.** Rows with
  unmatched evidence are dropped. This is the same rule as the conventions miner.
- Extracted changes start unconfirmed. `migrationChangesConfirm` records who confirmed them, and
  nothing downstream runs until confirmation. This follows the `verify_plan.needs_review` rule:
  inferred work is never run silently the first time.
- For the demo, the user may enter changes by hand (`source: 'user'`).

### §M.5.4 Stage 2: chunk, enrich, and index the targets

- **Parser.** `web-tree-sitter` (WASM) with the TypeScript and TSX grammars.
  - WASM rather than a native addon, because ARCH §2.2 already documents what one native ABI
    costs this project.
  - Confined to `packages/daemon/src/knowledge/code/**` (a new lint seam).
- **Input.** Each target repo at its pinned base SHA.
  - The read happens from the attached repo path; no worktree is needed for read-only parsing.
  - `node_modules`, `dist`, `build`, generated files and anything gitignored are excluded.
- **Chunks.**
  - One per function / method / arrow-function declaration.
  - One per import declaration of the migrated package.
  - One per call expression whose callee resolves to an imported binding.
- **Enrichment.** `enriched_text` is the code plus a resolved-context header, for example:
  `// calls moss.MossClient#search via local alias "m" (import * as m from "@moss-js/moss") in fn searchDocs`.
  This makes aliases and wrappers findable by meaning, not by string.
- **Transitive closure** (the answer to wrappers of wrappers):
  - Any function whose body contains an affected call becomes a **derived affected symbol**
    (`kind = 'derived_wrapper'`, `hop = n`).
  - Its own call sites are then chunked at `hop = n + 1`.
  - This repeats until a fixed point or `hop = 3`, whichever comes first.
  - The resolution is intra-repo only, by name and import resolution. There is no type checker in
    the sprint.
- **Indexing.** Chunks are rows in `code_chunk`, so they reach Moss through the indexer (R1). They
  go into the `code` namespace with `migration_id` and `repo_id` metadata.

### §M.5.5 Stage 3: discovery

`migrationDiscover(migrationId)` runs, for each change and each target repo:

1. A **Moss query**:
   - query text: the change description plus the old symbol,
   - `alpha = 0.5`,
   - filter `migration_id` and `repo_id`,
   - `topK = 50`, `minScore` calibrated during the sprint.
2. A **grep baseline**: `git grep -n <old_symbol>` at the base SHA.
3. The results are merged into `call_site` with `found_by ∈ {moss, grep, both}`.

The `migrationView` UI shows the comparison per repo:

- sites found by both,
- sites found only by Moss (the alias and wrapper wins),
- sites found only by grep (Moss misses, which are also recorded),
- Moss query latency per change.

**Recall and precision are deliberately split between stages:**

- Discovery maximises recall. A false positive costs one agent glance.
- Precision is guaranteed later: the agent confirms or rejects each candidate (`confirmed_by = 'agent'`),
  and **verification is the arbiter** (`confirmed_by = 'verify'`).
- Nothing in discovery is ever trusted as "these are all the sites".

**`pattern_hash`**, used for sibling dedupe in §M.2.2:

- When a lane's verification passes for its head SHA, each diff hunk that touches a `call_site` is
  normalised: identifiers are α-renamed and whitespace is stripped.
- The normalised hunk is hashed.
- The hunk is recorded as a `fix_pattern` event carrying that hash, and the indexer projects it
  into `turns` with `verified = '1'`.

### §M.5.6 Stage 4: launch in waves

- `migrationLaunchWave(migrationId, wave)` calls the **existing** `LaunchTask` for each target in
  the wave. There is no new orchestration:
  - `origin: 'api_migration'`,
  - an isolated worktree on `osade/migrate-<pkg>-<to>/<agentId>`,
  - one lane per repo, all in one chat (`chat_id = migration:<id>`) so they share a transcript
    and sibling digests.
- `CONTEXT.md` for these lanes adds two sections:
  - **Changes**: the confirmed `migration_change` rows with their evidence.
  - **Candidate call sites**: file:line, `via`, and score. The file states that candidates may be
    wrong and that the agent must confirm or reject each one.
- **Wave 0 (canaries)** is 2–3 targets, chosen as one per stratum where possible.
  - Wave 1+ is gated in the UI, not by a timer: the launch button enables once at least one canary
    has a passing verify run for its head.
  - This turns the cold-start problem into a scheduling decision. Later waves start with verified
    sibling fixes available.
- **Concurrency cap: 15 live lanes per daemon.** This comes from the substrate subscriber's
  connection-per-pane model (ARCH §4.6). Waves above the cap queue.

### §M.5.7 The digest A/B experiment

- **Assignment.** When targets are set:
  - Repos are bucketed into strata by call-site count (1–5 / 6–20 / 21+) × LOC (<10k / 10–50k / 50k+).
  - Within each stratum, arms are alternated so each stratum is balanced.
  - The arm is fixed at assignment and recorded on `migration_target`.
- **Effect.** `digest_off` lanes run the identical pipeline, minus the sibling-lane retrieval in
  §M.2.2 step 2. Conventions and own-chat turns are still retrieved, so the experiment isolates
  exactly one variable.
- **Metrics** are all derived by query, and none is stored as a conclusion:
  - first-attempt verify pass rate: the first `verify_run` per lane for which `required = 1` and
    `exit_code = 0`;
  - turns-to-green: `chat_turn` count until the first all-green run;
  - human edits at the gate: `gate_request` rows with `gateEditAndApprove` or `decision = rejected`;
  - tokens per successful migration: the sum of `context_pack.tokens_used` plus the agent-reported
    usage where available;
  - retrieval p50 / p95 during the run.
- **Honest limit.** With 4–8 demo repos this is a demonstration of the methodology, not a
  statistically meaningful result, and the UI says so (`n` is shown next to every number).

### §M.5.8 Discovery misses become fixtures

- When a verify run fails with a TypeScript diagnostic at `file:line`, and that site is not in
  `call_site` for this migration, a `discovery_miss` row is written.
- The row records the surrounding code pattern.
- `osade migrate misses export` writes each miss as a regression fixture under
  `packages/daemon/test/fixtures/code-discovery/`, so recall improves from real failures rather
  than guessed test cases.

### §M.5.9 Gates and PRs

- There are no new gates. `gate.push` and `gate.pr_open` apply per lane, and `gate.pr_open` still
  requires passing verification (ARCH §11).
- The PR body is generated with these sections:
  - the changes applied, each linking to changelog evidence;
  - call sites touched, marked confirmed or rejected;
  - verify results for the head SHA;
  - the F3 attestation block (§M.7).

### §M.5.10 Acceptance criteria

1. Given a changelog with 3 changes and 4 TS repos seeded with at least one aliased import and one
   two-level wrapper, discovery finds 100% of seeded sites. The UI shows at least 2 Moss-only hits
   that grep missed.
2. The Moss query p50 per change is < 10 ms.
3. The wave 0 canary reaches a passing verify run without human edits to code.
4. Wave 1 launches with sibling digests visible in at least one lane's context pack chip.
5. Every PR opened carries the change list, the site list and verify results. No PR opens without
   an approved `gate.pr_open`.
6. Deleting `~/.osade/moss/` and restarting reproduces identical discovery results.

---

## §M.6 F2: Multiplayer lanes

### §M.6.1 The deliberate change to ARCH §5.5

ARCH §5.5 says the daemon binds `127.0.0.1` only. F2 needs other machines to connect.

**New posture:** `config.json → server.listen: 'loopback' | 'lan'`, default `'loopback'`.

**INVARIANT M1: the daemon refuses to bind a non-loopback address unless member auth and TLS are
both enabled.** There is no flag combination that exposes an unauthenticated or plaintext listener.

- **Enforced by:** `server/listen.ts` asserting the invariant at boot (fatal otherwise), plus
  `test/integration/listen-posture.test.ts`.

What stays true from §5.5:

- GitHub tokens are held in memory only and never in config.
- Nothing public happens without a gate.
- Osade never merges.

### §M.6.2 Identity and roles (migration 13)

```sql
CREATE TABLE member (
  login TEXT PRIMARY KEY,               -- GitHub login, the only identity
  role TEXT NOT NULL,                   -- 'owner' | 'maintainer' | 'viewer'
  invited_by TEXT NOT NULL, invited_at INTEGER NOT NULL, removed_at INTEGER
);
CREATE TABLE member_session (
  token_hash TEXT PRIMARY KEY,          -- sha256 of an opaque random token; the token itself is never stored
  login TEXT NOT NULL REFERENCES member(login),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE member_cursor (            -- what each member has seen, for catch-up
  login TEXT NOT NULL, chat_id TEXT NOT NULL, last_seen_seq INTEGER NOT NULL,
  PRIMARY KEY (login, chat_id)
);
CREATE TABLE presence (                 -- CDC table; row_id = task_id
  login TEXT NOT NULL, task_id TEXT NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (login, task_id)
);
CREATE TABLE task_claim (               -- CDC table: who is driving a lane (advisory)
  task_id TEXT NOT NULL, login TEXT NOT NULL, claimed_at INTEGER NOT NULL, released_at INTEGER
);
ALTER TABLE chat_turn ADD COLUMN author TEXT;   -- 'github:<login>' | 'agent:<id>' | 'automation'
```

- **Owner.** The GitHub login of the host's token (from `safeStorage`, ARCH §12) becomes the owner
  at first LAN enable.
- **Invite.** `memberInvite(login, role)`: only invited logins can authenticate.
- **Join.**
  1. The teammate's Osade signs in to GitHub on *their* machine.
  2. Their Electron main process calls `authExchange` with that GitHub token.
  3. The daemon verifies it with `GET /user`, checks `member`, and returns an opaque session token
     (default expiry 12 h).
  4. **The teammate's GitHub token is used once, for verification, and discarded.** It is never
     stored and never used for writes. All GitHub writes still use the host's token, behind gates.
- **Transport.** The session token is sent as `Authorization: Bearer` on tRPC and as the first
  frame on the WebSocket. An unauthenticated WebSocket is closed before the snapshot is sent.
- **TLS.** In LAN mode the daemon generates a self-signed cert in `~/.osade/tls/`.
  - `osade share` prints a **join code**: `host:port`, the cert fingerprint, and a short invite nonce.
  - The joining client pins the fingerprint (trust on first use).
  - The recommended alternative for remote teams is a Tailscale / WireGuard address, which the
    same mechanism supports.

**Role matrix** (enforced in `server/router.ts` middleware, one place):

| action | viewer | maintainer | owner |
| --- | --- | --- | --- |
| see ledger, transcripts, diffs, context packs, catch-up | ✓ | ✓ | ✓ |
| send turns, claim / release lanes | | ✓ | ✓ |
| approve / reject / edit-approve gates | | ✓ | ✓ |
| launch tasks and migration waves | | ✓ | ✓ |
| lane shell, open-in-substrate, index rebuild, members, settings | | | ✓ |

### §M.6.3 `decided_by` becomes a real identity

- Gate decisions now record `decided_by = 'github:<login>'` from the authenticated session. The
  value is **never taken from the request body**.
- The local owner is `github:<ownerLogin>` too. The pre-F2 value (a local user) is migrated to the
  owner's login.
- `policy:<name>` downgrades are unchanged.
- **This is the prerequisite for F3.** An attestation is only as strong as the identity in
  `decided_by`.

### §M.6.4 Why the existing architecture is already most of F2

- **N clients need no merge logic.** Every client already discards local state and takes a
  snapshot on connect, and gaps are declared with `stream.reset` (ARCH §7.1).
- **No code path emits to clients except the CDC broadcaster.** Presence, claims and authored
  turns are rows, so they fan out automatically. Presence does not get its own WebSocket channel,
  because §5.2 forbids that.
- **The renderer has no filesystem access.** Files, diffs and transcripts are already daemon
  procedures (ARCH §2.3), so a remote renderer needs no new data paths. The only change is the
  endpoint and a bearer token, both held by Electron main.

The new client work:

- a "Join session" flow in Electron main: paste the join code, then store the endpoint and session
  token in `safeStorage`;
- a remote-mode badge;
- presence avatars on lanes;
- an author name on each turn;
- a claim indicator.

### §M.6.5 Catch-up and ask-history (Moss on the join path)

- **`catchUp(chatId)`** returns what changed since this member's `member_cursor.last_seen_seq`:
  - Moss `turns` query, filter `chat_id` plus `seq $gt last_seen`,
  - query text: a fixed prompt ("decisions, failures, approvals, redirections"),
  - `topK = 12`, with a guaranteed include of every gate decision and verify failure in the window,
    fetched by exact filter rather than similarity. The important events are never left to ranking.
  - Results are returned grouped by lane, each item cited to its source row.
  - Calling it advances the cursor.
- **`askHistory(chatId, question)`**: a free-text Moss query over `turns` (and `conventions` for
  the chat's repo). It returns up to 10 cited hits.
- **No LLM synthesis by default.** The answer *is* the cited hits, rendered as a list. This makes
  it instant and non-hallucinating.
- An optional "Summarise" button runs a headless agent over exactly those hits, and its output is
  labelled as a summary with the hit ids attached.
- **Latency target:** join-to-catch-up-rendered < 300 ms on LAN (snapshot plus catch-up in
  parallel). The Moss share of that is < 20 ms, and the UI shows it.

### §M.6.6 What remote teammates cannot do, and why

**INVARIANT M3: no procedure that executes arbitrary commands is reachable by a non-owner.**

- `taskShell*`: the lane shell is a real `node-pty` shell on the host (ARCH §2.4). Giving it to a
  teammate is giving them code execution on the owner's machine.
- `open-in-substrate`: attaches a terminal on the host.
- Verification-plan edits: an edited verify command is arbitrary code run on the host at the next
  verification.

Remote teammates watch lanes through `taskTranscript` (≤ 1 Hz), the turn history and the context
packs.

- **Enforced by:** the role middleware plus `test/integration/role-matrix.test.ts`, which iterates
  every procedure in the router and asserts its declared role. A new procedure without a role
  declaration fails the test.

### §M.6.7 Handoff

- `taskClaim` is advisory. It records who is driving and shows on the lane.
- A maintainer can send to a lane someone else has claimed. The composer warns "Priya is driving
  this lane" but does not block; the turn is authored, so the trail shows who redirected what.
- `taskRelease`, or a presence TTL expiry of 5 minutes with no heartbeat, clears the claim.

### §M.6.8 Acceptance criteria

1. Two laptops on one network: B joins A's daemon with a join code, sees the same ledger within
   1 s, and sees A's lanes live.
2. B, as a maintainer, approves a gate that A's agent requested. `gate_request.decided_by` is
   `github:<B>`, and the execution re-hash passes.
3. B leaves for 10 turns and returns. Catch-up renders ≤ 12 cited items, including every gate
   decision and verify failure in the window. The Moss latency is shown.
4. B (maintainer) calling `taskShellOpen` gets `FORBIDDEN`. The role-matrix test covers every procedure.
5. Starting the daemon with `listen: 'lan'` and auth disabled is a fatal boot error.

---

## §M.7 F3: Human-approval attestation and slop signals

### §M.7.1 Prerequisite: gates bind to the commit

This is the fix from the architecture review. Today a `gate.push` / `gate.pr_open` payload does
not pin the code being approved, so an agent could add commits between approval and execution.

**INVARIANT A1: every diff-bearing gate** (`gate.commit`, `gate.push`, `gate.pr_open`,
`gate.pr_update`, `gate.force_push`) **includes `head_sha` in its hashed payload.**
`gates.assertExecutable` re-reads the branch's current head immediately before the write and
aborts on mismatch. The error reads: "the branch moved after approval — re-approve".

- **Enforced by:**
  - a type: the gate payload schemas for those gates require `head_sha`;
  - `test/integration/gate-head-binding.test.ts`: approve, add a commit, execute, expect an abort.

### §M.7.2 The attestation record (migration 15)

```sql
CREATE TABLE attestation (              -- CDC table; row_id = task_id
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, gate_id TEXT NOT NULL REFERENCES gate_request(id),
  statement_json TEXT NOT NULL,          -- canonical JSON, §M.7.2
  signature TEXT NOT NULL, key_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
```

The statement is canonical JSON: sorted keys, no whitespace, and `v` first.

```json
{
  "v": 1,
  "repo": "owner/name",
  "head_sha": "…", "base_sha": "…",
  "gate": { "id": "…", "name": "gate.pr_open", "payload_hash": "sha256:…" },
  "approved_by": "github:priya", "approved_at": "2026-09-21T10:14:03Z",
  "verification": [{ "step": "test", "cmd": "pnpm test", "exit": 0, "head_sha": "…" }],
  "context": { "conventions_injected": 7, "policy_clauses_shown": ["SEC-3.2"], "clauses_acked": ["SEC-3.2"] },
  "agent": "claude",
  "osade_build": "sha256:…"
}
```

**Signing** has two tiers, and the tier is stated in the statement itself (`"tier": 1 | 2`).

- **Tier 1 (sprint).** An ed25519 install key at `~/.osade/keys/attest_ed25519`, generated on first
  use. The public key and `key_id` are published by committing `.osade/attestors.json` to the
  repo, or by pasting it into a gist.
  - What it proves: *this Osade instance attests that GitHub user X, whom it authenticated, approved
    this exact commit after these checks passed.*
  - What it trusts: the daemon's operator. That limit is written in the PR block and in the docs.
- **Tier 2 (post-sprint).** The approver signs on their own device with an SSH key already
  registered on their GitHub account (`ssh-keygen -Y sign -n osade-attestation`). The verifier
  checks the signature against `https://github.com/<login>.keys`.
  - This removes trust in the daemon operator for the identity claim.
  - It needs no new infrastructure, because GitHub already publishes the keys.

- Signing code lives only under `packages/daemon/src/attest/**` (a lint seam).
- The attestation is created **inside the same execution path** as the gated write, after
  `assertExecutable` and before the GitHub call. A write that fails leaves an attestation with no
  PR, which is harmless. A PR can never exist without the attestation, because the body contains it.

### §M.7.3 Delivery on GitHub

- **PR body:** a fenced block between `<!-- osade-attestation v1 -->` markers, containing the
  statement (base64), the signature, `key_id`, and a human-readable line:
  *"Approved by @priya for commit 3f1c2ab after `pnpm test` passed. Signed by Osade (tier 1)."*
- **Commit status** on the head SHA: `osade/human-approved`, state `success`, with a description
  naming the approver.
  - This uses the Statuses API, which works with the user token Osade already has. Check runs
    would need a GitHub App.
- Both writes happen within the already-approved `gate.pr_open` / `gate.pr_update`. They are part
  of the approved payload (the payload includes the PR body), not extra public speech.

### §M.7.4 Verification and staleness

- **`osade attest verify <pr-url>`** (and `attestationVerify`):
  1. Fetch the PR.
  2. Parse the block.
  3. Check that the signature verifies against the key in `.osade/attestors.json` at the base
     branch, or a key supplied on the command line.
  4. Check that the statement's `head_sha` equals the PR's current head.
- **Stale.** If new commits land after approval, `head_sha ≠ PR head` and the attestation is
  **stale**, not invalid.
  - The PR poller detects this and writes `pr_signal { kind: 'attestation_stale' }`.
  - Osade sets the commit status on the *new* head to `pending`: "no human approval for this commit".
  - The next approved `gate.pr_update` issues a fresh attestation.
- Status derivation is unchanged. Staleness is a signal shown on the PR card, not a task state.

### §M.7.5 Slop signals for maintainers

This half of F3 faces the other direction: helping a maintainer triage incoming PRs, from anyone
and made with anything.

```sql
CREATE TABLE pr_record (                -- indexed into ns 'prs'
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, number INTEGER NOT NULL, author TEXT NOT NULL,
  title TEXT NOT NULL, body_excerpt TEXT NOT NULL, diff_summary TEXT NOT NULL,
  head_sha TEXT NOT NULL, opened_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE TABLE pr_signal (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_number INTEGER NOT NULL,
  kind TEXT NOT NULL,     -- 'near_duplicate' | 'attested' | 'attestation_stale' | 'attestation_invalid'
  related_pr INTEGER, score REAL, detail_json TEXT, created_at INTEGER NOT NULL
);
```

- **Scope.** Repos where the signed-in user has maintain/admin permission. The existing issue
  poller (every 5 minutes, ARCH §12) adds open PRs to `pr_record`.
- **What is indexed.**
  - `diff_summary` is structural, not free text: the list of files touched plus the normalised
    hunk hashes from §M.5.5, rendered as text.
  - `body_excerpt` is the first 1 000 characters of the PR body.
  - Raw diffs are not indexed; they are too large and too noisy.
- **Near-duplicate detection.**
  - For each new record, query `prs` filtered to the same `repo_id` over the last 90 days, `topK = 5`.
  - Hits above the threshold, *or* sharing ≥ 50% of their hunk hashes, write
    `pr_signal { kind: 'near_duplicate', related_pr, score }`.
  - **The score is shown, not a verdict.** The label reads "similar to #412 (0.91)", never "spam".
- **Attestation signal.** A PR carrying a valid attestation gets `pr_signal { kind: 'attested' }`.
- **Triage ordering:**
  1. attested,
  2. unattested and unique,
  3. near-duplicate clusters, collapsed to one row with a count.
- **INVARIANT A2: signals are never acted on publicly without a gate.** No auto-close, auto-label
  or auto-comment. A maintainer replying to a duplicate cluster goes through `gate.pr_comment` like
  any other public speech.

### §M.7.6 Acceptance criteria

1. Approve a `gate.pr_open`, push another commit from the lane, then execute: the result is an
   abort with a re-approve message (A1).
2. An opened PR carries the block and the `osade/human-approved` status. `osade attest verify`
   passes, and it fails after one byte of the statement is edited.
3. A commit pushed to the PR after approval makes verify report `stale` and moves the status on the
   new head to `pending`.
4. Two demo PRs with the same normalised hunks produce a `near_duplicate` signal with a score and a
   link. Nothing is written to GitHub.

---

## §M.8 F4: Compliance on the gate

### §M.8.1 Policy sources (migration 16)

```sql
CREATE TABLE policy (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL,        -- 'repo' | 'global'
  repo_id TEXT, path TEXT NOT NULL, file_sha TEXT NOT NULL, title TEXT NOT NULL, loaded_at INTEGER NOT NULL
);
CREATE TABLE policy_clause (                       -- indexed into ns 'policies'
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policy(id),
  clause_ref TEXT NOT NULL,                        -- e.g. 'SEC-3.2', from the heading
  text TEXT NOT NULL, requires_ack INTEGER NOT NULL DEFAULT 0,
  applies_to TEXT                                  -- optional path globs from frontmatter
);
CREATE TABLE gate_clause (
  gate_id TEXT NOT NULL REFERENCES gate_request(id), hunk_ref TEXT NOT NULL,   -- 'path:startLine'
  clause_id TEXT NOT NULL REFERENCES policy_clause(id), score REAL NOT NULL,
  acked_by TEXT, acked_at INTEGER,
  PRIMARY KEY (gate_id, hunk_ref, clause_id)
);
```

- **Policy files:**
  - repo policies at `<repo>/.osade/policies/*.md`,
  - global policies at `~/.osade/policies/*.md`.
- **Format:** Markdown. Each `##` / `###` heading with an id prefix (`## SEC-3.2 Secrets in code`)
  is one clause.
  - Frontmatter may mark a clause `requires_ack: true` and give `applies_to` globs.
  - The format is plain enough to paste an internal policy, a SOC 2 control list or a licence rule into.
- `policyReload` re-reads the files. Clause rows are replaced when `file_sha` changes, and the
  indexer picks the change up through `retrieval_log`.

### §M.8.2 Clause retrieval on gate creation

When a diff-bearing gate is **requested** (not when it is opened in the UI):

1. Split the diff into hunks.
2. For each hunk, build a query from the file path and the hunk's added and removed lines,
   truncated to ~1 500 chars.
3. Run a Moss `policies` query: `alpha = 0.7`, `topK = 3`, `minScore` calibrated, filtered to
   `global` plus this repo, with `applies_to` globs checked in code after retrieval.
4. Write the `gate_clause` rows.
5. **Add `clauses_hash`** (the hash of the sorted `(hunk_ref, clause_id)` pairs) **to the gate payload
   before it is hashed.**

Because the clause set is part of the payload hash, approval binds to what was shown. If policies
change before approval, a reload recomputes the clauses and the payload hash changes, so the old
approval can't execute (ARCH §14 mechanics, unchanged).

The work is done at request time so that opening the gate card is instant. The hot path here is
gate creation across N lanes (commits and pushes), and the UI reads precomputed rows.

### §M.8.3 The gate card

- The existing `GateCard.tsx` gains a **"Policies this change touches"** section.
  - It lists each hunk with its clause chips: clause ref, title, score, and a link to the clause
    text and source file at `file_sha`.
  - A clause with `requires_ack` shows a checkbox.
  - **Approve is disabled until every `requires_ack` clause is acked.** Acks write `acked_by` / `acked_at`.
- **INVARIANT C1: a compliance flag without a cited clause is not a flag.** `gate_clause.clause_id`
  must reference an existing clause with a `file_sha`. There is no free-text "AI thinks this might
  be risky" field.
- **INVARIANT C2: retrieval informs; humans decide.** Clauses never block execution on their own.
  Only the explicit `requires_ack` rule, which a human wrote into the policy, gates the approve
  button. No model evaluates compliance.

### §M.8.4 Audit export

`osade audit export --since <date> [--repo <slug>] --format jsonl|csv` is a read-only projection.
Each gate row contains:

- the gate name, requester, `decided_by`, decision and timestamps,
- `payload_hash` and `head_sha`,
- verify results for that SHA,
- clauses shown and acked (with `file_sha`),
- the attestation id and signature where one exists,
- the execution result or error.

Nothing in the export is computed by a model. Every field is a stored fact or a hash of one.

### §M.8.5 Acceptance criteria

1. A repo with `.osade/policies/security.md` containing a `requires_ack` clause about committing
   secrets. An agent adds a hard-coded API key, and the `gate.commit` card shows that clause on the
   right hunk, with Approve disabled until acked.
2. Editing the policy file and reloading before approval changes the payload hash, and the earlier
   approval fails re-hash at execution.
3. The audit export for the demo session lists every gate with its approver, SHA, clauses, acks and
   attestation. Its row count equals the number of `gate_request` rows in the window.

---

## §M.9 Paths, config and enforced boundaries

### §M.9.1 New paths (all under `~/.osade`, ARCH §5.4)

```text
~/.osade/
├── moss/<ns>/                 Moss session snapshots (saveToDisk). Disposable.
├── keys/attest_ed25519        F3 tier-1 signing key (0600)
├── keys/attest_ed25519.pub
├── tls/cert.pem, tls/key.pem  F2 LAN mode (0600 key)
└── policies/*.md              F4 global policies
```

All of these come from `paths.ts`, like every other path.

### §M.9.2 New config (`config.json`, non-secret)

```json
{
  "retrieval": { "enabled": true, "cloudSync": false, "budgetTokens": 1200, "queryTimeoutMs": 25 },
  "server":    { "listen": "loopback", "port": 0, "sessionTtlHours": 12 },
  "migration": { "maxLiveLanes": 15, "maxHop": 3 },
  "attest":    { "tier": 1 }
}
```

- `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY` are secrets.
- They are stored in Electron `safeStorage` and passed to the daemon at spawn over the same env
  handshake as `OSADE_GITHUB_TOKEN` (ARCH §12). They are held in memory only.
- If they are absent, the retrieval layer boots on `Fts5Adapter` and says so.

### §M.9.3 New lint and test boundaries (additions to ARCH §17)

| rule | where | why |
| --- | --- | --- |
| `@moss-js/moss` only in `retrieval/**` | eslint | one retrieval seam |
| `RetrievalPort#upsert/remove` only in `retrieval/indexer.ts` | eslint | R1 |
| `web-tree-sitter` only in `knowledge/code/**` | eslint | one parser seam |
| signing primitives only in `attest/**` | eslint | one signing seam |
| every router procedure declares a role | `test/integration/role-matrix.test.ts` | M3 |
| non-loopback bind requires auth + TLS | boot assertion + `listen-posture.test.ts` | M1 |
| diff-bearing gate payloads require `head_sha` | contract types + `gate-head-binding.test.ts` | A1 |
| index is rebuildable to an identical id set | `retrieval-rebuild.test.ts` | R1 |
| each new lint selector fires | extend `test/unit/lint-rules.test.ts` | flat config silently drops selectors (ARCH §17) |

---

## §M.10 Failure modes (additions to ARCH §19)

| what is missing / broken | what happens |
| --- | --- |
| no Moss credentials | retrieval runs on FTS5; a badge says so; everything else works |
| Moss session open fails (no network while credentials are validated) | FTS5 fallback; retry with backoff (1 s → 60 s); switch back when open succeeds |
| query exceeds 25 ms | that query's result is dropped for this turn, the pack records `degraded`, and the turn proceeds |
| Moss cache corrupt or missing | rebuild from SQLite in the background; FTS5 serves meanwhile |
| indexer crashes mid-batch | the batch is replayed (idempotent ids); no duplicates |
| a hit references a deleted row | dropped at the provenance filter (§M.2.2 step 3) |
| tree-sitter fails on a file | the file is skipped and listed in `migrationView` as unparsed; grep still covers it |
| discovery misses a site | verification fails at it, a `discovery_miss` row is written, and the agent is told the site in the next turn |
| teammate session expires | the WebSocket closes with `auth_expired`; the client re-runs `authExchange` |
| a teammate is removed | their sessions are revoked immediately and the open WebSocket closes |
| LAN enabled without auth / TLS | fatal at boot (M1) |
| branch moved after approval | execution aborts; re-approval is required (A1) |
| policies changed after approval | payload hash mismatch; execution aborts |
| attestation key missing | generated on first use; a lost key means old attestations still verify only against the published pubkey |

---

## §M.11 Sprint plan and demo

### §M.11.1 Build order (cut lines marked ✂)

| phase | scope | done when |
| --- | --- | --- |
| P0 | retrieval layer: port, Moss + FTS5 adapters, `retrieval_log`, indexer, rebuild, stats | turns and conventions are indexed live; the rebuild test passes; p50 shown in a dev panel |
| P1 | context assembler + `context_pack` + turn chip | one lane shows packs with latency on every turn |
| P2 | F1 stages 1–4, one wave, grep vs Moss view | §M.5.10 criteria 1–3 |
| P3 | F1 waves + sibling digests + arms | §M.5.10 criteria 4–5 |
| ✂ | *below this line is cuttable in order* | |
| P4 | F4 clauses on gate card + `requires_ack` | §M.8.5 criterion 1 |
| P5 | A1 head binding + F3 tier-1 attestation in the PR body | §M.7.6 criteria 1–2 |
| P6 | F2 LAN + auth + roles + catch-up | §M.6.8 criteria 1–3 |
| P7 | F3 slop signals, audit export, attestation staleness | the rest |

- P6 is the headline for the Multiplayer track, but it is also the most infrastructure. If time is
  short, demo it as a second Electron instance on the same machine joined via loopback with auth
  on. It exercises the identity, roles and catch-up paths honestly, minus TLS.
- A1 (in P5) should land even if F3 is cut. It fixes a real hole in the existing gate model.

### §M.11.2 Demo script (5 minutes)

1. **(0:00) Setup.** Four seeded TS repos that use a fake "moss-sdk v1". Changelog: `search()` →
   `query()`, the options argument is now required, and `Index.delete` is removed.
2. **(0:40) Discovery.** Grep vs Moss side by side:
   - Moss finds the aliased import (`import * as m`) and the two-level wrapper;
   - grep misses both;
   - the per-change query latency is on screen.
3. **(1:30) Wave 0.** One canary lane. Its context pack chip shows retrieval ms on each turn. It
   goes green.
4. **(2:15) Fan-out.** Wave 1 launches three lanes. A `digest_on` lane's chip shows the canary's
   verified fix pattern, and it goes green on the first verify.
5. **(3:00) Multiplayer.** Laptop B joins with a join code. Catch-up renders instantly: "lane 2
   failed verify once; fixed by…".
   - B opens a `gate.commit` where an agent touched a config file. The `SEC-3.2` clause is shown
     with an ack checkbox.
   - B acks and approves; `decided_by = github:B`.
6. **(4:00) Attestation.** `gate.pr_open` is approved. The PR opens with the attestation block and
   the green `osade/human-approved` status. `osade attest verify` passes.
   - Push one more commit: the status flips to pending.
7. **(4:40) Numbers.** The A/B panel shows first-attempt pass rate and turns-to-green, with `n`
   displayed; retrieval p50 / p95 across the whole run.

### §M.11.3 Demo hygiene

- All PRs go to **forks or demo repos you own**. No real PRs on strangers' repos.
- Seed each demo repo with at least one aliased import and one wrapper; otherwise grep and Moss tie.
- Pre-warm the Moss sessions (`loadFromDisk`) before going on stage.

---

## §M.12 Open questions (verify before relying on them)

1. **Do un-pushed sessions count against the Developer plan's 3-index limit?** If yes, use the
   collapsed single-session layout (§M.1.3). The port does not change.
2. **Offline boot.** Credentials are validated when a session opens. Can `loadFromDisk` restore a
   session with no network? If not, offline boot is FTS5-only until the network returns (§M.10).
3. **Metadata comparisons.** Metadata values are strings, while the docs show `$lt` with a number.
   Confirm whether comparisons are numeric or lexical. Zero-padding `seq` (§M.1.5) makes either safe.
4. **`moss-minilm` vs `moss-mediumlm` on code chunks.** Measure recall on the seeded repos with
   both. Pick per namespace, and record the choice in `config.json`.
5. **The `@moss-js/moss` runtime.** Does it ship a native addon, and does it load under the
   daemon's Node 22 as well as in packaged builds (`extraResources`)? ARCH §2.2's ABI history
   says to check this on day one.
6. **Session size and memory.** Measure memory at 50k docs per namespace on the demo laptop, and
   set `maxDocs` guards if needed.
7. **`turns` on `TaskView`.** It is already the heaviest push payload. Splitting it into its own
   delta stream is worth doing before F2 puts several clients on one daemon, but it is out of scope
   for the sprint.

---

## §M.13 The shortest version

1. Moss is a derived, rebuildable index inside the daemon, with one writer, fed from a
   `retrieval_log` that triggers maintain. SQLite stays the only truth.
2. Every agent turn is assembled from filtered, budgeted, cited Moss retrievals in < 30 ms. That
   is the hot path that makes speed matter.
3. F1: Tree-sitter plus Moss find the call sites grep misses, waves of isolated lanes patch them,
   and verification decides.
4. F2: teammates join over authenticated TLS, approve under their own GitHub identity, and catch up
   from cited history in milliseconds. Nobody but the owner gets a shell.
5. F3: gates bind to the exact commit, and every PR carries a signed record of which human approved
   it after which checks.
6. F4: the policy clauses a diff touches are retrieved at gate creation, bound into the approval
   hash, and exported as audit evidence.