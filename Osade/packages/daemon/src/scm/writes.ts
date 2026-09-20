import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import { taskCwd } from '../domain/cwd.js';
import { git, resolveSha } from '../domain/git.js';
import { Gates, type GateName } from '../domain/gates.js';
import { DIFF_BEARING } from '../domain/gates.js';
import type { GateClauses } from '../domain/gate-clauses.js';
import type { Attestations } from '../attest/service.js';
import { withBlock } from '../attest/statement.js';
import { ScmClient, ScmError } from './client.js';

/**
 * Public writes — OSADE.md §11.2.
 *
 * **INVARIANT: every write is a `gate_request` first.** The payload is hashed at request time
 * and re-hashed at execution; a mismatch aborts. Nothing in this file performs a write without
 * calling `gates.assertExecutable` immediately before it, which is the whole point: hashing at
 * request time proves nothing if nobody checks at execution time.
 *
 * **INVARIANT (§1, non-goal 3): Osade never merges a PR.** There is no merge method here and
 * there must not be one.
 */

export interface OpenPrPayload {
  title: string;
  body: string;
  /** `owner:branch` when contributing from a fork. */
  head: string;
  base: string;
  draft: boolean;
  /**
   * A1 (OSADE-MOSS §M.7.1) — the exact commit this approval is for.
   *
   * Required, not optional: without it an agent could add commits between approval and
   * execution and the PR would open against code no human ever saw.
   */
  head_sha: string;
}

export interface CommentPayload {
  body: string;
}

export interface PushPayload {
  remote: string;
  branch: string;
  force: boolean;
  /** A1 — the exact commit being pushed, re-read from the branch before the push runs. */
  head_sha: string;
}

export interface ScmWritesOptions {
  now?: () => number;
  onWarning?: (message: string) => void;
  /**
   * OSADE-MOSS §M.8.2 — finds the policy clauses a diff-bearing gate touches.
   *
   * Optional: a daemon with no policies behaves exactly as before, and the gate payload keeps
   * hashing the way it always did. Injected rather than imported so this module stays unaware
   * of retrieval.
   */
  clauses?: GateClauses | null;
  /**
   * §M.7.2 — issues the attestation for an approved diff-bearing gate.
   *
   * Optional: a daemon without it opens pull requests exactly as before, with no block in the
   * body and no commit status. Injected so this module does not depend on the signing seam.
   */
  attest?: Attestations | null;
}

interface RepoRow {
  id: string;
  path: string;
  gh_owner: string | null;
  gh_name: string | null;
  default_branch: string;
  upstream_remote: string | null;
  fork_of: string | null;
}

export interface ForkPlan {
  /** Where the branch is pushed. */
  pushRemote: string;
  /** `owner:branch`, as GitHub wants it for a cross-repository PR. */
  head: string;
  /** The repository the PR is opened against. */
  prOwner: string;
  prRepo: string;
  prBase: string;
  /** True when this contribution goes through a fork rather than a direct branch. */
  viaFork: boolean;
}

export class ScmWrites {
  readonly #db: Db;
  readonly #scm: ScmClient;
  readonly #gates: Gates;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;
  readonly #clauses: GateClauses | null;
  readonly #attest: Attestations | null;

  constructor(db: Db, scm: ScmClient, gates: Gates, options: ScmWritesOptions = {}) {
    this.#db = db;
    this.#scm = scm;
    this.#gates = gates;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#clauses = options.clauses ?? null;
    this.#attest = options.attest ?? null;
  }

