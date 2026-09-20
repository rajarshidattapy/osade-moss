import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';

import { Conventions, type Evidence } from './conventions.js';
import type { ModelPort } from './model.js';
import {
  clusterObservations,
  extractFromDoc,
  extractFromPullRequest,
  verifyCandidate,
} from './passes.js';
import {
  EVIDENCE_KIND_FOR,
  SOURCE_WEIGHT,
  type CandidateRule,
  type Corpus,
  type Observation,
  type PullRequestRecord,
  type Verdict,
} from './types.js';

/**
 * The conventions miner — OSADE.md §13.4.
 *
 * Extract → cluster → verify, three bounded model calls, with the code checking the work between
 * them. **The model proposes; this file decides.** Every threshold the spec states is enforced
 * here rather than asked for in a prompt, because a prompt that says "a rule needs three
 * observations" is a suggestion and a filter that counts them is a guarantee.
 *
 * What is enforced here:
 *   - §13.4 pass 2: ≥3 observations from ≥2 distinct PRs, **or** ≥1 from CI config / CODEOWNERS.
 *   - §13.1: every rule reaches the store with its evidence attached, or not at all.
 *   - §13.4 pass 3: the held-out sample is genuinely held out — never shown to extract.
 *   - A rule the sample contradicts is written as `rejected`, not dropped. Knowing a rule was
 *     considered and disproved is worth more than mining it again next week.
 */

/** §13.4 pass 2 thresholds. */
export const MIN_OBSERVATIONS = 3;
export const MIN_DISTINCT_PRS = 2;

/** Fraction of merged PRs withheld from extraction, for pass 3 to test candidates against. */
export const HELD_OUT_FRACTION = 0.25;

export interface MineResult {
  runId: string;
  observations: number;
  candidates: number;
  /** Rules written, by what happened to them. */
  written: number;
  rejected: number;
  reconfirmed: number;
  /** Candidates that failed the §13.4 thresholds. Not an error — most proposals are noise. */
  belowThreshold: number;
  error: string | null;
}

/**
 * Which pass a run is in, for the UI.
 *
 * `interrupted` is not a pass — it is what an unfinished run looks like after the daemon that
 * was running it went away, and it exists so that state is distinguishable from a run still
 * working. A row that says "extracting" forever is indistinguishable from progress.
 */
export type MinePhase = 'fetching' | 'extracting' | 'clustering' | 'verifying' | 'interrupted';

export interface MineProgress {
  phase: MinePhase;
  done: number;
  total: number;
}

export interface MinerOptions {
  now?: () => number;
  onWarning?: (message: string) => void;
  /** Called as the run advances. Writes to `mine_run` so a poll can see it. */
  onProgress?: (progress: MineProgress) => void;
}

export class Miner {
  readonly #db: Db;
  readonly #model: ModelPort;
  readonly #conventions: Conventions;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;
  readonly #onProgress: (progress: MineProgress) => void;

  constructor(db: Db, model: ModelPort, options: MinerOptions = {}) {
    this.#db = db;
    this.#model = model;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#onProgress = options.onProgress ?? (() => {});
    this.#conventions = new Conventions(db, { now: this.#now });
  }

  /**
   * The newest PR a completed run has already considered.
   *
   * §13.4 — re-mine incrementally. Only finished runs count: a run that crashed halfway has no
   * business advancing the high-water mark, or the PRs it never reached would be skipped
   * forever.
   */
  highWaterPr(repoId: string): number | null {
    const row = this.#db
      .prepare(
        `SELECT MAX(high_water_pr) AS hw FROM mine_run
          WHERE repo_id = ? AND finished_at IS NOT NULL AND error IS NULL`,
      )
      .get(repoId) as { hw: number | null };
    return row.hw ?? null;
  }

