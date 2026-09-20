import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';
import type { ScmClient } from '../scm/client.js';
import { fetchCorpus, fetchReviewRounds } from '../scm/corpus.js';

import { Conventions, type ConventionWithEvidence } from './conventions.js';
import { compareInjection, type Comparison } from './measure.js';
import { Miner, type MineResult, type MinePhase } from './miner.js';
import type { ModelPort } from './model.js';
import { HeadlessModel } from './headless-model.js';
import type { HeadlessRuns } from '../domain/headless-run.js';

/**
 * The mining service — OSADE.md §13.
 *
 * Everything the API and the UI need in one place: whether mining is even possible, running it,
 * and the human half of §13.4 — confirming or rejecting a candidate with its evidence in front
 * of you.
 *
 * Mining is **always explicit**. It costs GitHub quota and model tokens, it takes minutes, and
 * §13.4 says re-mine "weekly, or on demand". Nothing here starts on its own, and launching a
 * task never waits on it.
 */

export interface MineRunRow {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  highWaterPr: number | null;
  observations: number;
  candidates: number;
  error: string | null;
  phase: MinePhase | null;
  progressDone: number;
  progressTotal: number;
}

/** §13.4 — "re-mine weekly, or on demand". */
export const REMINE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MiningAvailability {
  available: boolean;
  /** Why not, in words a user can act on. */
  reason: string | null;
}

export interface KnowledgeOptions {
  now?: () => number;
  onWarning?: (message: string) => void;
}

export class Knowledge {
  readonly #db: Db;
  readonly #scm: ScmClient | null;
  readonly #model: ModelPort | null;
  readonly #headless: HeadlessRuns | null;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;
  readonly #conventions: Conventions;
  /** Repos with a run in flight. Mining twice at once would double-count evidence. */
  readonly #running = new Set<string>();

  constructor(
    db: Db,
    scm: ScmClient | null,
    model: ModelPort | null,
    options: KnowledgeOptions & { headless?: HeadlessRuns | null } = {},
  ) {
    this.#db = db;
    this.#scm = scm;
    this.#model = model;
    this.#headless = options.headless ?? null;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#conventions = new Conventions(db, { now: this.#now });
    this.#reapInterruptedRuns();
  }

