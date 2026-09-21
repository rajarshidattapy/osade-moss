import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, join } from 'node:path';

import { orchestratorId, type TaskOriginKind } from '@osade/contract';

import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import {
  SubstrateApiError,
  type SubstrateClient,
  type SubstrateMethodParams,
} from '../substrate/client.js';
import type { SubstrateEventSubscriber } from '../substrate/event-subscriber.js';
import { Conventions } from '../knowledge/conventions.js';
import { renderContextFile, type MigrationBrief } from '../knowledge/context-file.js';
import { osadePaths, worktreePathFor } from '../paths.js';
import { readRepoRules, ensureRepoRules } from '../knowledge/repo-rules.js';
import {
  agentEntry,
  DAEMON_DEFAULT_AGENT,
  DEFAULT_READY_TIMEOUT_MS,
  hasCapability,
  readyTimeoutMs,
  requireAgent,
} from './agent-catalog.js';
import {
  composerReady,
  copyTurns,
  dispatchQueued,
  failOpenTurns,
  failUnreadyTurns,
  readyFailMessage,
  sendTurn as recordTurn,
  settleAgentReply,
} from './chat-turns.js';
import { paneDelta } from './pane-delta.js';
import type { Checkpoints } from './checkpoints.js';
import type { ContextAssembler } from '../retrieval/assembler.js';
import {
  DEFAULT_MIRROR_PATHS,
  currentBranch,
  defaultBranch,
  git,
  githubRemote,
  mirrorPaths,
  parseAlreadyCheckedOut,
  pruneWorktrees,
  resolveCheckoutRef,
  resolveSha,
  stashApply,
  stashDrop,
  stashPush,
  stashRefByMessage,
} from './git.js';
import { isAttached, taskCwd } from './cwd.js';

/**
 * The launch sequence — OSADE.md §8.2.
 *
 * The ordering here is load-bearing and is not the ordering the spec originally had.
 * `agent.start` does not spawn a process: it resolves `kind` to a fixed executable, appends
 * args, and **types the command line into an existing idle shell pane**
 * (`backend/src/app/agents.rs:145-225`). Three consequences:
 *
 *   - the lane must exist and be at a shell prompt before the agent starts;
 *   - **environment cannot be set at `agent.start`** — it is set when the workspace or tab is
 *     created, so `OSADE_TASK_ID` is decided at lane creation;
 *   - a pane hosts at most one agent.
 */

/** A repo-level lock, per §9 rule 2: substrate has no cross-call lock and concurrent creates race. */
const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoPath) ?? Promise.resolve();
  // Chain rather than reject: a queued launch should wait, not fail.
  const next = previous.then(fn, fn);
  repoLocks.set(
    repoPath,
    next.catch(() => {}),
  );
  try {
    return await next;
  } finally {
    if (repoLocks.get(repoPath) === next) repoLocks.delete(repoPath);
  }
}

function execDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const extra = err as Error & { stderr?: unknown; stdout?: unknown };
  const parts = [err.message];
  if (typeof extra.stderr === 'string' && extra.stderr.trim()) parts.push(extra.stderr.trim());
  if (typeof extra.stdout === 'string' && extra.stdout.trim()) parts.push(extra.stdout.trim());
  return parts.join('\n');
}

/** Read-only snapshot so a truncated substrate git dump is not the only record. */
async function describeWorktreeFailure(
  repoPath: string,
  dest: string,
  branch: string,
  base: string,
): Promise<string> {
  const lines = [
    `cwd=${repoPath}`,
    `branch=${branch}`,
    `base=${base}`,
    `path=${dest}`,
    `pathExists=${existsSync(dest)}`,
  ];
  try {
    const listed = (await git(repoPath, ['worktree', 'list'])).trim();
    lines.push(`git worktree list:\n${listed || '(none)'}`);
  } catch (err) {
    lines.push(`git worktree list failed: ${execDetail(err)}`);
  }
  try {
    const refs = (await git(repoPath, ['show-ref', '--heads', '--', branch])).trim();
    lines.push(`git show-ref ${branch}: ${refs || '(no matching heads)'}`);
  } catch {
    lines.push(`git show-ref ${branch}: (none)`);
  }
  return lines.join('\n');
}

/**
 * The single spelling a repository path is stored under.
 *
 * Forward slashes, because that is what git reports and what every path comparison elsewhere
 * in the daemon already normalises to. Upper-case drive letter, because Windows hands out both
 * `c:\` and `C:\` for the same volume depending on who asked.
 */
export function canonicalRepoPath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//.test(slashed) ? slashed[0]!.toUpperCase() + slashed.slice(1) : slashed;
}

function lowerDrive(path: string): string {
  return /^[A-Z]:\//.test(path) ? path[0]!.toLowerCase() + path.slice(1) : path;
}

export interface CreateTaskInput {
  repoPath: string;
  title: string;
  intent: string;
  agentId?: string | undefined;
  chatId?: string | undefined;
  baseRef?: string | undefined;
  /** Isolated only: check out this existing ref instead of cutting `osade/<slug>`. */
  checkoutRef?: string | undefined;
  /** Default false — attached to the checkout. Forced true if the repo already has an attached lane. */
  isolate?: boolean | undefined;
  /** §17 — repo-root planner. Never isolated; reused if it already exists. */
  home?: boolean | undefined;
  /**
   * Where this lane came from. Defaults to `manual`.
   *
   * OSADE-MOSS §M.5.6 sets `api_migration` so the ledger can say a lane is part of a migration.
   * It is a label on an otherwise ordinary lane — F1 adds no orchestration, which is the point.
   */
  originKind?: TaskOriginKind | undefined;
}

export interface CreateTaskResult {
  taskId: string;
  isolated: boolean;
  isolatedBecause?: { taskId: string; chatId: string; title: string };
}

export class AgentLiveError extends Error {
  constructor(taskId: string) {
    super(`stop the agent on ${taskId} before branching out`);
    this.name = 'AgentLiveError';
  }
}

export class LaneIsolatedError extends Error {
  constructor(taskId: string) {
    super(`${taskId} is already on a worktree`);
    this.name = 'LaneIsolatedError';
  }
}

export class BranchHeldError extends Error {
  readonly branch: string;
  readonly path: string;
  readonly holder: { taskId: string; chatId: string; title: string } | null;

  constructor(
    branch: string,
    holder: { taskId: string; chatId: string; title: string } | null,
    path: string,
  ) {
    super(
      holder
        ? `${branch} is already checked out by “${holder.title}”`
        : `${branch} is already checked out at ${path}`,
    );
    this.name = 'BranchHeldError';
    this.branch = branch;
    this.path = path;
    this.holder = holder;
  }
}

export interface LaunchResult {
  workspaceId: string;
  tabId: string;
  paneId: string;
  worktreePath: string | null;
  /** `<cwd>/.osade/CONTEXT.md` or `~/.osade/tasks/<id>/CONTEXT.md` when attached. */
  contextPath: string;
  /** False on platforms where substrate cannot pass args to agent.start. See #agentStartArgs. */
  argsSupported: boolean;
  /** True when the first-run trust prompt fired and was resolved (§8.3). */
  resolvedTrustPrompt: boolean;
}

