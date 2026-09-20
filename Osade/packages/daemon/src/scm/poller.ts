import type { ChecksState, PrState, ReviewState } from '@osade/contract';

import type { Db } from '../db/index.js';
import { getTask, listTasks } from '../db/task-repo.js';
import { NOT_MODIFIED, ScmClient } from './client.js';

/**
 * The SCM observer — OSADE.md §11.1.
 *
 * v1 is local-first with no public ingress, so there is no webhook endpoint. This polls.
 *
 * **INVARIANT: a failed fetch is a fact, not a state change.** A failed poll writes
 * `fetch_failed_at` and changes nothing else. This is the same discipline as §5.2's failed
 * probe: transient GitHub trouble must never look like a PR closing, checks failing, or a
 * review being withdrawn.
 */

/** §11.1 — cadences, matching AO's scm observer. */
export const PR_POLL_INTERVAL_MS = 30_000;
export const ISSUE_POLL_INTERVAL_MS = 5 * 60_000;

export interface PollerOptions {
  now?: () => number;
  onWarning?: (message: string) => void;
  /**
   * §21 M2 — `review_changes_requested` loops back into the agent lane.
   *
   * The same shape as the verification failure loop (§10.2), and for the same reason: a
   * reviewer's comment that only lands in the database is a comment the agent never sees.
   * Injected so the poller does not depend on the launcher.
   */
  sendToAgent?: (taskId: string, text: string) => Promise<void>;
}

interface RepoRow {
  id: string;
  gh_owner: string | null;
  gh_name: string | null;
  upstream_remote: string | null;
  fork_of: string | null;
}

interface PullRequestPayload {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  mergeable_state?: string;
  head: { sha: string; ref?: string };
}

interface ReviewPayload {
  state: string;
  submitted_at: string | null;
  body?: string | null;
  /** Absent on some historical reviews; treated as one anonymous reviewer. */
  user?: { login: string } | null;
}

/**
 * Each reviewer's standing verdict, in GitHub's own terms:
 *
 *   APPROVED / CHANGES_REQUESTED  replace that author's standing verdict
 *   COMMENTED                     carries no verdict and leaves a standing one alone
 *   DISMISSED                     clears it
 *
 * The listing is chronological, so the last verdict per author wins. Shared by the fact writer
 * and the agent loop so the two can never disagree about who is still waiting.
 */
function standingVerdicts(
  reviews: readonly ReviewPayload[],
): Map<string, { state: ReviewState; body: string | null }> {
  const verdicts = new Map<string, { state: ReviewState; body: string | null }>();

  for (const review of reviews) {
    // A review with no author is one anonymous reviewer, not many.
    const author = review.user?.login ?? '';
    const state = review.state.toUpperCase();
    const body = review.body ?? null;

    if (state === 'CHANGES_REQUESTED') verdicts.set(author, { state: 'changes_requested', body });
    else if (state === 'APPROVED') verdicts.set(author, { state: 'approved', body });
    else if (state === 'DISMISSED') verdicts.delete(author);
    else if (state === 'COMMENTED' && !verdicts.has(author)) {
      verdicts.set(author, { state: 'commented', body });
    }
  }

  return verdicts;
}

interface CheckRunsPayload {
  check_runs: { status: string; conclusion: string | null }[];
}