  /**
   * A run whose daemon died is finished, whatever its row says.
   *
   * `#running` is in-memory, so after a restart an unfinished row would look like a run in
   * progress forever: the button would stay disabled and nothing would ever re-enable it. Marked
   * `interrupted` rather than deleted — the partial work is real (conventions written before the
   * crash are still cited and still valid), and only the high-water mark is withheld, which
   * `highWaterPr` already does by ignoring runs with an error.
   */
  #reapInterruptedRuns(): void {
    const orphans = this.#db
      .prepare(
        `UPDATE mine_run
            SET finished_at = ?, phase = 'interrupted',
                error = COALESCE(error, 'the daemon stopped while this run was in progress')
          WHERE finished_at IS NULL`,
      )
      .run(this.#now());

    if (orphans.changes > 0) {
      this.#onWarning(
        `${orphans.changes} mining run(s) did not finish before the daemon stopped; ` +
          `re-run to cover the pull requests they missed`,
      );
    }
  }

  get conventions(): Conventions {
    return this.#conventions;
  }

  /**
   * Whether this repo can be mined right now, and if not, why.
   *
   * Reported rather than discovered halfway through: a button that fails after two minutes of
   * work is worse than one that is disabled with a reason next to it.
   */
  availability(repoId: string): MiningAvailability {
    if (!this.#model && !this.#headless?.available(repoId)) {
      return {
        available: false,
        reason:
          'no installed agent can run headless. Install Claude Code or Codex; Osade does not take an API key for mining.',
      };
    }
    if (!this.#scm) {
      return { available: false, reason: 'no GitHub token configured (OSADE_GITHUB_TOKEN).' };
    }

    const repo = this.#repo(repoId);
    if (!repo) return { available: false, reason: 'unknown repository.' };
    if (!repo.gh_owner || !repo.gh_name) {
      return {
        available: false,
        reason:
          'this repository has no GitHub remote, so there is no review record to mine. ' +
          'Conventions can still be added by hand.',
      };
    }
    if (this.#running.has(repoId)) {
      return { available: false, reason: 'a mining run is already in progress.' };
    }
    return { available: true, reason: null };
  }

  isRunning(repoId: string): boolean {
    return this.#running.has(repoId);
  }

  lastRun(repoId: string): MineRunRow | null {
    const row = this.#db
      .prepare('SELECT * FROM mine_run WHERE repo_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(repoId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      startedAt: row.started_at as number,
      finishedAt: (row.finished_at as number | null) ?? null,
      highWaterPr: (row.high_water_pr as number | null) ?? null,
      observations: row.observations as number,
      candidates: row.candidates as number,
      error: (row.error as string | null) ?? null,
      phase: (row.phase as MinePhase | null) ?? null,
      progressDone: (row.progress_done as number | null) ?? 0,
      progressTotal: (row.progress_total as number | null) ?? 0,
    };
  }

  /**
   * §13.4 — "re-mine weekly". Reported, never acted on.
   *
   * A timer that mined every Monday would spend the user's GitHub quota and model tokens while
   * they were not looking, which contradicts the rule that mining is always explicit. So this
   * says a repo is *due* and lets the UI offer it. Never mined at all does not count as due:
   * a repo nobody has chosen to mine is not overdue for a second helping.
   */
  dueForRemine(repoId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT MAX(finished_at) AS last FROM mine_run
          WHERE repo_id = ? AND finished_at IS NOT NULL AND error IS NULL`,
      )
      .get(repoId) as { last: number | null };

    if (row.last === null) return false;
    return this.#now() - row.last >= REMINE_INTERVAL_MS;
  }

  /**
   * Starts a run and returns at once.
   *
   * Mining a 300-pull-request repository is minutes of work, which makes it the wrong shape for
   * a request-response call: a single long mutation holds an HTTP request open with nothing to
   * show, and a client that gives up mid-flight learns nothing about a run that is still
   * spending money. So the run goes to the background and its progress lands in `mine_run`,
   * where `mineStatus` can poll it — and where a second window watching the same daemon sees the
   * same thing.
   *
   * Throws only for the reasons `availability` already knows: those are worth surfacing
   * immediately rather than as a failed background run a moment later.
   */
  startMine(repoId: string, options: { full?: boolean } = {}): { runId: string } {
    const availability = this.availability(repoId);
    if (!availability.available) throw new Error(availability.reason ?? 'mining unavailable');

    // Claimed synchronously, before the first await, so two calls in the same tick cannot both
    // pass the availability check above.
    this.#running.add(repoId);
    const runId = `mr_${randomUUID().slice(0, 8)}`;

    void this.#mineHoldingLock(repoId, runId, options).catch((error: Error) => {
      // #mineHoldingLock records failures in `mine_run` itself; this is the last resort for a
      // throw on the way there. An unhandled rejection here would take the daemon down.
      this.#onWarning(`mining run ${runId} failed: ${error.message}`);
    });

    return { runId };
  }

  /**
   * Fetch, mine, store. Incremental by default (§13.4). Awaits the whole run.
   *
   * Decay runs first: a rule that has gone 180 days without confirmation should be a candidate
   * *before* this run gets its chance to re-confirm it, or a stale rule would be quietly renewed
   * by a run that never saw fresh evidence for it.
   */
  async mine(repoId: string, options: { full?: boolean } = {}): Promise<MineResult> {
    const availability = this.availability(repoId);
    if (!availability.available) throw new Error(availability.reason ?? 'mining unavailable');
    this.#running.add(repoId);
    return this.#mineHoldingLock(repoId, `mr_${randomUUID().slice(0, 8)}`, options);
  }

  /** The body of a run. The caller has already claimed `#running`; this always releases it. */
  async #mineHoldingLock(
    repoId: string,
    runId: string,
    options: { full?: boolean },
  ): Promise<MineResult> {
    // The row exists before any work does, so a poll one millisecond later sees a run rather
    // than nothing. Fetching the corpus is itself minutes of GitHub calls.
    this.#db
      .prepare(
        `INSERT INTO mine_run (id, repo_id, started_at, phase) VALUES (?, ?, ?, 'fetching')`,
      )
      .run(runId, repoId, this.#now());

    const fail = (message: string): MineResult => {
      this.#db
        .prepare('UPDATE mine_run SET finished_at = ?, error = ? WHERE id = ?')
        .run(this.#now(), message, runId);
      return {
        runId,
        observations: 0,
        candidates: 0,
        written: 0,
        rejected: 0,
        reconfirmed: 0,
        belowThreshold: 0,
        error: message,
      };
    };

    try {
      const repo = this.#repo(repoId);
      const scm = this.#scm;
      const model =
        this.#model ?? (this.#headless ? new HeadlessModel(this.#headless, repoId) : null);
      if (!repo?.gh_owner || !repo.gh_name || !scm || !model) {
        return fail('mining unavailable');
      }

      const decayed = this.#conventions.decay();
      if (decayed > 0) {
        this.#onWarning(`${decayed} convention(s) went 180 days unconfirmed and are candidates`);
      }

      const miner = new Miner(this.#db, model, {
        now: this.#now,
        onWarning: this.#onWarning,
        onProgress: (progress) => {
          this.#db
            .prepare(
              'UPDATE mine_run SET phase = ?, progress_done = ?, progress_total = ? WHERE id = ?',
            )
            .run(progress.phase, progress.done, progress.total, runId);
        },
      });

      const { corpus, partial } = await fetchCorpus(
        scm,
        { id: repoId, owner: repo.gh_owner, name: repo.gh_name },
        {
          sinceNumber: options.full ? null : miner.highWaterPr(repoId),
          onWarning: this.#onWarning,
        },
      );

      if (partial) {
        this.#onWarning(
          'the corpus is partial: GitHub rate limit budget ran low. Re-run later to cover the rest.',
        );
      }

      return await miner.mine(corpus, { runId });
    } catch (error) {
      // A background run has no caller to throw at, so the failure has to be durable.
      return fail((error as Error).message);
    } finally {
      this.#running.delete(repoId);
    }
  }

  /**
   * §13.6 — review rounds to merge, with and without injected conventions.
   *
   * Needs a token but not a model: measuring is not mining, and the answer matters most exactly
   * when someone is deciding whether mining was worth it.
   */
  async measure(repoId: string): Promise<Comparison> {
    const repo = this.#repo(repoId);
    const scm = this.#scm;
    if (!scm || !repo?.gh_owner || !repo.gh_name) {
      throw new Error('measuring review rounds needs a GitHub token and a GitHub remote');
    }
    const owner = repo.gh_owner;
    const name = repo.gh_name;

    return compareInjection(this.#db, repoId, (prNumber) =>
      fetchReviewRounds(scm, { owner, name }, prNumber),
    );
  }

  list(repoId: string): ConventionWithEvidence[] {
    // Candidates first: those are the ones asking for a decision (§13.4).
    const order = { candidate: 0, active: 1, retired: 2, rejected: 3 } as const;
    return this.#conventions
      .list(repoId)
      .sort((a, b) => order[a.lifecycle] - order[b.lifecycle] || b.confidence - a.confidence);
  }

  /** §13.4 — one-click human confirmation, with the evidence shown next to the toggle. */
  confirm(id: string): boolean {
    return this.#conventions.promote(id, 'human');
  }

  reject(id: string, reason: string): void {
    this.#conventions.reject(id, reason);
  }

  #repo(repoId: string): { gh_owner: string | null; gh_name: string | null } | null {
    return (
      (this.#db.prepare('SELECT gh_owner, gh_name FROM repo WHERE id = ?').get(repoId) as
        | { gh_owner: string | null; gh_name: string | null }
        | undefined) ?? null
    );
  }
}
