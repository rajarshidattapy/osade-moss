import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import { taskCwd } from '../domain/cwd.js';
import { git } from '../domain/git.js';
import { Gates, type GateName } from '../domain/gates.js';
import { DIFF_BEARING, type GateClauses } from '../domain/gate-clauses.js';
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
}

export interface CommentPayload {
  body: string;
}

export interface PushPayload {
  remote: string;
  branch: string;
  force: boolean;
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

  constructor(db: Db, scm: ScmClient, gates: Gates, options: ScmWritesOptions = {}) {
    this.#db = db;
    this.#scm = scm;
    this.#gates = gates;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#clauses = options.clauses ?? null;
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
    // §11.2 — re-hashed at execution. An approval is bound to these exact bytes.
    this.#gates.assertExecutable(gateId, payload);

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
    this.#gates.assertExecutable(gateId, payload);

    const plan = await this.planFork(taskId);
    try {
      const pr = await this.#scm.write<{ number: number; html_url: string; head: { sha: string } }>(
        'POST /repos/{owner}/{repo}/pulls',
        {
          owner: plan.prOwner,
          repo: plan.prRepo,
          title: payload.title,
          body: payload.body,
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
}

function cwdFor(db: Db, task: { repo_id: string; worktree_path: string | null }): string {
  const repo = db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as
    | { path: string }
    | undefined;
  if (!repo) throw new ScmError(`unknown repo ${task.repo_id}`, 0);
  return taskCwd(task, repo.path);
}