  /**
   * `runId` adopts a `mine_run` row the caller already created — the background path starts one
   * before fetching the corpus, so a poll sees a run rather than nothing during the minutes that
   * takes. Without one, this owns the row itself.
   */
  async mine(corpus: Corpus, options: { runId?: string } = {}): Promise<MineResult> {
    const runId = options.runId ?? `mr_${randomUUID().slice(0, 8)}`;
    if (!options.runId) {
      this.#db
        .prepare('INSERT INTO mine_run (id, repo_id, started_at) VALUES (?, ?, ?)')
        .run(runId, corpus.repoId, this.#now());
    }

    try {
      const result = await this.#run(runId, corpus);
      this.#db
        .prepare(
          `UPDATE mine_run
              SET finished_at = ?, high_water_pr = ?, observations = ?, candidates = ?
            WHERE id = ?`,
        )
        .run(
          this.#now(),
          highestPrNumber(corpus.pullRequests),
          result.observations,
          result.candidates,
          runId,
        );
      return result;
    } catch (error) {
      const message = (error as Error).message;
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
    }
  }

  async #run(runId: string, corpus: Corpus): Promise<MineResult> {
    const { extractable, heldOut } = splitCorpus(corpus);

    // ── pass 1 ──────────────────────────────────────────────────────────────
    // This is the long one: one model call per pull request, so it is where a run spends
    // almost all of its minutes and the only phase whose progress means anything to a human.
    const extractTotal = extractable.length + corpus.docs.length;
    let extractDone = 0;
    this.#onProgress({ phase: 'extracting', done: 0, total: extractTotal });

    const observations: Observation[] = [];
    for (const pr of extractable) {
      try {
        observations.push(...(await extractFromPullRequest(this.#model, pr)));
      } catch (error) {
        // One unreadable PR must not lose the other 199. The run reports the gap instead.
        this.#onWarning(`extract failed for PR #${pr.number}: ${(error as Error).message}`);
      }
      extractDone += 1;
      this.#onProgress({ phase: 'extracting', done: extractDone, total: extractTotal });
    }
    for (const doc of corpus.docs) {
      try {
        observations.push(...(await extractFromDoc(this.#model, doc, this.#now())));
      } catch (error) {
        this.#onWarning(`extract failed for ${doc.path}: ${(error as Error).message}`);
      }
      extractDone += 1;
      this.#onProgress({ phase: 'extracting', done: extractDone, total: extractTotal });
    }

    // ── pass 2 ──────────────────────────────────────────────────────────────
    this.#onProgress({ phase: 'clustering', done: 0, total: 1 });
    const candidates = await clusterObservations(this.#model, observations);
    const byId = new Map(observations.map((o) => [o.id, o]));

    // ── pass 3, then the thresholds ─────────────────────────────────────────
    let written = 0;
    let rejected = 0;
    let reconfirmed = 0;
    let belowThreshold = 0;
    let verified = 0;
    this.#onProgress({ phase: 'verifying', done: 0, total: candidates.length });

    for (const candidate of candidates) {
      verified += 1;
      this.#onProgress({ phase: 'verifying', done: verified, total: candidates.length });

      const support = candidate.observationIds
        .map((id) => byId.get(id))
        .filter((o): o is Observation => o !== undefined);

      if (!meetsThreshold(support)) {
        belowThreshold += 1;
        continue;
      }

      let verdict: Verdict;
      try {
        verdict = await verifyCandidate(this.#model, candidate, heldOut);
      } catch (error) {
        this.#onWarning(`verify failed for "${candidate.ruleText}": ${(error as Error).message}`);
        verdict = { supported: 0, violated: 0, unknown: heldOut.length, notes: 'verify failed' };
      }

      const confidence = scoreCandidate(support, verdict);
      const evidence = support.map(toEvidence);

      // An incremental re-mine sees the same conventions again. Re-confirming is the point —
      // §13.4's decay reads `last_confirmed_at`, so a rule the project still enforces must be
      // touched by every run that sees it, not duplicated.
      const existing = this.#conventions.findSimilar(
        corpus.repoId,
        candidate.category,
        candidate.ruleText,
      );

      if (existing) {
        this.#conventions.reconfirm(existing.id, evidence, confidence);
        reconfirmed += 1;
        continue;
      }

      const id = this.#conventions.write({
        repoId: corpus.repoId,
        category: candidate.category,
        ruleText: candidate.ruleText,
        rationale: candidate.rationale,
        confidence,
        evidence,
      });

      if (contradicted(verdict)) {
        // §13.4 — "if merged PRs routinely violate it, mark rejected". Recorded rather than
        // discarded: a disproved rule is a result, and the evidence explains the disproof.
        this.#conventions.reject(
          id,
          verdict.notes ??
            `held-out sample: ${verdict.violated} merged PRs violate this, ${verdict.supported} support it`,
        );
        rejected += 1;
      } else {
        this.#conventions.promote(id, 'confidence');
        written += 1;
      }
    }

    return {
      runId,
      observations: observations.length,
      candidates: candidates.length,
      written,
      rejected,
      reconfirmed,
      belowThreshold,
      error: null,
    };
  }
}

/**
 * §13.4 pass 2 — the thresholds, counted rather than requested.
 *
 * The CI/CODEOWNERS exception is not a shortcut: a rule that a workflow file enforces is true
 * whether or not anyone ever commented on it, and requiring three humans to have complained
 * about a mechanically enforced gate would systematically miss the rules that are hardest to
 * argue with.
 */
export function meetsThreshold(support: readonly Observation[]): boolean {
  const mechanical = support.some(
    (o) => o.sourceKind === 'ci_config' || isCodeowners(o),
  );
  if (mechanical) return true;

  const distinctPrs = new Set(
    support.map((o) => o.prNumber).filter((n): n is number => n !== null),
  );
  return support.length >= MIN_OBSERVATIONS && distinctPrs.size >= MIN_DISTINCT_PRS;
}

function isCodeowners(o: Observation): boolean {
  return o.sourceKind === 'stated_doc' && /codeowners/i.test(o.url);
}

/**
 * Confidence — §13.2's weights and §13.4's verification, combined.
 *
 *   base   = half the strongest source's weight, half how broadly it was observed
 *   factor = how the held-out sample behaved: 0.5 with no evidence either way, 1.0 when the
 *            sample consistently supports it
 *
 * The floor at 0.5× matters: an unverified rule lands below §13.4's 0.8 auto-promotion bar and
 * therefore waits for a human. That is the intended default. A rule nobody checked should not
 * start steering agents on its own.
 *
 * The exception is CI: a workflow that runs a job is not a claim about the project, it *is* the
 * project, so a mechanically enforced rule is not penalized for a silent sample.
 */
export function scoreCandidate(support: readonly Observation[], verdict: Verdict): number {
  const maxWeight = Math.max(...support.map((o) => SOURCE_WEIGHT[o.sourceKind]));
  const breadth = Math.min(1, support.length / 5);
  const base = 0.5 * maxWeight + 0.5 * breadth;

  const decided = verdict.supported + verdict.violated;
  const mechanical = support.some((o) => o.sourceKind === 'ci_config');
  const ratio = decided > 0 ? verdict.supported / decided : mechanical ? 1 : 0;

  return round2(base * (0.5 + 0.5 * ratio));
}

function contradicted(verdict: Verdict): boolean {
  return verdict.violated > verdict.supported && verdict.violated > 0;
}

/**
 * The held-out split — §13.4 pass 3.
 *
 * Held out from *extraction*, not merely from verification. Testing a rule against the very
 * comments that produced it measures nothing, and doing the split here rather than in the verify
 * pass makes it impossible to forget.
 *
 * The newest merged PRs are held out rather than a random slice: they are the best evidence of
 * what the project enforces *now*, which is the question a candidate rule is being asked.
 */
export function splitCorpus(corpus: Corpus): {
  extractable: PullRequestRecord[];
  heldOut: PullRequestRecord[];
} {
  const merged = corpus.pullRequests
    .filter((pr) => pr.outcome === 'merged')
    .sort((a, b) => b.number - a.number);
  const rejectedPrs = corpus.pullRequests.filter((pr) => pr.outcome === 'closed_unmerged');

  const holdCount = Math.floor(merged.length * HELD_OUT_FRACTION);
  const heldOut = merged.slice(0, holdCount);

  return {
    // Rejections are never held out. §13.2 rates them the strongest signal there is, and there
    // are far fewer of them; spending one on validation costs more than it buys.
    extractable: [...rejectedPrs, ...merged.slice(holdCount)],
    heldOut,
  };
}

function toEvidence(o: Observation): Evidence {
  return {
    kind: EVIDENCE_KIND_FOR[o.sourceKind],
    url: o.url,
    excerpt: o.quote,
    observedAt: o.observedAt,
  };
}

function highestPrNumber(prs: readonly PullRequestRecord[]): number | null {
  if (prs.length === 0) return null;
  return Math.max(...prs.map((pr) => pr.number));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type { CandidateRule };