  /**
   * §11.3 — where a contribution actually goes.
   *
   * Most OSS contribution goes through a fork. **Never push to an upstream you do not own** —
   * and the permission check happens here, when the action is *planned*, rather than after the
   * user has approved a push that will 403.
   */
  async planFork(taskId: string): Promise<ForkPlan> {
    const repo = this.#repoFor(taskId);
    if (!repo?.gh_owner || !repo.gh_name) {
      throw new ScmError(`task ${taskId} has no GitHub remote`, 0);
    }
    const task = getTask(this.#db, taskId)!;

    // A recorded fork wins: `fork_of` means this checkout is the fork and upstream is elsewhere.
    if (repo.fork_of) {
      const [upstreamOwner, upstreamName] = repo.fork_of.split('/');
      return {
        pushRemote: 'origin',
        head: `${repo.gh_owner}:${task.branch}`,
        prOwner: upstreamOwner!,
        prRepo: upstreamName!,
        prBase: repo.default_branch,
        viaFork: true,
      };
    }

    // Otherwise: may we push here at all?
    const canPush = await this.#canPush(repo.gh_owner, repo.gh_name);
    if (canPush) {
      return {
        pushRemote: repo.upstream_remote ?? 'origin',
        head: task.branch,
        prOwner: repo.gh_owner,
        prRepo: repo.gh_name,
        prBase: repo.default_branch,
        viaFork: false,
      };
    }

    // No write access and no fork on record. §11.3 says offer to create one — behind a gate,
    // and as a decision the user makes rather than something that happens to them.
    throw new ScmError(
      `no push access to ${repo.gh_owner}/${repo.gh_name} and no fork recorded. ` +
        `Create a fork first (gate.fork_create), or set repo.fork_of.`,
      403,
    );
  }

  /**
   * Whether an existing fork is already available under the authenticated account.
   *
   * Checked before offering to create one: forking something the user already forked produces
   * a confusing no-op on GitHub's side and an offer that should never have been made.
   */
  async findExistingFork(taskId: string): Promise<{ owner: string; name: string } | null> {
    const repo = this.#repoFor(taskId);
    if (!repo?.gh_owner || !repo.gh_name) return null;

    const me = await this.#scm
      .get<{ login: string }>('GET /user', {})
      .catch(() => null);
    if (!me || typeof me === 'symbol') return null;

    const candidate = await this.#scm
      .get<{ fork: boolean; parent?: { full_name: string }; owner: { login: string }; name: string }>(
        'GET /repos/{owner}/{repo}',
        { owner: me.login, repo: repo.gh_name },
      )
      .catch(() => null);
    if (!candidate || typeof candidate === 'symbol') return null;

    const parent = candidate.parent?.full_name?.toLowerCase();
    if (!candidate.fork || parent !== `${repo.gh_owner}/${repo.gh_name}`.toLowerCase()) return null;

    return { owner: candidate.owner.login, name: candidate.name };
  }

  /**
   * Creates a fork — §11.3, behind `gate.fork_create`.
   *
   * Forking creates a **public repository under the user's account**, which is a visible act
   * done on their behalf, so it is gated like any other public write and the gate cannot be
   * downgraded by policy (§14.1).
   *
   * Records the result on the repo row so `planFork` routes through the fork afterwards.
   */
  async createFork(
    taskId: string,
    gateId: string,
    payload: { owner: string; repo: string },
  ): Promise<{ owner: string; name: string }> {
    // §11.2 — re-hashed at execution, like every other write.
    this.#gates.assertExecutable(gateId, payload);

    const repo = this.#repoFor(taskId);
    if (!repo?.gh_owner || !repo.gh_name) throw new ScmError('no GitHub remote', 0);

    try {
      const fork = await this.#scm.write<{ owner: { login: string }; name: string }>(
        'POST /repos/{owner}/{repo}/forks',
        { owner: payload.owner, repo: payload.repo },
      );

      // The checkout is now the fork's, and upstream is where it came from.
      this.#db
        .prepare('UPDATE repo SET fork_of = ?, gh_owner = ? WHERE id = ?')
        .run(`${repo.gh_owner}/${repo.gh_name}`, fork.owner.login, repo.id);

      this.#gates.markExecuted(gateId);
      return { owner: fork.owner.login, name: fork.name };
    } catch (err) {
      this.#gates.markExecuted(gateId, (err as Error).message);
      throw err;
    }
  }

  /**
   * Records a fork the user already has, without creating anything.
   *
   * No gate: adopting an existing fork writes nothing to GitHub. §14 gates *public writes*,
   * and treating a local bookkeeping update as one would train people to click through gates.
   */
  adoptFork(taskId: string, fork: { owner: string; name: string }): void {
    const repo = this.#repoFor(taskId);
    if (!repo?.gh_owner || !repo.gh_name) throw new ScmError('no GitHub remote', 0);
    this.#db
      .prepare('UPDATE repo SET fork_of = ?, gh_owner = ? WHERE id = ?')
      .run(`${repo.gh_owner}/${repo.gh_name}`, fork.owner, repo.id);
  }