export interface LaunchTaskOptions {
  now?: () => number;
  defaultAgent?: string;
  onWarning?: (message: string) => void;
  /**
   * §9.1 — turn checkpoints. Optional so a caller that does not want undo history can skip
   * it; when present, launch captures one and a capture failure never fails the launch.
   */
  checkpoints?: Checkpoints;
  /**
   * OSADE-MOSS §M.2 — per-turn context assembly.
   *
   * Optional for the same reason `checkpoints` is: a daemon without it sends prompts exactly as
   * it does today. When present, every prompt is prefixed with a cited, budgeted context block
   * and the pack is recorded. R3 — an assembler that throws is logged and skipped; it can never
   * stop a turn from being sent.
   */
  assembler?: ContextAssembler;
}

/**
 * Timeouts. Note that `agent.start` is NOT a readiness barrier — it can return success with
 * `launch_pending: true` — so AGENT_SETTLE_TIMEOUT_MS is the one that actually matters.
 */
const AGENT_START_TIMEOUT_MS = 60_000;
const AGENT_SETTLE_TIMEOUT_MS = 90_000;

/**
 * §8.3 — Claude and Codex ask "do you trust this folder?" and Osade's cwd is a freshly created
 * worktree every single time, so this fires constantly. Matched narrowly on purpose: any other
 * `blocked` is §6 row 4, and answering that for the user is the one thing this must not do.
 */
const TRUST_PROMPT_MATCHES: readonly string[] = [
  'Is this a project you created',
  'Do you trust the files in this folder',
  'do you trust this folder',
  'Do you trust the contents of this',
];

/** How many times a visible trust prompt is answered before we stop and let a human see it. */
const MAX_TRUST_PROMPT_ANSWERS = 3;

export class LaunchTask {
  readonly #db: Db;
  readonly #substrate: SubstrateClient;
  readonly #subscriber: SubstrateEventSubscriber;
  readonly #now: () => number;
  readonly #defaultAgent: string;
  readonly #onWarning: (message: string) => void;
  readonly #checkpoints: Checkpoints | null;
  readonly #assembler: ContextAssembler | null;
  readonly #readyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #promptAt = new Map<string, string>();

  constructor(
    db: Db,
    substrate: SubstrateClient,
    subscriber: SubstrateEventSubscriber,
    options: LaunchTaskOptions = {},
  ) {
    this.#db = db;
    this.#substrate = substrate;
    this.#subscriber = subscriber;
    this.#now = options.now ?? Date.now;
    this.#defaultAgent = options.defaultAgent ?? DAEMON_DEFAULT_AGENT;
    this.#onWarning = options.onWarning ?? (() => {});
    this.#checkpoints = options.checkpoints ?? null;
    this.#assembler = options.assembler ?? null;
  }

  /** Registers a repo and a task row. No substrate calls — that is `launch`. */
  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    if (input.agentId) requireAgent(input.agentId);

