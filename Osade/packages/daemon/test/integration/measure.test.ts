import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { MIN_TASKS_PER_ARM, compareInjection } from '../../src/knowledge/measure.js';

/**
 * §13.6 — the measurable claim.
 *
 * The point of these tests is that the measurement is capable of returning bad news. A metric
 * that can only flatter the feature it measures is not a metric.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let nextTask = 0;

function seed(): void {
  db.prepare('INSERT INTO repo (id, path, default_branch, created_at) VALUES (?, ?, ?, ?)').run(
    'r1',
    '/repo',
    'main',
    NOW,
  );
}

/** A merged task, with or without conventions injected at launch. */
function mergedTask(injectedRules: number, prNumber: number): string {
  const id = `t${(nextTask += 1)}`;
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, base_ref, base_sha, branch,
                       worktree_path, created_at)
     VALUES (?, 'r1', 'x', 'x', 'manual', 'main', 'sha', 'osade/x', '/wt', ?)`,
  ).run(id, NOW);
  db.prepare(
    `INSERT INTO scm_fact (task_id, pr_number, pr_state, unresolved_threads, fetched_at)
     VALUES (?, ?, 'merged', 0, ?)`,
  ).run(id, prNumber, NOW);

  if (injectedRules >= 0) {
    db.prepare(
      'INSERT INTO task_injection (task_id, rule_count, omitted, injected_at) VALUES (?, ?, 0, ?)',
    ).run(id, injectedRules, NOW);
  }
  return id;
}

function rounds(byPr: Record<number, number | null>) {
  return async (pr: number) => byPr[pr] ?? null;
}

beforeEach(() => {
  db = openDb(':memory:');
  nextTask = 0;
  seed();
});

afterEach(() => {
  db.close();
});

describe('the comparison', () => {
  it('refuses a verdict below the sample size §13.6 asks for', async () => {
    mergedTask(12, 1);
    mergedTask(0, 2);

    const result = await compareInjection(db, 'r1', rounds({ 1: 1, 2: 3 }));
    expect(result.verdict).toContain('not enough data');
    expect(result.verdict).toContain(String(MIN_TASKS_PER_ARM));
  });

  it('reports a real improvement when the number moves', async () => {
    const byPr: Record<number, number> = {};
    for (let i = 0; i < MIN_TASKS_PER_ARM; i += 1) {
      mergedTask(12, 100 + i);
      byPr[100 + i] = 1;
      mergedTask(0, 200 + i);
      byPr[200 + i] = 3;
    }

    const result = await compareInjection(db, 'r1', rounds(byPr));
    expect(result.withConventions.meanReviewRounds).toBe(1);
    expect(result.withoutConventions.meanReviewRounds).toBe(3);
    expect(result.difference).toBe(-2);
    expect(result.verdict).toContain('reduced review rounds by 2');
  });

  it('says the feature is wrong when the number does not move — §13.6 has teeth', async () => {
    const byPr: Record<number, number> = {};
    for (let i = 0; i < MIN_TASKS_PER_ARM; i += 1) {
      mergedTask(12, 100 + i);
      byPr[100 + i] = 2;
      mergedTask(0, 200 + i);
      byPr[200 + i] = 2;
    }

    const result = await compareInjection(db, 'r1', rounds(byPr));
    expect(result.difference).toBe(0);
    expect(result.verdict).toContain('redesigned, not shipped');
  });

  it('says so when conventions made things worse', async () => {
    const byPr: Record<number, number> = {};
    for (let i = 0; i < MIN_TASKS_PER_ARM; i += 1) {
      mergedTask(12, 100 + i);
      byPr[100 + i] = 4;
      mergedTask(0, 200 + i);
      byPr[200 + i] = 2;
    }

    const result = await compareInjection(db, 'r1', rounds(byPr));
    expect(result.verdict).toContain('made this worse');
    expect(result.verdict).toContain('redesigned, not shipped');
  });
});

describe('what counts as a data point', () => {
  it('keeps an unreadable pull request out of both arms and reports it', async () => {
    mergedTask(12, 1);
    mergedTask(12, 2);

    const result = await compareInjection(db, 'r1', rounds({ 1: 2, 2: null }));
    expect(result.withConventions.n).toBe(1);
    expect(result.unreadable).toBe(1);
  });

  it('counts a launch that injected nothing as the control arm, not as missing data', async () => {
    mergedTask(0, 1);
    const result = await compareInjection(db, 'r1', rounds({ 1: 2 }));
    expect(result.withoutConventions.n).toBe(1);
  });

  it('treats a task launched before the instrumentation existed as a control', async () => {
    mergedTask(-1, 1); // no task_injection row at all
    const result = await compareInjection(db, 'r1', rounds({ 1: 2 }));
    expect(result.withoutConventions.n).toBe(1);
  });

  it('ignores tasks that never merged — rounds *to merge* is the metric', async () => {
    const id = mergedTask(12, 1);
    db.prepare("UPDATE scm_fact SET pr_state = 'open' WHERE task_id = ?").run(id);

    const result = await compareInjection(db, 'r1', rounds({ 1: 2 }));
    expect(result.withConventions.n).toBe(0);
    expect(result.withoutConventions.n).toBe(0);
  });

  it('reports first-round acceptance alongside the mean', async () => {
    mergedTask(12, 1);
    mergedTask(12, 2);
    mergedTask(12, 3);
    mergedTask(12, 4);

    const result = await compareInjection(db, 'r1', rounds({ 1: 0, 2: 0, 3: 0, 4: 2 }));
    expect(result.withConventions.firstRoundAcceptance).toBe(0.75);
    expect(result.withConventions.medianReviewRounds).toBe(0);
  });
});