  /** §11.3 — checked before offering the action, not after. */
  async #canPush(owner: string, name: string): Promise<boolean> {
    try {
      const repo = await this.#scm.get<{ permissions?: { push?: boolean } }>(
        'GET /repos/{owner}/{repo}',
        { owner, repo: name },
        { conditional: false },
      );
      if (typeof repo === 'symbol') return false;
      return repo.permissions?.push === true;
    } catch (err) {
      // Not knowing is not permission. A failed check must never read as "yes".
      this.#onWarning(`could not check push access to ${owner}/${name}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Requests a gate for a write. Nothing happens until it is approved. */

  /**
   * A1 — the commit a lane is currently at.
   *
   * **One definition, used twice**: the caller pins this into the gate payload at request
   * time, and `Gates` calls the very same function to re-read the branch before the write.
   * Two implementations of "what is this lane's head" would eventually disagree, and the one
   * place that would show up is an approval silently executing against the wrong commit.
   *
   * Null when there is no resolvable head — an unborn branch, a task whose worktree is gone.
   * The caller decides what that means; here it is simply not knowable.
   */
  async headSha(taskId: string): Promise<string | null> {
    const task = getTask(this.#db, taskId);
    if (!task) return null;
    try {
      return await resolveSha(cwdFor(this.#db, task), 'HEAD');
    } catch {
      return null;
    }
  }

  /**
   * §M.8.2 — requests a gate, computing its policy clauses first when the gate carries a diff.
   *
   * The clause set is found *before* the gate exists, because its hash is part of the payload
   * that gets hashed. The rows are written immediately after, against the new gate id. Both
   * halves are needed: the hash binds the approval, and the rows are what the card renders.
   */
  async requestGate(taskId: string, gate: GateName, payload: unknown): Promise<string> {
    const clauses =
      this.#clauses && DIFF_BEARING.has(gate) ? await this.#clauses.forTask(taskId) : null;

    const gateId = this.#gates.request({
      taskId,
      gate,
      payload,
      ...(clauses ? { clauses } : {}),
    });
    if (clauses) this.#clauses?.record(gateId, clauses);
    return gateId;
  }

  /**
   * Pushes the task branch.
   *
   * `git push` rather than an API call: the API has no way to push a branch, and shelling out
   * to git here is the same carve-out §1 grants for `prune`, `status` and `diff`.
   */
  async push(taskId: string, gateId: string, payload: PushPayload): Promise<void> {
    // §11.2 re-hash, plus A1's re-read of the branch head. A push is the first write that
    // leaves the machine, so it is the last place the pin can still be checked cheaply.
    await this.#gates.assertExecutableNow(gateId, payload);

    const task = getTask(this.#db, taskId);
    if (!task) throw new ScmError(`unknown task ${taskId}`, 0);

    const args = ['push', payload.remote, `${payload.branch}:${payload.branch}`];
    if (payload.force) {
      // gate.force_push is the one gate a policy can never downgrade (§14.1), so reaching
      // here at all means a human said so explicitly.
      args.push('--force-with-lease');
    }

    try {
      await git(cwdFor(this.#db, task), args, 120_000);
      this.#gates.markExecuted(gateId);
    } catch (err) {
      this.#gates.markExecuted(gateId, (err as Error).message);
      throw err;
    }
  }

  /** Opens a pull request. Requires an approved `gate.pr_open`. */
  async openPr(
    taskId: string,
    gateId: string,
    payload: OpenPrPayload,
  ): Promise<{ number: number; url: string }> {
    await this.#gates.assertExecutableNow(gateId, payload);

    // §M.7.2 — the attestation is issued here, between the head re-read and the GitHub call.
    //
    // The ordering is the guarantee. Issued earlier it could name a commit the re-read was
    // about to reject; issued later there would be a window in which a PR exists without one.
    // A write that then fails leaves an attestation with no PR, which is harmless — but a PR
    // can never exist without an attestation, because the body carries it.
    const attestation = this.#attest?.issue(gateId) ?? null;
    const body = attestation ? withBlock(payload.body, attestation.block) : payload.body;

    const plan = await this.planFork(taskId);
    try {
      const pr = await this.#scm.write<{ number: number; html_url: string; head: { sha: string } }>(
        'POST /repos/{owner}/{repo}/pulls',
        {
          owner: plan.prOwner,
          repo: plan.prRepo,
          title: payload.title,
          body,
          head: payload.head,
          base: payload.base,
          draft: payload.draft,
        },
      );

      this.#db
        .prepare(
          `INSERT INTO scm_fact (task_id, pr_number, pr_url, pr_state, pr_head_sha, pr_draft,
                                 unresolved_threads, fetched_at)
           VALUES (?, ?, ?, 'open', ?, ?, 0, ?)
           ON CONFLICT(task_id) DO UPDATE SET pr_number = excluded.pr_number,
                                              pr_url = excluded.pr_url,
                                              pr_state = 'open',
                                              pr_head_sha = excluded.pr_head_sha,
                                              pr_draft = excluded.pr_draft,
                                              fetched_at = excluded.fetched_at,
                                              fetch_failed_at = NULL`,
        )
        .run(taskId, pr.number, pr.html_url, pr.head?.sha ?? null, payload.draft ? 1 : 0, this.#now());

      if (attestation) {
        await this.#postApprovalStatus(plan, payload.head_sha, attestation.statement.approved_by);
      }

      this.#gates.markExecuted(gateId);
      return { number: pr.number, url: pr.html_url };
    } catch (err) {
      this.#gates.markExecuted(gateId, (err as Error).message);
      throw err;
    }
  }

  /** Comments on the task's PR or its originating issue. Requires an approved gate. */
  async comment(
    taskId: string,
    gateId: string,
    payload: CommentPayload,
    target: { issueNumber: number },
  ): Promise<{ url: string }> {
    this.#gates.assertExecutable(gateId, payload);

    const repo = this.#repoFor(taskId);
    if (!repo?.gh_owner || !repo.gh_name) throw new ScmError('no GitHub remote', 0);

    try {
      const comment = await this.#scm.write<{ html_url: string }>(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner: repo.gh_owner,
          repo: repo.gh_name,
          issue_number: target.issueNumber,
          body: payload.body,
        },
      );
      this.#gates.markExecuted(gateId);
      return { url: comment.html_url };
    } catch (err) {
      this.#gates.markExecuted(gateId, (err as Error).message);
      throw err;
    }
  }

  #repoFor(taskId: string): RepoRow | null {
    const task = getTask(this.#db, taskId);
    if (!task) return null;
    return (
      (this.#db.prepare('SELECT * FROM repo WHERE id = ?').get(task.repo_id) as RepoRow) ?? null
    );
  }

  /**
   * §M.7.3 — the `osade/human-approved` commit status.
   *
   * The Statuses API rather than a check run: check runs need a GitHub App, and this has to
   * work with the user token Osade already holds. It is written inside the already-approved
   * `gate.pr_open` — part of what the human approved, since the approval covered the PR body
   * that carries the same claim — and never as a separate unapproved act.
   *
   * Best-effort: a status that fails to post must not undo a pull request that already exists.
   */
  async #postApprovalStatus(
    plan: { prOwner: string; prRepo: string },
    headSha: string,
    approvedBy: string,
  ): Promise<void> {
    try {
      await this.#scm.write('POST /repos/{owner}/{repo}/statuses/{sha}', {
        owner: plan.prOwner,
        repo: plan.prRepo,
        sha: headSha,
        state: 'success',
        context: 'osade/human-approved',
        description: `Approved by ${approvedBy.replace(/^github:/, '@')}`.slice(0, 140),
      });
    } catch (err) {
      this.#onWarning(`could not set osade/human-approved on ${headSha.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  /**
   * §M.7.4 — marks a commit as having no human approval.
   *
   * `pending`, not `failure`: nobody did anything wrong by pushing. The commit simply has not
   * been approved, and the status says exactly that rather than implying a fault.
   */
  async markUnapproved(
    plan: { prOwner: string; prRepo: string },
    headSha: string,
  ): Promise<void> {
    try {
      await this.#scm.write('POST /repos/{owner}/{repo}/statuses/{sha}', {
        owner: plan.prOwner,
        repo: plan.prRepo,
        sha: headSha,
        state: 'pending',
        context: 'osade/human-approved',
        description: 'no human approval for this commit',
      });
    } catch (err) {
      this.#onWarning(`could not set a pending status on ${headSha.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
}

function cwdFor(db: Db, task: { repo_id: string; worktree_path: string | null }): string {
  const repo = db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as
    | { path: string }
    | undefined;
  if (!repo) throw new ScmError(`unknown repo ${task.repo_id}`, 0);
  return taskCwd(task, repo.path);
}
