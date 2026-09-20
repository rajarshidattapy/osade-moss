import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type {
  ArmMetrics,
  DiscoveryComparison,
  DiscoveryMiss,
  MigrationArm,
  MigrationChange,
  MigrationMetrics,
  MigrationView,
} from '@osade/contract';

import type { Db } from '../db/index.js';
import { chunkRepo, isScannable, type SourceFile } from '../knowledge/code/chunker.js';
import { HeadlessModel } from '../knowledge/headless-model.js';
import { callPass, clip, type ModelPort } from '../knowledge/model.js';
import type { RetrievalService } from '../retrieval/service.js';
import { git } from './git.js';
import type { HeadlessRuns } from './headless-run.js';
import type { LaunchTask } from './launch-task.js';

/**
 * F1 — self-maintaining APIs (OSADE-MOSS §M.5).
 *
 * Four stages, and the ordering between them is the feature:
 *
 *   1. **Changes** are extracted from a changelog and are *inert until a human confirms them*
 *      (§M.5.3). Nothing below runs before that.
 *   2. **Chunks** are parsed, enriched with resolved context, and written as rows — which is how
 *      they reach Moss, through the one indexer (R1). Nothing here talks to a retrieval backend
 *      directly.
 *   3. **Discovery** runs retrieval *and* grep and records both, including retrieval's misses.
 *      It maximises recall on purpose and is never treated as an answer (§M.5.5).
 *   4. **Waves** launch through the existing `LaunchTask`. There is no new orchestration in
 *      this file — a migration lane is an ordinary lane with an origin and a shared chat.
 *
 * The recurring theme: **this module proposes; verification and humans decide.** No model
 * output reaches a durable row without its evidence being checked against the model's own
 * input, and no call site is ever recorded as fact.
 */

/** §M.9.2 `migration.maxLiveLanes` — from ARCH §4.6's connection-per-pane model. */
export const MAX_LIVE_LANES = 15;

/** §M.5.6 — wave 0 is 2–3 targets, one per stratum where possible. */
const CANARY_SIZE = 3;

export interface MigrationServiceOptions {
  readonly now?: () => number;
  readonly onWarning?: (message: string) => void;
  /**
   * §M.5.3 — how the changelog gets read.
   *
   * `model` is the port tests inject. `headless` is the production path: a `ModelPort` backed
   * by whichever agent CLI the user already installed, built lazily because constructing it
   * eagerly would make a daemon with no agent on PATH fail to start. Either may be absent —
   * hand-entered changes work without a model at all.
   */
  readonly model?: ModelPort | null;
  readonly headless?: HeadlessRuns | null;
  readonly retrieval?: RetrievalService | null;
  readonly launcher?: LaunchTask | null;
  readonly maxHop?: number;
}

export interface CreateMigrationInput {
  readonly provider: string;
  readonly package: string;
  readonly fromVersion?: string | null;
  readonly toVersion: string;
  readonly changelogText: string;
  readonly sdkDiffRef?: string | null;
  readonly createdBy: string;
}

export class MigrationNotConfirmedError extends Error {
  constructor(migrationId: string) {
    super(
      `migration ${migrationId} has unconfirmed changes — confirm them before discovery or launch`,
    );
    this.name = 'MigrationNotConfirmedError';
  }
}

/** §M.5.3 — what the model is allowed to return. Anything else is a failed pass. */
const ExtractedChanges = z.object({
  changes: z
    .array(
      z.object({
        kind: z.enum(['rename', 'signature', 'removal', 'behavior']),
        old_symbol: z.string().nullable().optional(),
        new_symbol: z.string().nullable().optional(),
        description: z.string().min(1),
        evidence: z.string().min(1),
      }),
    )
    .max(50),
});

const EXTRACT_SYSTEM = [
  'You extract breaking API changes from a changelog for an automated migration.',
  'Return JSON only: {"changes":[{"kind","old_symbol","new_symbol","description","evidence"}]}.',
  'kind is one of: rename, signature, removal, behavior.',
  'evidence MUST be a verbatim line copied from the input. Do not paraphrase it.',
  'If you cannot quote the input for a change, omit that change entirely.',
].join('\n');

export class MigrationService {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;
  readonly #model: ModelPort | null;
  readonly #headless: HeadlessRuns | null;
  readonly #retrieval: RetrievalService | null;
  readonly #launcher: LaunchTask | null;
  readonly #maxHop: number | undefined;

  constructor(db: Db, options: MigrationServiceOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#model = options.model ?? null;
    this.#headless = options.headless ?? null;
    this.#retrieval = options.retrieval ?? null;
    this.#launcher = options.launcher ?? null;
    this.#maxHop = options.maxHop;
  }

  // ── stage 1: changes from the changelog (§M.5.3) ────────────────────────────