    const repoId = await this.ensureRepo(input.repoPath);
    const repo = this.#db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId) as {
      path: string;
      default_agent: string | null;
    };

    const homeChatId = input.home ? orchestratorId(repoId) : null;
    if (homeChatId) {
      const existing = this.#db
        .prepare(
          `SELECT id FROM task WHERE chat_id = ? AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1`,
        )
        .get(homeChatId) as { id: string } | undefined;
      if (existing) return { taskId: existing.id, isolated: false };
    }

    const holder = this.#db
      .prepare(
        `SELECT id, chat_id, title FROM task
          WHERE repo_id = ? AND worktree_path IS NULL AND archived_at IS NULL
          LIMIT 1`,
      )
      .get(repoId) as { id: string; chat_id: string; title: string } | undefined;

    const wantIsolate = input.isolate === true;
    // ponytail: home stays on the checkout even if another attached chat exists.
    const isolated = homeChatId ? false : wantIsolate || holder != null;
    const isolatedBecause =
      !homeChatId && !wantIsolate && holder != null
        ? { taskId: holder.id, chatId: holder.chat_id, title: holder.title }
        : undefined;

    const sibling = input.chatId
      ? (this.#db
          .prepare(
            `SELECT title, base_ref, base_sha FROM task
              WHERE chat_id = ? ORDER BY created_at ASC LIMIT 1`,
          )
          .get(input.chatId) as { title: string; base_ref: string; base_sha: string } | undefined)
      : undefined;

    const taskId = `t_${randomUUID().slice(0, 8)}`;
    const chatId = homeChatId ?? input.chatId ?? taskId;
    const resolvedAgent = input.agentId ?? repo.default_agent ?? this.#defaultAgent;

    let baseRef: string;
    let baseSha: string;
    let branch: string;
    let worktreePath: string | null;
    let checkoutRef: string | null = null;

    if (isolated) {
      worktreePath = worktreePathFor(basename(repo.path), taskId);
      const existingRef = input.checkoutRef?.trim();
      if (existingRef) {
        const resolved = await resolveCheckoutRef(repo.path, existingRef);
        branch = resolved.local;
        baseRef = resolved.local;
        baseSha = resolved.sha;
        checkoutRef = resolved.local;
      } else {
        const head = await currentBranch(repo.path);
        baseRef = input.baseRef ?? sibling?.base_ref ?? head;
        baseSha =
          sibling && input.baseRef == null ? sibling.base_sha : await resolveSha(repo.path, baseRef);
        branch = `osade/${isolatedSlug(sibling?.title ?? input.title, taskId)}/${resolvedAgent}`;
      }
    } else {
      branch = await currentBranch(repo.path);
      baseRef = branch;
      baseSha = await resolveSha(repo.path, 'HEAD');
      worktreePath = null;
    }

    this.#db
      .prepare(
        `INSERT INTO task (id, repo_id, title, intent, origin_kind, agent_id, chat_id, base_ref,
                           base_sha, branch, worktree_path, checkout_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        repoId,
        input.title,
        input.intent,
        input.originKind ?? 'manual',
        input.agentId ?? null,
        chatId,
        baseRef,
        baseSha,
        branch,
        worktreePath,
        checkoutRef,
        this.#now(),
      );

    if (checkoutRef) adoptOpenPr(this.#db, taskId, repoId, checkoutRef, this.#now());

    return isolatedBecause
      ? { taskId, isolated, isolatedBecause }
      : { taskId, isolated };
  }

  /** The §8.2 sequence. Serialized per repo, because substrate has no cross-call lock. */
  async launch(taskId: string): Promise<LaunchResult> {
    const task = getTask(this.#db, taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);

    const repo = this.#db.prepare('SELECT * FROM repo WHERE id = ?').get(task.repo_id) as {
      id: string;
      path: string;
      default_agent: string | null;
      gh_owner: string | null;
      gh_name: string | null;
    };

    const agentId = task.agent_id ?? repo.default_agent ?? this.#defaultAgent;
    const entry = agentEntry(agentId);
    if (!entry) throw new Error(`no catalog entry for agent ${agentId}`);

    try {
      return await withRepoLock(repo.path, async () => {
      let workspaceId: string;

      if (isAttached(task)) {
        const created = await this.#substrate.request<
          'workspace.create',
          { workspace: { workspace_id: string } }
        >(
          'workspace.create',
          { cwd: repo.path, label: task.title, focus: false },
          60_000,
        );
        workspaceId = created.workspace.workspace_id;
      } else {
        await pruneWorktrees(repo.path);
        this.#onWarning(
          `worktree.create ${taskId} cwd=${repo.path} branch=${task.branch} base=${task.base_sha} path=${task.worktree_path}`,
        );
        try {
          const created = await this.#substrate.request<
            'worktree.create',
            { workspace: { workspace_id: string }; root_pane: { pane_id: string } }
          >(
            'worktree.create',
            {
              cwd: repo.path,
              branch: task.branch,
              base: task.base_sha,
              path: task.worktree_path!,
              label: task.title,
              focus: false,
            },
            60_000,
          );
          workspaceId = created.workspace.workspace_id;
        } catch (err) {
          const held = await this.#heldBranchError(err, repo.id, repo.path, taskId);
          if (held) {
            this.#db.prepare('DELETE FROM task WHERE id = ?').run(taskId);
            throw held;
          }
          const detail = await describeWorktreeFailure(
            repo.path,
            task.worktree_path!,
            task.branch,
            task.base_sha,
          );
          this.#onWarning(
            `worktree.create failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n${detail}`,
          );
          throw new Error('could not create a worktree — see the terminal');
        }
        const mirrored = await mirrorPaths(repo.path, task.worktree_path!, DEFAULT_MIRROR_PATHS);
        if (mirrored.length > 0) {
          this.#onWarning(`mirrored into worktree: ${mirrored.join(', ')}`);
        }
      }

      this.#db
        .prepare('UPDATE task SET substrate_workspace_id = ? WHERE id = ?')
        .run(workspaceId, taskId);

      // 4. The agent lane. This is the ONLY opportunity to set environment (§8.2).
      const tab = await this.#substrate.request<
        'tab.create',
        { tab: { tab_id: string }; root_pane: { pane_id: string } }
      >('tab.create', {
        workspace_id: workspaceId,
        label: 'agent',
        focus: false,
        env: {
          OSADE_TASK_ID: taskId,
          OSADE_REPO_PATH: repo.path,
        },
      });

      const paneId = tab.root_pane.pane_id;
      const tabId = tab.tab.tab_id;

      // Ensure the fact row exists so the subscriber can bind the pane to the task.
      this.#db.prepare('INSERT OR IGNORE INTO agent_fact (task_id) VALUES (?)').run(taskId);

      // 6. Subscribe BEFORE starting, so the launch transition is not missed.
      this.#subscriber.watchPane(taskId, paneId);

      // 5. Render the launch context (§8.2 step 5, §13.5). Always written, because it is the
      //    delivery mechanism whenever system-prompt args are unavailable.
      const contextPath = await this.#writeContext(task, repo);

      // 7. Build args from the catalog. the substrate picks the executable itself (§8.1).
      const args = this.#agentStartArgs(entry, {
        contextPath,
        attached: isAttached(task),
      });

      // `agent.start` is not a reliable readiness signal in either direction, verified against
      // the substrate 0.8.2-p20:
      //   - it can return **success** immediately with `launch_pending: true` and
      //     `agent_status: unknown`, before the agent has rendered anything;
      //   - it can return **`agent_not_ready`** when its own detector saw `blocked` during
      //     startup, which for a fresh worktree is almost always the trust prompt (§8.3).
      // So the call is made, its outcome is recorded rather than trusted, and readiness is
      // established afterwards by `#awaitAgentReady`.
      let startError: SubstrateApiError | null = null;
      try {
        await this.#substrate.request(
          'agent.start',
          {
            name: `osade-${taskId}`,
            kind: entry.id,
            pane_id: paneId,
            args,
            timeout_ms: AGENT_START_TIMEOUT_MS,
          },
          AGENT_START_TIMEOUT_MS + 10_000,
        );
      } catch (err) {
        if (err instanceof SubstrateApiError && err.code === 'agent_not_ready') {
          startError = err;
        } else {
          throw err;
        }
      }

      const ready = await this.#awaitAgentReady(paneId, AGENT_SETTLE_TIMEOUT_MS);
      if (!ready.interactive) {
        throw (
          startError ??
          new Error(
            `pane ${paneId}: ${entry.id} started but never became interactive. ` +
              `Last pane output:\n${ready.lastOutput.slice(-800)}`,
          )
        );
      }
      const resolvedTrustPrompt = ready.resolvedTrustPrompt;
      this.#setComposerReady(taskId, true);
      await this.sendQueued(taskId);

      // 8. Best-effort checkpoint. §9.1 — a capture failure never fails a launch.
      // §8.2 step 8 / §9.1 — best-effort, and `Checkpoints.capture` never throws.
      // Delegated rather than inlined: two implementations of "record a checkpoint" produced
      // two rows for one launch, which the M1 acceptance test caught.
      await this.#checkpoints?.capture(taskId, 'launch');

      return {
        workspaceId,
        tabId,
        paneId,
        worktreePath: task.worktree_path,
        contextPath,
        argsSupported: agentStartArgsSupported(),
        resolvedTrustPrompt,
      };
    });
    } catch (err) {
      failOpenTurns(
        this.#db,
        taskId,
        err instanceof Error ? err.message : String(err),
        this.#now(),
      );
      throw err;
    }
  }

  /**
   * Move an attached lane onto its own worktree. Refuses if already isolated or a pane is live.
   */
  async branchOut(
    taskId: string,
    options: { branch?: string; carryChanges: boolean },
  ): Promise<{ worktreePath: string; branch: string; stashKept?: string }> {
    const task = getTask(this.#db, taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (!isAttached(task)) throw new LaneIsolatedError(taskId);

    const fact = this.#db
      .prepare('SELECT pane_alive, terminated FROM agent_fact WHERE task_id = ?')
      .get(taskId) as { pane_alive: number; terminated: number } | undefined;
    if (fact?.pane_alive === 1 && fact.terminated !== 1) throw new AgentLiveError(taskId);

    const repo = this.#db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as {
      path: string;
    };
    const cwd = taskCwd(task, repo.path);
    const head = await resolveSha(cwd, 'HEAD');
    const current = await currentBranch(cwd);
    const agentId = task.agent_id ?? this.#defaultAgent;
    const branch =
      options.branch?.trim() || `osade/${isolatedSlug(task.title, taskId)}/${agentId}`;
    const stashName = `osade-branch-out-${taskId}`;
    let stashRef: string | null = null;

    if (options.carryChanges) {
      const dirty = (await git(cwd, ['status', '--porcelain', '--untracked-files=all'])).trim().length > 0;
      if (dirty) {
        await stashPush(cwd, stashName);
        stashRef = await stashRefByMessage(cwd, stashName);
      }
    }

    try {
      if (task.substrate_workspace_id) await this.teardown(taskId, { force: true });

      const worktreePath = worktreePathFor(basename(repo.path), taskId);
      this.#db
        .prepare(
          `UPDATE task SET worktree_path = ?, branch = ?, base_ref = ?, base_sha = ?,
                           substrate_workspace_id = NULL WHERE id = ?`,
        )
        .run(worktreePath, branch, current, head, taskId);

      await this.launch(taskId);

      if (stashRef) {
        try {
          await stashApply(worktreePath, stashRef);
          await stashDrop(cwd, stashRef);
          stashRef = null;
        } catch (err) {
          throw new Error(
            `could not apply uncommitted work onto ${branch}. The stash is kept as ${stashRef}: ${(err as Error).message}`,
          );
        }
      }

      return { worktreePath, branch };
    } catch (err) {
      if (stashRef) {
        throw new Error(
          `${(err as Error).message} Uncommitted work is in git stash ${stashRef} (${stashName}).`,
        );
      }
      throw err;
    }
  }

  /**
   * Isolated worktrees are disposable: close this lane and open a new one on `checkoutRef`,
   * keeping the chat and transcript.
   */
  async moveToBranch(taskId: string, checkoutRef: string): Promise<CreateTaskResult> {
    const task = getTask(this.#db, taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (isAttached(task)) {
      throw new Error('move the attached checkout with Switch branch, or branch out first');
    }
    const repo = this.#db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as
      | { path: string }
      | undefined;
    if (!repo) throw new Error(`unknown repo ${task.repo_id}`);

    await this.teardown(taskId, { force: true });
    this.#db.prepare('UPDATE task SET archived_at = ? WHERE id = ?').run(this.#now(), taskId);

    const created = await this.createTask({
      repoPath: repo.path,
      title: task.title,
      intent: task.intent,
      agentId: task.agent_id ?? undefined,
      chatId: task.chat_id,
      isolate: true,
      checkoutRef,
    });
    copyTurns(this.#db, taskId, created.taskId);
    return created;
  }

  /**
   * **Windows limitation, verified against the substrate 0.8.2-p20.** With no args, the substrate submits
   * `& claude` and the agent starts. With args it submits
   * `Start-Process -FilePath claude -ArgumentList '...' -NoNewWindow -Wait -PassThru`, and
   * PowerShell's `Start-Process` cannot execute an extensionless npm shim — the pane shows
   * `%1 is not a valid Win32 application` and no agent ever appears. Since most agent CLIs on
   * Windows are npm shims, passing args there is a silent launch failure.
   *
   * So on Windows the agent starts bare and the launch context is delivered through
   * the context file (§13.5 already provides for agents with no system-prompt
   * flag). Mode args such as `--permission-mode` are lost, which is a real capability
   * reduction and is reported rather than hidden.
   */
  #agentStartArgs(
    entry: ReturnType<typeof agentEntry> & object,
    opts: { contextPath: string; attached: boolean },
  ): string[] {
    if (!agentStartArgsSupported()) {
      this.#onWarning(
        `agent.start args are unsupported on this platform; starting ${entry.id} bare and ` +
          `delivering context through ${opts.attached ? opts.contextPath : '.osade/CONTEXT.md'} (mode args are not applied)`,
      );
      return [];
    }
    const args = [...entry.autonomousArgs];
    if (entry.systemPromptFlag && hasCapability(entry, 'system-prompt-injection')) {
      args.push(entry.systemPromptFlag, opts.attached ? opts.contextPath : `@.osade/CONTEXT.md`);
    }
    return args;
  }

  /**
   * The opening prompt — §13.5.
   *
   * When system-prompt args could not be passed, the context file is referenced here instead,
   * which is exactly what §13.5 prescribes for agents without system-prompt injection.
   */
  openingPrompt(
    intent: string,
    argsSupported: boolean,
    opts?: { contextPath: string; attached: boolean },
  ): string {
    if (argsSupported) return intent;
    const where = opts?.attached ? opts.contextPath : '.osade/CONTEXT.md in this worktree';
    return `First read ${where}, then: ${intent}`;
  }

  /**
   * Waits until the substrate reports the pane's agent as interactive, answering the first-run trust
   * prompt if it appears while we wait.
   *
   * This exists because `agent.start` is not a readiness signal (see the call site). The two
   * outcomes are interleaved rather than sequenced: the prompt may already be on screen when
   * the call returns, or may appear a second later, so both are handled in one loop with a
   * single deadline.
   *
   * A bounded launch handshake, not a status feed: once per launch, hard deadline, never
   * drives the UI. Live status comes from the pane subscription (§7.2), already open by now.
   */
  async #awaitAgentReady(
    paneId: string,
    timeoutMs: number,
  ): Promise<{ interactive: boolean; resolvedTrustPrompt: boolean; lastOutput: string }> {
    const deadline = this.#now() + timeoutMs;
    let resolvedTrustPrompt = false;
    let answerAttempts = 0;
    let lastOutput = '';

    while (this.#now() < deadline) {
      lastOutput = await this.#readPane(paneId);

      // §8.3 — matched narrowly on purpose. Any other blocked state is §6 row 4, and
      // answering that on the user's behalf is the one thing this must not do. The live
      // selector must be on screen too: the prompt text alone can be stale scrollback from a
      // prompt that was already answered.
      //
      // Check *before* treating interactive_ready as done: Codex reports interactive while
      // the trust dialog is still up, and sending into it is the @codex delivery bug.
      if (
        answerAttempts < MAX_TRUST_PROMPT_ANSWERS &&
        TRUST_PROMPT_MATCHES.some((m) => lastOutput.includes(m)) &&
        trustSelection(lastOutput) != null
      ) {
        answerAttempts++;
        if (await this.#answerTrustPrompt(paneId)) resolvedTrustPrompt = true;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        continue;
      }

      try {
        const info = await this.#substrate.request<
          'agent.get',
          {
            agent: {
              interactive_ready?: boolean;
              launch_pending?: boolean;
              agent_status?: string;
            };
          }
        >('agent.get', { target: paneId }, 5_000);
        const status = info.agent.agent_status;
        if (info.agent.launch_pending === true) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (status === 'blocked' || status === 'working') {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        // `done` is a settled composer. interactive_ready is false on some agents until they
        // flip to idle, and waiting for that is how a follow-up sat "held" with no reply.
        if (
          info.agent.interactive_ready === true ||
          status === 'idle' ||
          status === 'done'
        ) {
          return { interactive: true, resolvedTrustPrompt, lastOutput };
        }
      } catch {
        // Not yet a named agent — the substrate is still detecting. Keep waiting.
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return { interactive: false, resolvedTrustPrompt, lastOutput };
  }

  /**
   * Answers the trust prompt by **confirming the selection moved before committing it**.
   *
   * Sending `Down` then `Enter` blind is wrong, and the failure is bad: keystrokes sent while
   * the TUI is still painting are dropped, so a dropped `Down` leaves "❯ No, exit" selected and
   * `Enter` then *exits Claude*. That looked like an intermittent 90-second launch timeout and
   * was actually Osade declining the folder on the user's behalf.
   *
   * So each `Down` is verified against a re-read of the pane, and `Enter` is only sent once the
   * trust option is actually selected. Returns false if it never gets there — the human should
   * see that, not have it guessed at.
   */
  async #answerTrustPrompt(paneId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const selection = trustSelection(await this.#readPane(paneId));
      if (selection == null) return false;

      if (selection === 'trust') {
        await this.#substrate.request('pane.send_keys', { pane_id: paneId, keys: ['Enter'] });
        return true;
      }

      await this.#substrate.request('pane.send_keys', { pane_id: paneId, keys: ['Down'] });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    this.#onWarning(
      `pane ${paneId}: could not move the trust prompt selection onto the trust option; ` +
        `leaving it for a human rather than guessing`,
    );
    return false;
  }

  async #readPane(paneId: string): Promise<string> {
    try {
      const result = await this.#substrate.request<'pane.read', { read: { text: string } }>(
        'pane.read',
        { pane_id: paneId, source: 'visible', lines: 60, format: 'text', strip_ansi: true },
        5_000,
      );
      return result.read.text;
    } catch {
      return '';
    }
  }

  /**
   * Tears a task's the substrate workspace down — §9 rule 6.
   *
   * Order matters and is not obvious: **every pane must be closed before the worktree is
   * removed.** A live shell holds its cwd open, and on Windows that makes the directory
   * undeletable — `worktree.remove` fails with `Permission denied` even with `force: true`.
   * the substrate's own rule ("no live pane in the task's workspace") is therefore a hard prerequisite
   * rather than a courtesy.
   *
   * `force` still means what §9 rule 6 says: it overrides *uncommitted changes*, not live
   * panes, and belongs behind a typed confirmation in the UI.
   */
  async teardown(taskId: string, options: { force?: boolean } = {}): Promise<void> {
    const task = getTask(this.#db, taskId);
    if (!task?.substrate_workspace_id) return;

    const paneId = this.#paneFor(taskId);
    if (paneId) this.#subscriber.unwatchPane(paneId);

    const panes = await this.#substrate
      .request<'pane.list', { panes: { pane_id: string }[] }>('pane.list', {
        workspace_id: task.substrate_workspace_id,
      })
      .catch(() => ({ panes: [] as { pane_id: string }[] }));

    // Close every pane but one. `worktree.remove` is addressed by workspace id, and the substrate
    // closes a workspace when its last pane goes — so closing them all leaves nothing to
    // address and the call fails with `workspace_not_found`. One pane has to survive the
    // removal.
    const [survivor, ...doomed] = panes.panes;
    for (const pane of doomed) {
      await this.#substrate.request('pane.close', { pane_id: pane.pane_id }).catch(() => {});
    }

    // …and that survivor must not be sitting in the directory about to be deleted. A shell
    // holds its working directory open, which on Windows makes the checkout undeletable and
    // surfaces as `Permission denied` from `worktree.remove` even with force. `cd ~` is valid
    // in both POSIX shells and PowerShell.
    if (survivor && task.worktree_path) {
      await this.#substrate
        .request('pane.send_input', { pane_id: survivor.pane_id, text: 'cd ~\r' })
        .catch(() => {});
      await this.#waitForCwdOutside(survivor.pane_id, task.worktree_path, 10_000);
    }

    if (task.worktree_path) {
      await this.#removeWorktree(task.substrate_workspace_id, task.worktree_path, options.force ?? false);
    } else if (task.substrate_workspace_id) {
      await this.#substrate
        .request('workspace.close', { workspace_id: task.substrate_workspace_id })
        .catch(() => {});
    }

    this.#db.prepare('UPDATE task SET substrate_workspace_id = NULL WHERE id = ?').run(taskId);
    this.#db
      .prepare(
        'UPDATE agent_fact SET pane_alive = 0, substrate_pane_id = NULL, composer_ready = 0 WHERE task_id = ?',
      )
      .run(taskId);
  }

  /** Polls the pane's reported cwd until it is no longer inside the checkout. */
  async #waitForCwdOutside(paneId: string, worktreePath: string, timeoutMs: number): Promise<void> {
    const target = worktreePath.replace(/\\/g, '/').toLowerCase();
    const deadline = this.#now() + timeoutMs;

    while (this.#now() < deadline) {
      const info = await this.#substrate
        .request<'pane.get', { pane: { cwd?: string | null } }>(
          'pane.get',
          { pane_id: paneId },
          5_000,
        )
        .catch(() => null);

      const cwd = info?.pane.cwd?.replace(/\\/g, '/').toLowerCase() ?? '';
      if (cwd === '' || !cwd.startsWith(target)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.#onWarning(`pane ${paneId} is still inside ${worktreePath}; removal may fail`);
  }

  /**
   * Removes the checkout, retrying while the OS still holds it.
   *
   * On Windows a handle released by an exiting process is not immediately reflected, so
   * `Permission denied` here is usually transient rather than a real refusal. Retried a few
   * times with backoff; a genuine refusal — a dirty checkout without `force` — is a different
   * error and is rethrown at once.
   *
   * **`worktree.remove` is not atomic.** the substrate closes the workspace first and deletes the
   * directory second, so a transient `Permission denied` leaves the workspace already gone. A
   * naive retry then fails with `workspace_not_found` and reports *that* instead of the real
   * problem. So after the first attempt the absence of the workspace is evidence, not an
   * error: if the directory is gone the removal finished, and if it is still there the removal
   * half-succeeded and says so plainly.
   */
  async #removeWorktree(
    workspaceId: string,
    worktreePath: string,
    force: boolean,
  ): Promise<void> {
    const attempts = 5;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.#substrate.request('worktree.remove', { workspace_id: workspaceId, force });
        return;
      } catch (err) {
        const message = err instanceof SubstrateApiError ? err.message : String(err);

        if (attempt > 1 && /workspace_not_found/i.test(message)) {
          // the substrate's registration is gone; only the directory is left. Its own removal already
          // ran, so finishing the job is no longer worktree *lifecycle* — it is deleting a
          // leftover directory, which §1's carve-out covers.
          await this.#reapLeftoverCheckout(worktreePath);
          return;
        }

        const transient = /permission denied|being used by another/i.test(message);
        if (!transient || attempt === attempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }

  /**
   * Deletes a checkout the substrate has already deregistered.
   *
   * A just-exited PTY can hold its working directory for a moment on Windows, so the directory
   * outlives the workspace. Waited on rather than slept through, then removed, then pruned so
   * git's registration does not outlive the directory either (§9 rule 3 in reverse).
   */
  async #reapLeftoverCheckout(worktreePath: string): Promise<void> {
    const deadline = this.#now() + 10_000;
    while (this.#now() < deadline) {
      if (!existsSync(worktreePath)) return;
      try {
        await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        if (!existsSync(worktreePath)) return;
      } catch {
        // Still held. Wait and try again until the deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    this.#onWarning(
      `the substrate removed the workspace for ${worktreePath} but the directory is still on disk; ` +
        `something outside Osade is holding it open. Run \`git worktree prune\` after it frees.`,
    );
  }

  /**
   * Typed chat send — AO's contract: a message, not a keystroke. Queued while a turn is in flight.
   */
  async sendTurn(
    taskId: string,
    text: string,
    options: { wait?: boolean; origin?: 'human' | 'automation' } = {},
  ): Promise<void> {
    const agentId = this.#agentIdFor(taskId);
    const turn = await recordTurn(this.#db, (id, body, wait, turnId) => this.prompt(id, body, wait, turnId), {
      taskId,
      text,
      origin: options.origin ?? 'human',
      now: this.#now(),
      wait: options.wait,
      agentId,
      readyTimeoutMs: readyTimeoutMs(agentId),
    });
    if (turn.delivery === 'queued' && !composerReady(this.#db, taskId)) this.#armReadyTimeout(taskId);
    else this.#disarmReadyTimeout(taskId);
  }

  /** Dispatch the next held message after the live turn settles. */
  async sendQueued(taskId: string): Promise<void> {
    const agentId = this.#agentIdFor(taskId);
    await dispatchQueued(
      this.#db,
      (id, body, wait, turnId) => this.prompt(id, body, wait, turnId),
      taskId,
      false,
      this.#now(),
      { agentId, readyTimeoutMs: readyTimeoutMs(agentId) },
    );
    this.#disarmReadyTimeoutIfClear(taskId);
  }

  /** Persist whatever the agent said when the pane went quiet. */
  async settle(taskId: string): Promise<void> {
    const task = getTask(this.#db, taskId);
    const entry = agentEntry(task?.agent_id ?? this.#agentIdFor(taskId));
    if (entry && hasCapability(entry, 'reports-final-message')) {
      settleAgentReply(this.#db, taskId, this.#now());
      return;
    }
    const before = this.#promptAt.get(taskId) ?? this.#promptSurface(taskId);
    const after = await this.readTranscript(taskId, 80);
    const lastUser = this.#db
      .prepare(
        `SELECT text FROM chat_turn
           WHERE task_id = ? AND role = 'user' AND delivery = 'accepted'
           ORDER BY seq DESC LIMIT 1`,
      )
      .get(taskId) as { text: string } | undefined;
    settleAgentReply(this.#db, taskId, this.#now(), {
      body: paneDelta(
        before,
        after?.text ?? '',
        lastUser?.text ?? '',
        entry?.transcriptTrim ?? [],
      ),
    });
  }

  /**
   * Sends a prompt into the task's agent lane.
   *
   * `wait` is retried once on `agent_prompt_stalled`: the substrate requires an observed state change
   * within 5s of a submission from a non-working state, and an agent that has just gone idle
   * can miss that window without anything being wrong. A second submission is safe because the
   * first one was rejected before any input was sent.
   */
  async prompt(taskId: string, text: string, wait: boolean, turnId?: string): Promise<void> {
    const paneId = this.#paneFor(taskId);
    if (!paneId) throw new Error(`task ${taskId} has no live agent pane`);

    const body = await this.#withContext(taskId, text, turnId);
    const agentId = this.#agentIdFor(taskId);
    const ready = await this.#awaitAgentReady(paneId, readyTimeoutMs(agentId));
    if (!ready.interactive) {
      throw new Error(readyFailMessage(agentId));
    }
    this.#setComposerReady(taskId, true);

    const before = await this.readTranscript(taskId, 80);
    const surface = before?.text ?? '';
    this.#promptAt.set(taskId, surface);
    this.#db
      .prepare('UPDATE agent_fact SET prompt_surface = ? WHERE task_id = ?')
      .run(surface, taskId);

    // §4.2 — prefer one blocking call over prompt-then-poll: each connection is a substrate thread.
    const params: SubstrateMethodParams['agent.prompt'] = wait
      ? {
          target: paneId,
          text: body,
          // Any settled state ends the wait; §6.1 decides what each one means, not this call.
          wait: { until: ['idle', 'done', 'blocked'], timeout_ms: 300_000 },
        }
      : { target: paneId, text: body };
    const timeout = wait ? 310_000 : 30_000;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.#substrate.request('agent.prompt', params, timeout);
        return;
      } catch (err) {
        const stalled = err instanceof SubstrateApiError && err.code === 'agent_prompt_stalled';
        if (!stalled || attempt === 2) throw err;
        this.#onWarning(`prompt to ${taskId} stalled on submission; retrying once`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /**
   * OSADE-MOSS §M.2 — prefixes the turn with its assembled context block.
   *
   * The block is prepended to what the agent receives and is **never written to
   * `chat_turn.text`**, so the durable transcript stays exactly what the human and the agent
   * said. That is a deliberate divergence from how `<osade_lanes>` works: the lane digest is
   * built in the renderer and travels inside the stored turn, which is why `renderer/chat.ts`
   * has to strip it back out on display. Retrieval runs in the daemon, so it does not need that
   * round trip, and not storing it means there is nothing to strip and nothing to get wrong.
   *
   * INVARIANT R3: this never fails a turn. An assembler that throws costs the agent its context
   * for one turn, and the turn still goes out.
   */
  async #withContext(taskId: string, text: string, turnId?: string): Promise<string> {
    if (!this.#assembler) return text;
    try {
      const assembled = await this.#assembler.build(taskId, text, turnId);
      if (!assembled?.block) return text;
      return [assembled.block, '', text].join('\n');
    } catch (err) {
      this.#onWarning(
        `context assembly for ${taskId} failed, sending the turn without it: ${(err as Error).message}`,
      );
      return text;
    }
  }

  /** §4.4.1 — the only screen content the pinned schema exposes. On demand, at most 1 Hz. */
  async readTranscript(
    taskId: string,
    lines: number,
  ): Promise<{ text: string; revision: number; truncated: boolean } | null> {
    const paneId = this.#paneFor(taskId);
    if (!paneId) return null;
    // `pane_read` wraps its payload: { type: 'pane_read', read: PaneReadResult }.
    const result = await this.#substrate.request<
      'pane.read',
      { read: { text: string; revision: number; truncated: boolean } }
    >('pane.read', {
      pane_id: paneId,
      source: 'recent_unwrapped',
      lines,
      format: 'text',
      strip_ansi: true,
    });
    return {
      text: result.read.text,
      revision: result.read.revision,
      truncated: result.read.truncated,
    };
  }

  /**
   * §8.2.1 — relaunch after a substrate restart.
   *
   * the substrate restores panes but not agent processes, so a restored pane is back at a shell prompt
   * and `agent_pane_busy` will not fire. Never sets `terminated`: the task is queued.
   */
  async relaunchAfterRestart(taskId: string): Promise<void> {
    const task = getTask(this.#db, taskId);
    if (!task) return;
    const fact = this.#db
      .prepare('SELECT substrate_pane_id, agent_session_id FROM agent_fact WHERE task_id = ?')
      .get(taskId) as { substrate_pane_id: string | null; agent_session_id: string | null } | undefined;
    if (!fact?.substrate_pane_id) return;

    const repo = this.#db.prepare('SELECT default_agent FROM repo WHERE id = ?').get(task.repo_id) as
      | { default_agent: string | null }
      | undefined;
    const entry = agentEntry(task.agent_id ?? repo?.default_agent ?? this.#defaultAgent);
    if (!entry) return;

    const args = [...entry.autonomousArgs];
    if (fact.agent_session_id && hasCapability(entry, 'resume')) args.push(...entry.resumeArgs);

    this.#subscriber.watchPane(taskId, fact.substrate_pane_id);
    await this.#substrate.request(
      'agent.start',
      {
        name: `osade-${taskId}`,
        kind: entry.id,
        pane_id: fact.substrate_pane_id,
        args,
        timeout_ms: AGENT_START_TIMEOUT_MS,
      },
      AGENT_START_TIMEOUT_MS + 10_000,
    );
  }

  #paneFor(taskId: string): string | null {
    const row = this.#db
      .prepare('SELECT substrate_pane_id FROM agent_fact WHERE task_id = ?')
      .get(taskId) as { substrate_pane_id: string | null } | undefined;
    return row?.substrate_pane_id ?? null;
  }

  /**
   * §8.2 step 5 / §13.5 — render the launch context into the worktree.
   *
   * The active conventions for this repo go in here, capped at 40 rules and ~2000 tokens by
   * `renderContextFile`. A repo that has never been mined simply has no rules section: mining is
   * a separate, explicit action (§13.4), and launching must never block on it.
   */
  /**
   * OSADE-MOSS §M.5.6 — the migration sections, for a lane that belongs to one.
   *
   * Read from the tables rather than passed in, so `LaunchTask` keeps knowing nothing about F1
   * beyond "a task may have a migration row". Returns undefined for every ordinary lane, which
   * is all of them outside a migration.
   */
  #migrationBrief(taskId: string): { migration: MigrationBrief } | undefined {
    const target = this.#db
      .prepare(
        `SELECT mt.migration_id, mt.repo_id, m.package, m.to_version
           FROM migration_target mt JOIN migration m ON m.id = mt.migration_id
          WHERE mt.task_id = ?`,
      )
      .get(taskId) as
      | { migration_id: string; repo_id: string; package: string; to_version: string }
      | undefined;
    if (!target) return undefined;

    const changes = this.#db
      .prepare(
        `SELECT kind, description, evidence, old_symbol, new_symbol
           FROM migration_change WHERE migration_id = ? ORDER BY rowid`,
      )
      .all(target.migration_id) as {
      kind: string;
      description: string;
      evidence: string;
      old_symbol: string | null;
      new_symbol: string | null;
    }[];

    // Capped: a 400-site list is a context dump, and the agent has the full list a query away.
    const sites = this.#db
      .prepare(
        `SELECT file, line, via, score FROM call_site
          WHERE migration_id = ? AND repo_id = ?
          ORDER BY COALESCE(score, 0) DESC, file, line LIMIT 60`,
      )
      .all(target.migration_id, target.repo_id) as {
      file: string;
      line: number;
      via: string;
      score: number | null;
    }[];

    return {
      migration: {
        packageName: target.package,
        toVersion: target.to_version,
        changes: changes.map((c) => ({
          kind: c.kind,
          description: c.description,
          evidence: c.evidence,
          oldSymbol: c.old_symbol,
          newSymbol: c.new_symbol,
        })),
        sites,
      },
    };
  }

  async #writeContext(
    task: { id: string; worktree_path: string | null; intent: string; base_ref: string; base_sha: string },
    repo: { id: string; path: string; gh_owner: string | null; gh_name: string | null },
  ): Promise<string> {
    const dir = task.worktree_path
      ? join(task.worktree_path, '.osade')
      : join(osadePaths().root, 'tasks', task.id);
    const path = join(dir, 'CONTEXT.md');

    const { injected, overflow } = new Conventions(this.#db).forInjection(repo.id);
    const rulesText = readRepoRules(repo.path);
    const usePasted = rulesText.trim().length > 0;
    const rendered = renderContextFile({
      repoSlug:
        repo.gh_owner && repo.gh_name ? `${repo.gh_owner}/${repo.gh_name}` : basename(repo.path),
      intent: task.intent,
      baseRef: task.base_ref,
      baseSha: task.base_sha,
      conventions: usePasted ? [] : injected,
      rulesText: usePasted ? rulesText : undefined,
      verifySteps: this.#verifyStepsFor(repo.id),
      overflow: usePasted ? 0 : overflow,
      ...(this.#migrationBrief(task.id) ?? {}),
    });

    if (rendered.omitted > 0) {
      this.#onWarning(
        `${rendered.omitted} active convention(s) did not fit the context budget and were not injected`,
      );
    }

    // §13.6 — instrument it from day one. Which side of the comparison this task falls on is
    // only knowable now: by the time its PR merges, the repo's conventions will have changed.
    this.#db
      .prepare(
        `INSERT INTO task_injection (task_id, rule_count, omitted, injected_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           rule_count = excluded.rule_count,
           omitted = excluded.omitted,
           injected_at = excluded.injected_at`,
      )
      .run(task.id, rendered.included, rendered.omitted, this.#now());

    await mkdir(dir, { recursive: true });
    await writeFile(path, rendered.body, 'utf8');
    return path;
  }

  /**
   * The verification the agent will actually be held to.
   *
   * Only a **confirmed** plan is named here. §10.1 is explicit that an inferred command is never
   * run silently the first time, and telling an agent to satisfy commands that will not run is
   * the same mistake wearing a different hat — it spends the agent's attention on a guess.
   */
  #verifyStepsFor(repoId: string): { name: string; cmd: string }[] {
    const row = this.#db
      .prepare('SELECT steps_json, needs_review FROM verify_plan WHERE repo_id = ?')
      .get(repoId) as { steps_json: string; needs_review: number } | undefined;
    if (!row || row.needs_review !== 0) return [];

    try {
      const steps = JSON.parse(row.steps_json) as { name: string; cmd: string }[];
      return steps.map((s) => ({ name: s.name, cmd: s.cmd }));
    } catch {
      return [];
    }
  }

  /**
   * Registers a repo, once, under concurrency.
   *
   * A check-then-insert is a race here: `defaultBranch` is async, so four concurrent
   * `createTask` calls all observe no row, all try to insert, and three die on
   * `UNIQUE constraint failed: repo.path`. That is not hypothetical — it is what four parallel
   * tasks on one repo do, and it is what `test/integration/parallel-tasks.test.ts` caught.
   *
   * The async work happens first, then a single atomic upsert: sqlite serializes statements, so
   * `ON CONFLICT DO NOTHING` followed by a read is race-free without a lock of our own.
   */
  async ensureRepo(rawPath: string): Promise<string> {
    // One repository, one row. On Windows the same checkout arrives in two spellings — git's
    // `rev-parse --show-toplevel` answers `C:/Users/...` while Node's `path.resolve` answers
    // `C:\Users\...` — and `repo.path`'s UNIQUE constraint compares strings, so both used to
    // insert. Everything keyed by repo (migration targets, code chunks, policies, conventions)
    // then split silently across two ids for the same checkout.
    const repoPath = canonicalRepoPath(rawPath);
    ensureRepoRules(repoPath);
    // Matched against the canonical form of *stored* paths too, so a row written before this
    // normalisation existed is found rather than duplicated.
    const existing = this.#db
      .prepare(
        `SELECT id FROM repo
          WHERE path = ? OR REPLACE(path, char(92), '/') = ? OR REPLACE(path, char(92), '/') = ?`,
      )
      .get(repoPath, repoPath, lowerDrive(repoPath)) as { id: string } | undefined;
    if (existing) return existing.id;

    const branch = await defaultBranch(repoPath);
    // §11 — read the GitHub identity from the remote rather than asking the user for something
    // git already knows. Null for a local-only repo, which is a valid task target that simply
    // cannot open pull requests.
    const remote = await githubRemote(repoPath);

    this.#db
      .prepare(
        `INSERT INTO repo (id, path, default_branch, gh_owner, gh_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO NOTHING`,
      )
      .run(
        `r_${randomUUID().slice(0, 8)}`,
        repoPath,
        branch,
        remote?.owner ?? null,
        remote?.name ?? null,
        this.#now(),
      );

    const row = this.#db.prepare('SELECT id FROM repo WHERE path = ?').get(repoPath) as {
      id: string;
    };
    return row.id;
  }

  #armReadyTimeout(taskId: string): void {
    this.#disarmReadyTimeout(taskId);
    const agentId = getTask(this.#db, taskId)?.agent_id ?? 'agent';
    const ms = agentEntry(agentId)?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.#readyTimers.delete(taskId);
      failUnreadyTurns(this.#db, taskId, agentId, 'idle composer', this.#now());
    }, ms);
    this.#readyTimers.set(taskId, timer);
  }

  #disarmReadyTimeout(taskId: string): void {
    const timer = this.#readyTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.#readyTimers.delete(taskId);
  }

  #disarmReadyTimeoutIfClear(taskId: string): void {
    const queued = this.#db
      .prepare(
        `SELECT 1 FROM chat_turn WHERE task_id = ? AND role = 'user' AND delivery = 'queued' LIMIT 1`,
      )
      .get(taskId);
    if (!queued) this.#disarmReadyTimeout(taskId);
  }

  #setComposerReady(taskId: string, ready: boolean): void {
    this.#db
      .prepare('UPDATE agent_fact SET composer_ready = ? WHERE task_id = ?')
      .run(ready ? 1 : 0, taskId);
  }

  #agentIdFor(taskId: string): string {
    return getTask(this.#db, taskId)?.agent_id ?? this.#defaultAgent;
  }

  #promptSurface(taskId: string): string {
    const row = this.#db
      .prepare('SELECT prompt_surface FROM agent_fact WHERE task_id = ?')
      .get(taskId) as { prompt_surface: string | null } | undefined;
    return row?.prompt_surface ?? '';
  }

  async #heldBranchError(
    err: unknown,
    repoId: string,
    repoPath: string,
    skipTaskId: string,
  ): Promise<BranchHeldError | null> {
    const text = err instanceof Error ? `${err.message}\n${execDetail(err)}` : String(err);
    const parsed = parseAlreadyCheckedOut(text);
    if (!parsed) return null;
    const holder = holderAtPath(this.#db, repoId, repoPath, parsed.path, skipTaskId);
    return new BranchHeldError(parsed.branch, holder, parsed.path);
  }
}