export class ScmPoller {
  readonly #db: Db;
  readonly #scm: ScmClient;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;
  readonly #sendToAgent: ((taskId: string, text: string) => Promise<void>) | null;
  #prTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, scm: ScmClient, options: PollerOptions = {}) {
    this.#db = db;
    this.#scm = scm;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#sendToAgent = options.sendToAgent ?? null;
  }

  start(): void {
    if (this.#prTimer) return;
    this.#prTimer = setInterval(() => void this.pollOpenPrs(), PR_POLL_INTERVAL_MS);
    this.#prTimer.unref?.();
  }

  stop(): void {
    if (this.#prTimer) clearInterval(this.#prTimer);
    this.#prTimer = null;
  }

  /**
   * Refreshes every task that has a PR.
   *
   * Exposed rather than private so tests drive it deterministically instead of sleeping, and
   * so the UI can force a refresh without waiting out the interval.
   */
  async pollOpenPrs(): Promise<number> {
    // §11.1 — check before spending a request, not after being told off.
    if (this.#scm.shouldBackOff) {
      this.#onWarning('skipping the PR poll: GitHub rate limit is below 20%');
      return 0;
    }

    const rows = this.#db
      .prepare(
        `SELECT s.task_id, s.pr_number, t.repo_id
           FROM scm_fact s JOIN task t ON t.id = s.task_id
          WHERE s.pr_number IS NOT NULL AND (s.pr_state IS NULL OR s.pr_state = 'open')`,
      )
      .all() as { task_id: string; pr_number: number; repo_id: string }[];

    let refreshed = 0;
    for (const row of rows) {
      if (await this.refreshPr(row.task_id, row.pr_number)) refreshed++;
    }
    return refreshed;
  }

  /**
   * One PR's facts.
   *
   * Returns false when nothing was written — either the poll failed (and only
   * `fetch_failed_at` moved) or GitHub answered 304 and there was nothing to write.
   */
  async refreshPr(taskId: string, prNumber: number): Promise<boolean> {
    const repo = this.#repoFor(taskId);
    if (!repo?.gh_owner || !repo.gh_name) return false;

    const target = { owner: repo.gh_owner, repo: repo.gh_name, pull_number: prNumber };

    try {
      const pr = await this.#scm.get<PullRequestPayload>(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        target,
      );

      if (pr === NOT_MODIFIED) {
        // A successful poll that found nothing new. Record that we looked; change no facts.
        this.#db
          .prepare('UPDATE scm_fact SET fetched_at = ?, fetch_failed_at = NULL WHERE task_id = ?')
          .run(this.#now(), taskId);
        return false;
      }

      const [reviewState, unresolved] = await this.#reviewState(target);
      const checks = await this.#checksState(target, pr.head.sha);
      const before = this.#db
        .prepare('SELECT review_state FROM scm_fact WHERE task_id = ?')
        .get(taskId) as { review_state: string | null } | undefined;

      this.#db
        .prepare(
          `UPDATE scm_fact
              SET pr_url = ?, pr_state = ?, pr_head_sha = ?, pr_head_ref = ?, pr_draft = ?,
                  checks_state = ?, review_state = ?, unresolved_threads = ?,
                  mergeable = ?, fetched_at = ?, fetch_failed_at = NULL
            WHERE task_id = ?`,
        )
        .run(
          pr.html_url,
          prState(pr),
          pr.head.sha,
          pr.head.ref ?? null,
          pr.draft ? 1 : 0,
          checks,
          reviewState,
          unresolved,
          mergeable(pr.mergeable_state),
          this.#now(),
          taskId,
        );

      // Only on the transition, not on every poll: a reviewer who asked for changes once
      // should not be re-delivered to the agent every 30 seconds.
      if (reviewState === 'changes_requested' && before?.review_state !== 'changes_requested') {
        await this.#closeReviewLoop(taskId, target, pr.html_url, pr.head.ref);
      }

      return true;
    } catch (err) {
      // §11.1 — INVARIANT. Nothing else on the row is touched: a 502 from GitHub must not
      // read as a closed PR, failing checks, or a withdrawn review.
      this.#db
        .prepare('UPDATE scm_fact SET fetch_failed_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      this.#onWarning(`PR poll failed for ${taskId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * The review verdict, plus how many reviewers are still asking for changes.
   *
   * Only the latest verdict per author counts — an approval after that author's own change
   * request means they are satisfied, and summing raw review rows would keep the task in the
   * needs-you set forever (§6 row 5).
   *
   * That grouping is **per author**, which is the part this got wrong until 2026-09-10: a single
   * running verdict meant one reviewer's approval cancelled a different reviewer's outstanding
   * request, and the task quietly left the needs-you set with a maintainer still waiting.
   */
  async #reviewState(target: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<[ReviewState, number]> {
    const reviews = await this.#scm.get<ReviewPayload[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      target,
    );
    if (reviews === NOT_MODIFIED || !Array.isArray(reviews)) return ['none', 0];

    const standing = [...standingVerdicts(reviews).values()].map((v) => v.state);
    // A real count: how many *reviewers* are still waiting. Not review rows — one reviewer who
    // asked three times is one person to satisfy — and no longer a boolean wearing a number's
    // clothes, which is what this field was until now.
    const unresolved = standing.filter((v) => v === 'changes_requested').length;

    // One outstanding request outranks any number of approvals.
    const overall: ReviewState =
      unresolved > 0
        ? 'changes_requested'
        : standing.includes('approved')
          ? 'approved'
          : standing.includes('commented')
            ? 'commented'
            : 'none';

    return [overall, unresolved];
  }

  /**
   * Hands a reviewer's requested changes to the agent — §21 M2.
   *
   * The agent gets the review bodies, not a summary: a reviewer's exact words are the whole
   * signal, and paraphrasing them is how you lose the specific thing they asked for.
   */
  async #closeReviewLoop(
    taskId: string,
    target: { owner: string; repo: string; pull_number: number },
    prUrl: string,
    headRef?: string,
  ): Promise<void> {
    if (!this.#sendToAgent) return;

    const dest = this.#laneOnPrBranch(taskId, headRef);
    if (dest == null) return;

    const bodies = await this.#changeRequestBodies(target);
    const prompt = [
      `A reviewer requested changes on ${prUrl}.`,
      '',
      bodies.length > 0 ? 'What they said:' : 'No written comment was left with the review.',
      ...bodies.map((b) => `\n> ${b.trim().split('\n').join('\n> ')}`),
      '',
      'Address this in the worktree. Do not push, comment, or update the pull request —',
      'those are gated and Osade performs them after human approval.',
    ].join('\n');

    try {
      await this.#sendToAgent(dest, prompt);
    } catch (err) {
      // A prompt that cannot be delivered is a degraded loop, not a failed poll: the facts are
      // already durable and §6 row 5 shows `review_changes_requested` regardless.
      this.#onWarning(`could not deliver review feedback to ${dest}: ${(err as Error).message}`);
    }
  }

  /** Null when the chat has no lane on the PR branch — the UI offers one instead of forking. */
  #laneOnPrBranch(taskId: string, headRef: string | undefined): string | null {
    const task = getTask(this.#db, taskId);
    if (!task) return null;
    if (!headRef) return taskId;
    if (task.branch === headRef || task.checkout_ref === headRef) return taskId;
    const sibling = this.#db
      .prepare(
        `SELECT id FROM task
          WHERE chat_id = ? AND archived_at IS NULL AND id != ?
            AND (branch = ? OR checkout_ref = ?)
          LIMIT 1`,
      )
      .get(task.chat_id, taskId, headRef, headRef) as { id: string } | undefined;
    return sibling?.id ?? null;
  }

  async #changeRequestBodies(target: {
    owner: string;
    repo: string;
    pull_number: number;
  }): Promise<string[]> {
    const reviews = await this.#scm
      .get<ReviewPayload[]>('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', target)
      .catch(() => null);
    if (!reviews || typeof reviews === 'symbol' || !Array.isArray(reviews)) return [];

    // Only requests that are still standing. A reviewer who asked and then approved has been
    // satisfied, and replaying their words spends the agent's turn re-fixing something that is
    // already done — the same per-author grouping §6 row 5 needs, for the same reason.
    return [...standingVerdicts(reviews).values()]
      .filter((v) => v.state === 'changes_requested')
      .map((v) => v.body ?? '')
      .filter((b) => b.trim().length > 0);
  }

  async #checksState(
    target: { owner: string; repo: string },
    sha: string,
  ): Promise<ChecksState | null> {
    const runs = await this.#scm.get<CheckRunsPayload>(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      { owner: target.owner, repo: target.repo, ref: sha },
    );
    if (runs === NOT_MODIFIED || !runs?.check_runs) return null;
    if (runs.check_runs.length === 0) return 'neutral';

    let sawPending = false;
    for (const run of runs.check_runs) {
      if (run.status !== 'completed') sawPending = true;
      else if (run.conclusion === 'failure' || run.conclusion === 'timed_out') return 'failure';
    }
    return sawPending ? 'pending' : 'success';
  }

  #repoFor(taskId: string): RepoRow | null {
    const task = getTask(this.#db, taskId);
    if (!task) return null;
    return (
      (this.#db.prepare('SELECT * FROM repo WHERE id = ?').get(task.repo_id) as RepoRow) ?? null
    );
  }

  /**
   * §11.1 — the issue list for watched repos, every 5 minutes.
   *
   * Returns candidates rather than creating tasks: importing an issue is a user action (§12),
   * and a poller that silently created work would be a poller that spends your agent budget.
   */
  async pollIssues(repoId: string): Promise<ImportableIssue[]> {
    if (this.#scm.shouldBackOff) return [];

    const repo = this.#db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId) as
      | RepoRow
      | undefined;
    if (!repo?.gh_owner || !repo.gh_name) return [];

    try {
      const issues = await this.#scm.get<
        { number: number; title: string; body: string | null; html_url: string; pull_request?: unknown }[]
      >('GET /repos/{owner}/{repo}/issues', {
        owner: repo.gh_owner,
        repo: repo.gh_name,
        state: 'open',
        per_page: 50,
      });
      if (issues === NOT_MODIFIED || !Array.isArray(issues)) return [];

      // GitHub returns PRs from the issues endpoint. They are not issues.
      return issues
        .filter((i) => i.pull_request == null)
        .map((i) => ({
          number: i.number,
          title: i.title,
          body: i.body ?? '',
          url: i.html_url,
        }));
    } catch (err) {
      this.#onWarning(`issue poll failed for ${repoId}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Every task with a PR that has not been polled recently. Used by the UI's refresh. */
  stalePrTasks(olderThanMs = PR_POLL_INTERVAL_MS): string[] {
    const cutoff = this.#now() - olderThanMs;
    return listTasks(this.#db)
      .map((t) => t.id)
      .filter((id) => {
        const row = this.#db
          .prepare('SELECT fetched_at, pr_number FROM scm_fact WHERE task_id = ?')
          .get(id) as { fetched_at: number; pr_number: number | null } | undefined;
        return row?.pr_number != null && row.fetched_at < cutoff;
      });
  }
}

export interface ImportableIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

function prState(pr: PullRequestPayload): PrState {
  if (pr.merged) return 'merged';
  return pr.state === 'closed' ? 'closed' : 'open';
}

function mergeable(state: string | undefined): 'clean' | 'dirty' | 'blocked' | 'unknown' {
  switch (state) {
    case 'clean':
      return 'clean';
    case 'dirty':
      return 'dirty';
    case 'blocked':
    case 'behind':
      return 'blocked';
    default:
      return 'unknown';
  }
}