  create(input: CreateMigrationInput): string {
    const id = `mig_${randomUUID().slice(0, 8)}`;
    this.#db
      .prepare(
        `INSERT INTO migration (id, provider, package, from_version, to_version, changelog_text,
                                sdk_diff_ref, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        input.package,
        input.fromVersion ?? null,
        input.toVersion,
        input.changelogText,
        input.sdkDiffRef ?? null,
        input.createdBy,
        this.#now(),
      );
    return id;
  }

  /**
   * Asks a headless agent for the changes, then throws most of its answer away.
   *
   * **The model may only cite lines that are in its input.** A row whose `evidence` is not
   * present verbatim in the changelog is dropped before it reaches the database — the same rule
   * as the conventions miner (§13.1), and for the same reason: a migration driven by an
   * invented changelog line is worse than one a human typed by hand, because it looks sourced.
   *
   * Returns what survived, so the caller can tell "the model found nothing" from "the model
   * hallucinated and we dropped it all".
   */
  async extractChanges(migrationId: string): Promise<{ kept: number; dropped: number }> {
    const migration = this.#migration(migrationId);
    const model = this.#modelFor(migrationId);
    if (!model) {
      throw new Error('no headless agent is available to read the changelog — add changes by hand');
    }

    const changelog = clip(migration.changelog_text, 24_000);
    const result = await callPass(
      model,
      {
        pass: 'extract',
        system: EXTRACT_SYSTEM,
        user: [
          `Package: ${migration.package}`,
          `Upgrading ${migration.from_version ?? '(unknown)'} → ${migration.to_version}`,
          '',
          'CHANGELOG:',
          changelog,
        ].join('\n'),
        maxOutputTokens: 2_000,
      },
      ExtractedChanges,
    );

    let kept = 0;
    let dropped = 0;
    const insert = this.#db.prepare(
      `INSERT INTO migration_change (id, migration_id, kind, old_symbol, new_symbol, description,
                                     source, evidence)
       VALUES (?, ?, ?, ?, ?, ?, 'changelog', ?)`,
    );
    this.#db.transaction(() => {
      for (const change of result.changes) {
        if (!cites(changelog, change.evidence)) {
          dropped += 1;
          continue;
        }
        insert.run(
          `mc_${randomUUID().slice(0, 8)}`,
          migrationId,
          change.kind,
          change.old_symbol ?? null,
          change.new_symbol ?? null,
          change.description,
          change.evidence.trim(),
        );
        kept += 1;
      }
    })();

    if (dropped > 0) {
      this.#onWarning(
        `${migrationId}: dropped ${dropped} extracted change(s) that did not quote the changelog`,
      );
    }
    return { kept, dropped };
  }

  /** §M.5.3 — hand entry, for a change the model missed or a demo. A human is the evidence. */
  addChange(
    migrationId: string,
    change: Omit<MigrationChange, 'id' | 'migration_id' | 'source' | 'evidence'> & {
      evidence?: string;
    },
  ): string {
    const id = `mc_${randomUUID().slice(0, 8)}`;
    this.#db
      .prepare(
        `INSERT INTO migration_change (id, migration_id, kind, old_symbol, new_symbol, description,
                                       source, evidence)
         VALUES (?, ?, ?, ?, ?, ?, 'user', ?)`,
      )
      .run(
        id,
        migrationId,
        change.kind,
        change.old_symbol ?? null,
        change.new_symbol ?? null,
        change.description,
        change.evidence?.trim() ?? 'entered by hand',
      );
    return id;
  }

  /**
   * §M.5.3 — the gate between inference and action.
   *
   * Recorded as who and when, not as a boolean, because §M.8.4's audit export has to be able to
   * say which human let this migration run.
   */
  confirmChanges(migrationId: string, by: string): void {
    const changes = this.changes(migrationId);
    if (changes.length === 0) {
      throw new Error(`migration ${migrationId} has no changes to confirm`);
    }
    this.#db
      .prepare('UPDATE migration SET changes_confirmed_at = ?, changes_confirmed_by = ? WHERE id = ?')
      .run(this.#now(), by, migrationId);
  }

  changes(migrationId: string): MigrationChange[] {
    return this.#db
      .prepare(
        `SELECT id, migration_id, kind, old_symbol, new_symbol, description, source, evidence
           FROM migration_change WHERE migration_id = ? ORDER BY rowid`,
      )
      .all(migrationId) as MigrationChange[];
  }

  // ── targets and the A/B assignment (§M.5.7) ─────────────────────────────────

  /**
   * Assigns repos to strata and alternates arms within each stratum.
   *
   * Stratifying before alternating is what makes the comparison mean anything at n=4: with
   * plain alternation, one arm can end up holding every large repo and the result measures
   * repo size rather than the digest. The arm is fixed here and never recomputed (§M.5.7).
   *
   * Waves are assigned here too: wave 0 takes one repo per stratum, up to three, so the canary
   * set spans the range rather than being three copies of the same shape.
   */
  async setTargets(migrationId: string, repoIds: readonly string[]): Promise<void> {
    this.#requireConfirmed(migrationId);
    const scored: { repoId: string; stratum: string }[] = [];
    for (const repoId of repoIds) {
      scored.push({ repoId, stratum: await this.#stratum(migrationId, repoId) });
    }

    const byStratum = new Map<string, string[]>();
    for (const { repoId, stratum } of scored) {
      const list = byStratum.get(stratum) ?? [];
      list.push(repoId);
      byStratum.set(stratum, list);
    }

    const canaries = new Set<string>();
    for (const [, repos] of [...byStratum].sort(([a], [b]) => a.localeCompare(b))) {
      if (canaries.size >= CANARY_SIZE) break;
      if (repos[0]) canaries.add(repos[0]);
    }

    const insert = this.#db.prepare(
      `INSERT INTO migration_target (migration_id, repo_id, wave, arm, stratum)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(migration_id, repo_id) DO UPDATE SET
         wave = excluded.wave, arm = excluded.arm, stratum = excluded.stratum`,
    );
    this.#db.transaction(() => {
      for (const [stratum, repos] of byStratum) {
        repos.forEach((repoId, index) => {
          const arm: MigrationArm = index % 2 === 0 ? 'digest_on' : 'digest_off';
          insert.run(migrationId, repoId, canaries.has(repoId) ? 0 : 1, arm, stratum);
        });
      }
    })();
  }

  // ── stage 2: chunk, enrich, index (§M.5.4) ──────────────────────────────────

  /**
   * Parses every target at its pinned base SHA and writes `code_chunk` rows.
   *
   * Reads through `git show` rather than the filesystem, so the scan is of the *pinned commit*
   * and is unaffected by whatever the working tree happens to contain — a lane may already be
   * editing it. That also means no worktree is needed, as §M.5.4 requires.
   */
  async chunkTargets(migrationId: string): Promise<{ chunks: number; unparsed: string[] }> {
    this.#requireConfirmed(migrationId);
    const migration = this.#migration(migrationId);
    let total = 0;
    const unparsed: string[] = [];

    for (const target of this.targets(migrationId)) {
      const repo = this.#repo(target.repo_id);
      const baseSha = await head(repo.path);
      const files = await readTree(repo.path, baseSha);
      const result = await chunkRepo(files, {
        packageName: migration.package,
        ...(this.#maxHop != null ? { maxHop: this.#maxHop } : {}),
      });
      unparsed.push(...result.unparsed.map((file) => `${repo.path}:${file}`));

      const insert = this.#db.prepare(
        `INSERT INTO code_chunk (id, migration_id, repo_id, file, start_line, end_line, symbol,
                                 kind, hop, enriched_text, base_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.#db.transaction(() => {
        // Re-chunking replaces: the index is derived, and a stale chunk from a previous base
        // SHA would be a citation to code that is no longer there (§M.2.2's provenance rule
        // would drop it later, but leaving it is work for nothing).
        this.#db
          .prepare('DELETE FROM code_chunk WHERE migration_id = ? AND repo_id = ?')
          .run(migrationId, target.repo_id);
        for (const chunk of result.chunks) {
          insert.run(
            `cc_${randomUUID().slice(0, 8)}`,
            migrationId,
            target.repo_id,
            chunk.file,
            chunk.startLine,
            chunk.endLine,
            chunk.symbol,
            chunk.kind,
            chunk.hop,
            chunk.enrichedText,
            baseSha,
          );
          total += 1;
        }
      })();

      this.#db
        .prepare(
          'UPDATE migration_target SET unparsed_files = ? WHERE migration_id = ? AND repo_id = ?',
        )
        .run(result.unparsed.length, migrationId, target.repo_id);
    }

