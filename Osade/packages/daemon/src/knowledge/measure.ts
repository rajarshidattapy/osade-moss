import type { Db } from '../db/index.js';

/**
 * The measurable claim — OSADE.md §13.6.
 *
 * > This feature exists to move one number: **review rounds to merge.** Instrument it from day
 * > one. The M3 acceptance criterion is a real comparison on real tasks, not a vibe.
 *
 * And the criterion has teeth: **if the number does not move, the feature is wrong and should be
 * redesigned, not shipped.** So this is written to be capable of returning a disappointing
 * answer. It reports what it measured, how many tasks it had, and what it could not read — never
 * a single flattering figure.
 *
 * `task_injection` records how many rules each launch actually injected, captured at launch
 * because by the time a PR merges the repo's conventions have moved on.
 */

export interface Arm {
  /** Tasks in this arm whose review rounds could be read. */
  n: number;
  meanReviewRounds: number | null;
  medianReviewRounds: number | null;
  /** Merged with zero rounds of requested changes. */
  firstRoundAcceptance: number | null;
}

export interface Comparison {
  repoId: string;
  withConventions: Arm;
  withoutConventions: Arm;
  /** Negative means conventions reduced review rounds — the direction §13.6 is asking about. */
  difference: number | null;
  /** Tasks skipped because GitHub's reviews could not be read. Never silently folded in. */
  unreadable: number;
  /** Plain words, including "this is not enough data" when that is the truth. */
  verdict: string;
}

/** §13.6's acceptance bar: "N ≥ 10 comparable tasks". Below this, no verdict is honest. */
export const MIN_TASKS_PER_ARM = 10;

interface Sample {
  taskId: string;
  prNumber: number;
  injectedRules: number;
}

/** The tasks that can be compared: one PR each, and a launch we recorded the injection for. */
export function comparableTasks(db: Db, repoId: string): Sample[] {
  const rows = db
    .prepare(
      `SELECT t.id AS task_id,
              s.pr_number AS pr_number,
              COALESCE(i.rule_count, 0) AS injected
         FROM task t
         JOIN scm_fact s ON s.task_id = t.id
    LEFT JOIN task_injection i ON i.task_id = t.id
        WHERE t.repo_id = ?
          AND s.pr_number IS NOT NULL
          AND s.pr_state = 'merged'`,
    )
    .all(repoId) as { task_id: string; pr_number: number; injected: number }[];

  return rows.map((r) => ({
    taskId: r.task_id,
    prNumber: r.pr_number,
    injectedRules: r.injected,
  }));
}

/**
 * Runs the comparison.
 *
 * `roundsFor` is injected so this file stays free of GitHub: `scm/corpus.ts` supplies the real
 * one, and a test supplies a recorded one.
 */
export async function compareInjection(
  db: Db,
  repoId: string,
  roundsFor: (prNumber: number) => Promise<number | null>,
): Promise<Comparison> {
  const withRules: number[] = [];
  const withoutRules: number[] = [];
  let unreadable = 0;

  for (const sample of comparableTasks(db, repoId)) {
    const rounds = await roundsFor(sample.prNumber);
    if (rounds === null) {
      unreadable += 1;
      continue;
    }
    (sample.injectedRules > 0 ? withRules : withoutRules).push(rounds);
  }

  const a = arm(withRules);
  const b = arm(withoutRules);
  const difference =
    a.meanReviewRounds !== null && b.meanReviewRounds !== null
      ? round2(a.meanReviewRounds - b.meanReviewRounds)
      : null;

  return {
    repoId,
    withConventions: a,
    withoutConventions: b,
    difference,
    unreadable,
    verdict: verdictFor(a, b, difference),
  };
}

function arm(rounds: number[]): Arm {
  if (rounds.length === 0) {
    return { n: 0, meanReviewRounds: null, medianReviewRounds: null, firstRoundAcceptance: null };
  }
  const sorted = [...rounds].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: rounds.length,
    meanReviewRounds: round2(rounds.reduce((sum, r) => sum + r, 0) / rounds.length),
    medianReviewRounds:
      sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!,
    firstRoundAcceptance: round2(rounds.filter((r) => r === 0).length / rounds.length),
  };
}

/**
 * The verdict, in words.
 *
 * "Not enough data" is the default and the most likely honest answer for a long while. A mean of
 * three tasks against two is not evidence of anything, and reporting it as though it were is how
 * a feature ships on a number that was never real.
 */
function verdictFor(withRules: Arm, without: Arm, difference: number | null): string {
  if (withRules.n < MIN_TASKS_PER_ARM || without.n < MIN_TASKS_PER_ARM) {
    return (
      `not enough data: ${withRules.n} task(s) with conventions and ${without.n} without. ` +
      `§13.6 asks for at least ${MIN_TASKS_PER_ARM} comparable tasks in each arm.`
    );
  }
  if (difference === null) return 'not enough data to compare.';
  if (difference <= -0.5) {
    return `conventions reduced review rounds by ${Math.abs(difference)} on average.`;
  }
  if (difference >= 0.5) {
    return (
      `conventions made this worse: ${difference} more review rounds on average. ` +
      `§13.6 — the feature is wrong and should be redesigned, not shipped.`
    );
  }
  return (
    `no meaningful difference (${difference} rounds). §13.6 — if the number does not move, ` +
    `the feature is wrong and should be redesigned, not shipped.`
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