function isolatedSlug(title: string, taskId: string): string {
  if (!title || title === 'New chat') return taskId.replace(/^t_/, '');
  const slug = slugify(title);
  return slug === 'new-chat' || slug === 'task' ? taskId.replace(/^t_/, '') : slug;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function holderAtPath(
  db: Db,
  repoId: string,
  repoPath: string,
  checkoutPath: string,
  skipTaskId?: string,
): { taskId: string; chatId: string; title: string } | null {
  const target = normPath(checkoutPath);
  const rows = db
    .prepare(
      `SELECT id, chat_id, title, worktree_path FROM task
        WHERE repo_id = ? AND archived_at IS NULL`,
    )
    .all(repoId) as { id: string; chat_id: string; title: string; worktree_path: string | null }[];
  for (const row of rows) {
    if (skipTaskId && row.id === skipTaskId) continue;
    const cwd = row.worktree_path ?? repoPath;
    if (normPath(cwd) === target) {
      return { taskId: row.id, chatId: row.chat_id, title: row.title };
    }
  }
  return null;
}

function adoptOpenPr(db: Db, taskId: string, repoId: string, branch: string, now: number): void {
  const sibling = db
    .prepare(
      `SELECT s.pr_number, s.pr_url, s.pr_state, s.pr_head_sha, s.pr_head_ref, s.pr_draft
         FROM scm_fact s
         JOIN task t ON t.id = s.task_id
        WHERE t.repo_id = ? AND t.id != ?
          AND s.pr_number IS NOT NULL AND (s.pr_state IS NULL OR s.pr_state = 'open')
          AND (t.branch = ? OR t.checkout_ref = ? OR s.pr_head_ref = ?)
        ORDER BY t.archived_at IS NULL DESC
        LIMIT 1`,
    )
    .get(repoId, taskId, branch, branch, branch) as
    | {
        pr_number: number;
        pr_url: string | null;
        pr_state: string | null;
        pr_head_sha: string | null;
        pr_head_ref: string | null;
        pr_draft: number | null;
      }
    | undefined;
  if (!sibling) return;
  db.prepare(
    `INSERT INTO scm_fact (task_id, pr_number, pr_url, pr_state, pr_head_sha, pr_head_ref, pr_draft,
                           unresolved_threads, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    taskId,
    sibling.pr_number,
    sibling.pr_url,
    sibling.pr_state ?? 'open',
    sibling.pr_head_sha,
    sibling.pr_head_ref ?? branch,
    sibling.pr_draft,
    now,
  );
}

/**
 * Whether `agent.start` can carry args on this platform.
 *
 * See `LaunchTask.#agentStartArgs` for the Windows failure this guards, verified against
 * the substrate 0.8.2-p20.
 */
export function agentStartArgsSupported(): boolean {
  return platform() !== 'win32';
}

/**
 * Which option the trust prompt currently has selected, or null when no live selector is on
 * screen.
 *
 * Claude Code marks the selection with `❯`. Reading it — rather than assuming the default and
 * navigating blind — is what makes answering the prompt safe: the alternative failure mode is
 * pressing Enter on "No, exit".
 */
export function trustSelection(paneText: string): 'trust' | 'decline' | null {
  let sawOption = false;
  let selected: 'trust' | 'decline' | null = null;

  for (const line of paneText.split('\n')) {
    const isTrust = /yes,\s*i trust/i.test(line) || /yes,\s*continue/i.test(line);
    const isDecline = /\bno,\s*exit\b/i.test(line) || /\bno,\s*quit\b/i.test(line);
    if (!isTrust && !isDecline) continue;

    sawOption = true;
    if (line.includes('❯') || line.includes('›') || /(^|\s)>\s+\d+\./.test(line) || line.trimStart().startsWith('>')) {
      selected = isTrust ? 'trust' : 'decline';
    }
  }

  // Options with no selector means the prompt is scrollback, not a live question.
  return sawOption ? selected : null;
}