    return { chunks: total, unparsed };
  }

  // ── stage 3: discovery (§M.5.5) ─────────────────────────────────────────────

  /**
   * Runs retrieval and grep for every change × target, and records both.
   *
   * Grep is not a fallback here — it runs every time, and its findings are merged rather than
   * overridden. The point of §M.5.5's `found_by` is to be able to say *afterwards* which sites
   * only retrieval saw and which ones only grep saw; a design that used grep only when
   * retrieval was unavailable could never produce that comparison, and the comparison is the
   * evidence for the whole feature.
   */
  async discover(migrationId: string): Promise<{ sites: number; queryMs: number }> {
    this.#requireConfirmed(migrationId);
    const changes = this.changes(migrationId);
    const targets = this.targets(migrationId);
    let queryMs = 0;
    let sites = 0;

    for (const target of targets) {
      const repoStarted = performance.now();
      const repo = this.#repo(target.repo_id);
      const baseSha = await head(repo.path);
      const parsed = this.#parsedCalls(migrationId, target.repo_id);

      for (const change of changes) {
        const found = new Map<string, Candidate>();

        // 1. retrieval over the enriched chunks.
        const started = performance.now();
        const hits = this.#retrieval
          ? await this.#retrieval.query('code', `${change.description} ${change.old_symbol ?? ''}`, {
              topK: 50,
              alpha: 0.5,
              filter: [
                { field: 'migration_id', condition: { $eq: migrationId } },
                { field: 'repo_id', condition: { $eq: target.repo_id } },
              ],
            })
          : [];
        queryMs += performance.now() - started;

        for (const hit of hits) {
          const file = hit.meta.file;
          const line = Number.parseInt(hit.meta.line ?? '', 10);
          if (!file || !Number.isFinite(line)) continue;
          // Only chunks that the closure actually tied to this change's symbol become
          // candidates. Retrieval ranks; it does not get to invent a call site.
          const call = parsed.find(
            (c) => c.file === file && c.line === line && matchesSymbol(c.symbol, change.old_symbol),
          );
          if (!call) continue;
          add(found, file, line, { via: call.via, score: hit.score, source: 'moss' });
        }

        // 2. the grep baseline, at the pinned SHA.
        if (change.old_symbol) {
          for (const match of await grep(repo.path, baseSha, change.old_symbol)) {
            if (!isScannable(match.file)) continue;
            add(found, match.file, match.line, { via: 'direct', score: null, source: 'grep' });
          }
        }

        sites += this.#writeSites(migrationId, change.id, target.repo_id, found);
      }

      this.#db
        .prepare(
          'UPDATE migration_target SET discovery_ms = ? WHERE migration_id = ? AND repo_id = ?',
        )
        .run(Math.round((performance.now() - repoStarted) * 100) / 100, migrationId, target.repo_id);
    }

    return { sites, queryMs: Math.round(queryMs * 100) / 100 };
  }

  // ── stage 4: launch a wave (§M.5.6) ─────────────────────────────────────────

  /**
   * Launches every target in a wave through the ordinary `LaunchTask` path.
   *
   * Three constraints, none of them new machinery:
   *   - **Wave 1+ needs a green canary** — evidence, not a timer (§M.5.6). Later waves start
   *     with verified sibling fixes available, which is the whole reason for waves.
   *   - **15 live lanes per daemon** (ARCH §4.6). Targets beyond the cap stay unlaunched and
   *     are reported, rather than being queued somewhere invisible.
   *   - **One chat for the migration**, so every lane shares a transcript and the sibling
   *     digests in §M.2.2 have something to retrieve.
   */
  async launchWave(migrationId: string, wave: number): Promise<{ launched: string[]; deferred: string[] }> {
    this.#requireConfirmed(migrationId);

    // The gate is checked before the launcher, not after. When both are true, "wave 1 is
    // gated" is the fact the user can act on; "this daemon cannot launch tasks" would send
    // them looking at the wrong thing.
    if (wave > 0 && !this.canaryGreen(migrationId)) {
      throw new Error(
        `wave ${wave} is gated: no wave-0 canary has a passing verify run at its head yet`,
      );
    }

    const launcher = this.#launcher;
    if (!launcher) throw new Error('this daemon cannot launch tasks');

    const migration = this.#migration(migrationId);
    const chatId = `migration:${migrationId}`;
    const launched: string[] = [];
    const deferred: string[] = [];
    let live = this.#liveLanes();

    for (const target of this.targets(migrationId).filter((t) => t.wave === wave && !t.task_id)) {
      if (live >= MAX_LIVE_LANES) {
        deferred.push(target.repo_id);
        continue;
      }
      const repo = this.#repo(target.repo_id);
      const created = await launcher.createTask({
        repoPath: repo.path,
        title: `Migrate ${migration.package} to ${migration.to_version}`,
        intent: this.#intentFor(migrationId, migration.package, migration.to_version, target.repo_id),
        chatId,
        isolate: true,
        originKind: 'api_migration',
      });
      this.#db
        .prepare('UPDATE migration_target SET task_id = ? WHERE migration_id = ? AND repo_id = ?')
        .run(created.taskId, migrationId, target.repo_id);
      launched.push(created.taskId);
      live += 1;
    }

    return { launched, deferred };
  }

  /** §M.5.6 — at least one wave-0 lane with a passing required run at its current head. */
  canaryGreen(migrationId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 FROM migration_target mt
           JOIN task t ON t.id = mt.task_id
           JOIN verify_run v ON v.task_id = t.id
          WHERE mt.migration_id = ? AND mt.wave = 0
            AND v.required = 1 AND v.exit_code = 0 AND v.finished_at IS NOT NULL
          LIMIT 1`,
      )
      .get(migrationId);
    return row != null;
  }

  // ── the view (§M.5.5) ───────────────────────────────────────────────────────

  view(migrationId: string): MigrationView | null {
    const migration = this.#db
      .prepare('SELECT * FROM migration WHERE id = ?')
      .get(migrationId) as MigrationRow | undefined;
    if (!migration) return null;

    const targets = this.targets(migrationId);
    const discovery: DiscoveryComparison[] = targets.map((target) => {
      const repo = this.#repo(target.repo_id);
      const counts = this.#db
        .prepare(
          `SELECT found_by, COUNT(*) AS n FROM call_site
            WHERE migration_id = ? AND repo_id = ? GROUP BY found_by`,
        )
        .all(migrationId, target.repo_id) as { found_by: string; n: number }[];
      const by = new Map(counts.map((c) => [c.found_by, c.n]));
      const chunks = (
        this.#db
          .prepare('SELECT COUNT(*) AS n FROM code_chunk WHERE migration_id = ? AND repo_id = ?')
          .get(migrationId, target.repo_id) as { n: number }
      ).n;
      return {
        repo_id: target.repo_id,
        repo_slug: slug(repo.path),
        both: by.get('both') ?? 0,
        moss_only: by.get('moss') ?? 0,
        grep_only: by.get('grep') ?? 0,
        unparsed: target.unparsed_files,
        chunks,
        query_ms: target.discovery_ms,
      };
    });

    const nextWave = targets.some((t) => t.wave === 0 && t.task_id == null)
      ? 0
      : targets.some((t) => t.wave === 1 && t.task_id == null)
        ? 1
        : null;

    return {
      id: migration.id,
      provider: migration.provider,
      package: migration.package,
      from_version: migration.from_version,
      to_version: migration.to_version,
      created_by: migration.created_by,
      created_at: migration.created_at,
      changes_confirmed_at: migration.changes_confirmed_at,
      changes_confirmed_by: migration.changes_confirmed_by,
      changes: this.changes(migrationId),
      targets: targets.map((target) => ({
        repo_id: target.repo_id,
        repo_slug: slug(this.#repo(target.repo_id).path),
        wave: target.wave,
        arm: target.arm as MigrationArm,
        stratum: target.stratum,
        task_id: target.task_id,
        sites: (
          this.#db
            .prepare('SELECT COUNT(*) AS n FROM call_site WHERE migration_id = ? AND repo_id = ?')
            .get(migrationId, target.repo_id) as { n: number }
        ).n,
      })),
      discovery,
      canaryGreen: this.canaryGreen(migrationId),
      nextWave,
      liveLanes: this.#liveLanes(),
      maxLiveLanes: MAX_LIVE_LANES,
    };
  }


  // ── §M.5.7 the A/B readout, and §M.5.8 the misses ──────────────────────────

  /**
   * Every metric derived by query, none stored as a conclusion.
   *
   * That rule is the PRD's and it is doing real work: a stored "digest_on wins" would outlive
   * the rows that justified it, and the one thing this experiment must not do is present a
   * conclusion the data no longer supports. `n` travels with every arm for the same reason.
   */
  metrics(migrationId: string): MigrationMetrics {
    const arms: MigrationArm[] = ['digest_on', 'digest_off'];
    const packs = this.#db
      .prepare(
        `SELECT cp.retrieval_ms FROM context_pack cp
           JOIN migration_target mt ON mt.task_id = cp.task_id
          WHERE mt.migration_id = ?`,
      )
      .all(migrationId) as { retrieval_ms: number }[];
    const latencies = packs.map((row) => row.retrieval_ms).sort((a, b) => a - b);

    return {
      migration_id: migrationId,
      arms: arms.map((arm) => this.#armMetrics(migrationId, arm)),
      retrievalP50Ms: percentile(latencies, 0.5),
      retrievalP95Ms: percentile(latencies, 0.95),
    };
  }

  #armMetrics(migrationId: string, arm: MigrationArm): ArmMetrics {
    const lanes = this.#db
      .prepare(
        'SELECT task_id FROM migration_target WHERE migration_id = ? AND arm = ? AND task_id IS NOT NULL',
      )
      .all(migrationId, arm) as { task_id: string }[];

    let firstAttemptPass = 0;
    let humanEditsAtGate = 0;
    let contextTokens = 0;
    const turnCounts: number[] = [];

    for (const lane of lanes) {
      // "First attempt" is the first *required* run this lane finished. An optional lint step
      // passing first says nothing about whether the migration worked.
      const first = this.#db
        .prepare(
          `SELECT exit_code FROM verify_run
            WHERE task_id = ? AND required = 1 AND finished_at IS NOT NULL
            ORDER BY started_at ASC LIMIT 1`,
        )
        .get(lane.task_id) as { exit_code: number | null } | undefined;
      if (first?.exit_code === 0) firstAttemptPass += 1;

      const green = this.#db
        .prepare(
          `SELECT finished_at FROM verify_run
            WHERE task_id = ? AND required = 1 AND exit_code = 0 AND finished_at IS NOT NULL
            ORDER BY finished_at ASC LIMIT 1`,
        )
        .get(lane.task_id) as { finished_at: number } | undefined;
      if (green) {
        const turns = this.#db
          .prepare(
            "SELECT COUNT(*) AS n FROM chat_turn WHERE task_id = ? AND role = 'user' AND created_at <= ?",
          )
          .get(lane.task_id, green.finished_at) as { n: number };
        turnCounts.push(turns.n);
      }

      // §M.5.7 — a rejection and a human approval both mean a person had to engage with what
      // the agent produced, which is the cost the digest is supposed to reduce.
      const edits = this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM gate_request
            WHERE task_id = ? AND (decision = 'deny' OR (decision = 'approve' AND decided_by LIKE 'human%'))`,
        )
        .get(lane.task_id) as { n: number };
      humanEditsAtGate += edits.n;

      const tokens = this.#db
        .prepare('SELECT COALESCE(SUM(tokens_used), 0) AS n FROM context_pack WHERE task_id = ?')
        .get(lane.task_id) as { n: number };
      contextTokens += tokens.n;
    }

    return {
      arm,
      n: lanes.length,
      firstAttemptPass,
      turnsToGreen:
        turnCounts.length === 0
          ? null
          : Math.round((turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length) * 100) / 100,
      humanEditsAtGate,
      contextTokens,
    };
  }

  /** §M.5.8 — what verification found that discovery did not. */
  misses(migrationId: string): DiscoveryMiss[] {
    return this.#db
      .prepare(
        `SELECT id, repo_id, file, line, pattern, verify_run_id, fixture_path
           FROM discovery_miss WHERE migration_id = ? ORDER BY repo_id, file, line`,
      )
      .all(migrationId) as DiscoveryMiss[];
  }

  /**
   * §M.5.8 — writes each miss as a regression fixture.
   *
   * The point is that recall improves from *real* failures rather than guessed test cases: a
   * fixture here is a site the parser and the retrieval query between them failed to propose,
   * captured with the diagnostic that revealed it.
   */
  async exportMisses(migrationId: string, dir: string): Promise<string[]> {
    const written: string[] = [];
    const rows = this.misses(migrationId);
    if (rows.length === 0) return written;

    await mkdir(dir, { recursive: true });
    for (const miss of rows) {
      const path = join(dir, `${miss.id}.md`);
      await writeFile(
        path,
        [
          `# Discovery miss ${miss.id}`,
          '',
          `- migration: ${migrationId}`,
          `- repo: ${miss.repo_id}`,
          `- site: ${miss.file}:${miss.line}`,
          `- found by: verification (${miss.verify_run_id})`,
          '',
          '## Diagnostic',
          '',
          miss.pattern,
          '',
          '## Why this is a fixture',
          '',
          'Discovery proposed no call site here, and verification found one. A chunker or',
          'query change that makes this site discoverable should keep it discoverable.',
          '',
        ].join('\n'),
        'utf8',
      );
      this.#db.prepare('UPDATE discovery_miss SET fixture_path = ? WHERE id = ?').run(path, miss.id);
      written.push(path);
    }
    return written;
  }

  targets(migrationId: string): TargetRow[] {
    return this.#db
      .prepare(
        `SELECT migration_id, repo_id, wave, arm, stratum, task_id, discovery_ms, unparsed_files
           FROM migration_target WHERE migration_id = ? ORDER BY wave, repo_id`,
      )
      .all(migrationId) as TargetRow[];
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * The closure's resolved calls, recovered from the chunk rows.
   *
   * Deliberately re-derived from `code_chunk` rather than held in memory between stages: the
   * stages are separate procedures a user can run minutes apart, and a daemon restart between
   * them must not change what discovery finds.
   */
  #parsedCalls(migrationId: string, repoId: string): ParsedCall[] {
    const rows = this.#db
      .prepare(
        `SELECT file, start_line AS line, symbol, kind, hop FROM code_chunk
          WHERE migration_id = ? AND repo_id = ? AND kind IN ('call', 'import')`,
      )
      .all(migrationId, repoId) as { file: string; line: number; symbol: string | null; kind: string; hop: number }[];
    return rows.map((row) => ({
      file: row.file,
      line: row.line,
      symbol: row.symbol ?? '',
      via: row.hop > 0 ? 'wrapper' : row.kind === 'import' ? 'direct' : 'alias',
    }));
  }

  #writeSites(
    migrationId: string,
    changeId: string,
    repoId: string,
    found: Map<string, Candidate>,
  ): number {
    const insert = this.#db.prepare(
      `INSERT INTO call_site (id, migration_id, change_id, repo_id, chunk_id, file, line, via,
                              score, found_by)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(migration_id, change_id, repo_id, file, line) DO UPDATE SET
         found_by = excluded.found_by,
         score = COALESCE(excluded.score, call_site.score),
         via = excluded.via`,
    );
    let n = 0;
    this.#db.transaction(() => {
      for (const candidate of found.values()) {
        insert.run(
          `cs_${randomUUID().slice(0, 8)}`,
          migrationId,
          changeId,
          repoId,
          candidate.file,
          candidate.line,
          candidate.via,
          candidate.score,
          candidate.foundBy,
        );
        n += 1;
      }
    })();
    return n;
  }

  /** §M.5.7 — call-site count × LOC, the two axes that actually move difficulty. */
  async #stratum(migrationId: string, repoId: string): Promise<string> {
    const sites = (
      this.#db
        .prepare('SELECT COUNT(*) AS n FROM call_site WHERE migration_id = ? AND repo_id = ?')
        .get(migrationId, repoId) as { n: number }
    ).n;
    const loc = await countLoc(this.#repo(repoId).path);
    const sitesBand = sites <= 5 ? 'sites:1-5' : sites <= 20 ? 'sites:6-20' : 'sites:21+';
    const locBand = loc < 10_000 ? 'loc:<10k' : loc < 50_000 ? 'loc:10k-50k' : 'loc:50k+';
    return `${sitesBand}|${locBand}`;
  }

  /** §M.5.6 — the candidate list the agent must confirm or reject, not act on blindly. */
  #intentFor(migrationId: string, pkg: string, toVersion: string, repoId: string): string {
    const changes = this.changes(migrationId);
    const sites = this.#db
      .prepare(
        `SELECT file, line, via FROM call_site
          WHERE migration_id = ? AND repo_id = ? ORDER BY file, line LIMIT 60`,
      )
      .all(migrationId, repoId) as { file: string; line: number; via: string }[];

    return [
      `Migrate this repository to ${pkg} ${toVersion}.`,
      '',
      'Changes to apply:',
      ...changes.map((c) =>
        `- ${c.kind}: ${c.description}${c.old_symbol ? ` (${c.old_symbol} → ${c.new_symbol ?? 'removed'})` : ''}`,
      ),
      '',
      'Candidate call sites. These were found by search and MAY BE WRONG.',
      'Confirm or reject each one; do not assume the list is complete or correct:',
      ...sites.map((s) => `- ${s.file}:${s.line} (via ${s.via})`),
    ].join('\n');
  }

  /**
   * The model for this migration's extraction pass.
   *
   * `HeadlessModel` takes a repo id only to pick that repo's preferred agent — the run itself
   * happens in an empty temp directory and never touches a checkout. So any repo associated
   * with the migration is a fine choice, and none at all still works.
   */
  #modelFor(migrationId: string): ModelPort | null {
    if (this.#model) return this.#model;
    if (!this.#headless) return null;
    const repoId =
      this.targets(migrationId)[0]?.repo_id ??
      (this.#db.prepare('SELECT id FROM repo LIMIT 1').get() as { id: string } | undefined)?.id ??
      '';
    return new HeadlessModel(this.#headless, repoId);
  }

  #liveLanes(): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_fact
          WHERE pane_alive = 1 AND terminated = 0`,
      )
      .get() as { n: number };
    return row.n;
  }

  #requireConfirmed(migrationId: string): void {
    const row = this.#db
      .prepare('SELECT changes_confirmed_at FROM migration WHERE id = ?')
      .get(migrationId) as { changes_confirmed_at: number | null } | undefined;
    if (!row) throw new Error(`unknown migration ${migrationId}`);
    if (row.changes_confirmed_at == null) throw new MigrationNotConfirmedError(migrationId);
  }

  #migration(id: string): MigrationRow {
    const row = this.#db.prepare('SELECT * FROM migration WHERE id = ?').get(id) as
      | MigrationRow
      | undefined;
    if (!row) throw new Error(`unknown migration ${id}`);
    return row;
  }

  #repo(repoId: string): { path: string } {
    const row = this.#db.prepare('SELECT path FROM repo WHERE id = ?').get(repoId) as
      | { path: string }
      | undefined;
    if (!row) throw new Error(`unknown repo ${repoId}`);
    return row;
  }
}

// ── row shapes ────────────────────────────────────────────────────────────────

interface MigrationRow {
  id: string;
  provider: string;
  package: string;
  from_version: string | null;
  to_version: string;
  changelog_text: string;
  sdk_diff_ref: string | null;
  created_by: string;
  created_at: number;
  changes_confirmed_at: number | null;
  changes_confirmed_by: string | null;
}

export interface TargetRow {
  migration_id: string;
  repo_id: string;
  wave: number;
  arm: string;
  stratum: string;
  task_id: string | null;
  discovery_ms: number;
  unparsed_files: number;
}

interface ParsedCall {
  file: string;
  line: number;
  symbol: string;
  via: 'direct' | 'alias' | 'wrapper';
}

interface Candidate {
  file: string;
  line: number;
  via: 'direct' | 'alias' | 'wrapper';
  score: number | null;
  foundBy: 'moss' | 'grep' | 'both';
}

// ── helpers ───────────────────────────────────────────────────────────────────

function add(
  found: Map<string, Candidate>,
  file: string,
  line: number,
  input: { via: 'direct' | 'alias' | 'wrapper'; score: number | null; source: 'moss' | 'grep' },
): void {
  const key = `${file}\u0000${line}`;
  const existing = found.get(key);
  if (!existing) {
    found.set(key, { file, line, via: input.via, score: input.score, foundBy: input.source });
    return;
  }
  // Seen by the other side too. `both` is the interesting bucket precisely because it is the
  // one that needs no argument.
  if (existing.foundBy !== input.source) existing.foundBy = 'both';
  if (existing.score == null) existing.score = input.score;
  // A wrapper hit is a stronger statement than grep's "the text appears here".
  if (input.via !== 'direct') existing.via = input.via;
}

/**
 * §M.5.3 — is this evidence actually in the input?
 *
 * Whitespace-insensitive, because a model reflowing a long line is not the failure mode worth
 * catching. Inventing a line that was never there is, and that is what this rejects.
 */
export function cites(haystack: string, evidence: string): boolean {
  const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = normalise(evidence);
  if (needle.length < 8) return false;
  return normalise(haystack).includes(needle);
}

function matchesSymbol(candidate: string, oldSymbol: string | null): boolean {
  if (!oldSymbol) return true;
  // `Index.delete` in a changelog is `delete` on the chunk side; compare the last segment too.
  const tail = oldSymbol.split(/[.#]/).pop() ?? oldSymbol;
  return candidate === oldSymbol || candidate === tail;
}

async function head(repoPath: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
}

/** Every scannable file at a commit, read from the object store rather than the working tree. */
async function readTree(repoPath: string, sha: string): Promise<SourceFile[]> {
  const listed = await git(repoPath, ['ls-tree', '-r', '--name-only', sha]);
  const paths = listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isScannable(line));

  const files: SourceFile[] = [];
  for (const path of paths) {
    try {
      files.push({ path, text: await git(repoPath, ['show', `${sha}:${path}`]) });
    } catch {
      // A path git cannot show (a submodule, a broken symlink) is not this feature's problem.
      continue;
    }
  }
  return files;
}

export interface GrepMatch {
  file: string;
  line: number;
}

/** §M.5.5 step 2 — the baseline, at the pinned SHA. An empty result is not an error. */
export async function grep(repoPath: string, sha: string, symbol: string): Promise<GrepMatch[]> {
  let out: string;
  try {
    out = await git(repoPath, ['grep', '-n', '--fixed-strings', symbol, sha]);
  } catch {
    // `git grep` exits 1 when nothing matches. That is the common case, not a failure.
    return [];
  }
  const matches: GrepMatch[] = [];
  for (const line of out.split('\n')) {
    // `<sha>:<path>:<line>:<text>`
    const withoutSha = line.startsWith(`${sha}:`) ? line.slice(sha.length + 1) : line;
    const first = withoutSha.indexOf(':');
    if (first === -1) continue;
    const second = withoutSha.indexOf(':', first + 1);
    if (second === -1) continue;
    const file = withoutSha.slice(0, first);
    const at = Number.parseInt(withoutSha.slice(first + 1, second), 10);
    if (!Number.isFinite(at)) continue;
    matches.push({ file, line: at });
  }
  return matches;
}

async function countLoc(repoPath: string): Promise<number> {
  try {
    const listed = await git(repoPath, ['ls-files']);
    // Files, not lines: counting lines means reading the tree twice, and the strata bands are
    // coarse enough that file count orders repos the same way.
    return listed.split('\n').filter((line) => isScannable(line.trim())).length * 100;
  } catch {
    return 0;
  }
}

function slug(repoPath: string): string {
  const parts = repoPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}
