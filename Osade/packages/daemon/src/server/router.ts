import { basename } from 'node:path';

import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  ContextItem,
  ContextPack,
  AttestationCheck,
  AuditRow,
  CatchUpItem,
  CatchUpResult,
  ConventionImpact,
  ConventionView,
  Member,
  Role,
  TriageRow,
  SessionGrant,
  ShareInfo,
  DiscoveryMiss,
  GateClauseView,
  MigrationChangeKind,
  MigrationMetrics,
  MigrationSummary,
  MigrationView,
  PolicyReloadResult,
  MineStatus,
  Namespace,
  RetrievalStats,
  TaskId,
  TaskStatus,
  TaskView,
} from '@osade/contract';

import type { Db } from '../db/index.js';
import { getTask, getTaskFacts, listTaskFacts } from '../db/task-repo.js';
import {
  AGENT_CATALOG,
  agentDisplayName,
  binaryOnPath,
  requireAgent,
  UnknownAgentError,
} from '../domain/agent-catalog.js';
import type { Gates } from '../domain/gates.js';
import { AgentLiveError, BranchHeldError, LaneIsolatedError, type LaunchTask } from '../domain/launch-task.js';
import { TaskShells } from '../domain/task-shell.js';
import { NoHeadlessAgentError, type HeadlessRuns } from '../domain/headless-run.js';
import {
  agentPrCopy,
  agentSlug,
  agentTitle,
  stepsFromAgentText,
  tailFile,
} from '../domain/headless-copy.js';
import {
  repoRoot,
  checkoutBranch,
  currentBranch,
  listLocalBranches,
  listWorktreeCheckouts,
  repoWorkingStatus,
} from '../domain/git.js';
import { toTaskView } from '../domain/task-view.js';
import { saveChatPhotos } from '../domain/chat-photos.js';
import { deriveVerifyPlan, type VerifyStep } from '../domain/verify-plan.js';
import { isAttached, taskCwd } from '../domain/cwd.js';
import {
  fileChanges,
  listDir,
  listWorkingChanges,
  readChangeDiff,
  readFile as readTaskFile,
  writeFile as writeTaskFile,
} from '../domain/files.js';
import type { Triage, TriageKind } from '../domain/triage.js';
import type { VerifyRunner } from '../domain/verify-run.js';
import type { Knowledge } from '../knowledge/service.js';
import { readRepoRules, repoRulesPath, writeRepoRules } from '../knowledge/repo-rules.js';
import { MigrationNotConfirmedError, type MigrationService } from '../domain/migration.js';
import type { GateClauses } from '../domain/gate-clauses.js';
import type { Attestations } from '../attest/service.js';
import type { CatchUp } from './catch-up.js';
import { parseAttestorFile } from '../attest/keys.js';
import { auditExport } from '../domain/audit.js';
import type { PrSignals } from '../scm/signals.js';
import { atLeast, type Members, type Session } from './members.js';
import { requiredRole } from './roles.js';
import { reloadPolicies } from '../knowledge/policies.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { ScmPoller } from '../scm/poller.js';
import type { CommentPayload, OpenPrPayload, ScmWrites } from '../scm/writes.js';

/**
 * The tRPC router — OSADE.md §5.5.
 *
 * Every procedure declares `.output()` with a contract schema, so the renderer's types are
 * derived rather than hand-written and nothing crosses the boundary untyped.
 */

export interface DaemonContext {
  db: Db;
  launcher: LaunchTask;
  gates: Gates;
  verifier: VerifyRunner;
  triage: Triage;
  scmWrites: ScmWrites;
  poller: ScmPoller;
  shells: TaskShells;
  headless?: HeadlessRuns | null;
  /** §13 — absent when no model is configured. Mining is optional; everything else is not. */
  knowledge?: Knowledge | null;
  /** §M.1 — absent only in a test harness. A running daemon always has one, on some backend. */
  retrieval?: RetrievalService | null;
  /** §M.5 — F1. Present whenever retrieval is; discovery is meaningless without it. */
  migrations?: MigrationService | null;
  /** §M.8 — F4. Absent only in a test harness that does not exercise gate clauses. */
  clauses?: GateClauses | null;
  /** §M.7 — F3's attestations and their verification. */
  attest?: Attestations | null;
  /** §M.6 — F2. Absent on a loopback-only daemon with no members configured. */
  members?: Members | null;
  catchUp?: CatchUp | null;
  /** The caller's session, resolved from the bearer token by the listener. */
  session?: Session | null;
  /** The raw token, so `authLogout` can revoke the one that was used. */
  sessionToken?: string | null;
  /** §M.6.1 — the join code, when this daemon is shareable. */
  share?: (() => ShareInfo) | null;
  /** §M.7.5 — F3's maintainer-facing triage signals. */
  signals?: PrSignals | null;
  now: () => number;
}

/** §M.9.2 `server.sessionTtlHours`, as milliseconds. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function requireMembers(ctx: DaemonContext): Members {
  if (!ctx.members) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no member registry configured',
    });
  }
  return ctx.members;
}

function requireSignals(ctx: DaemonContext): PrSignals {
  if (!ctx.signals) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no PR signal service configured',
    });
  }
  return ctx.signals;
}

function requireCatchUp(ctx: DaemonContext): CatchUp {
  if (!ctx.catchUp) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no catch-up service configured',
    });
  }
  return ctx.catchUp;
}

const t = initTRPC.context<DaemonContext>().create();

/**
 * §M.6.2, §M.6.6 — the role gate, in exactly one place.
 *
 * **Denies by omission.** A procedure with no entry in `ROLE_MATRIX` is refused, not allowed:
 * the failure mode of an allow-by-default matrix is that someone adds a procedure, forgets the
 * entry, and a viewer can now do it. `role-matrix.test.ts` turns that into a build failure, and
 * this turns it into a refusal at runtime if the test is ever skipped.
 *
 * **Loopback with no members is the single-user case** and needs no session: the person at the
 * keyboard owns the machine. The moment a member registry exists — which only happens when
 * someone has been invited — every call needs a session and a role.
 */
const enforceRole = t.middleware(({ ctx, path, next }) => {
  const required = requiredRole(path);
  if (required === undefined) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${path} declares no role (OSADE-MOSS §M.6.2). Add it to ROLE_MATRIX.`,
    });
  }
  if (required === null) return next();

  // Single-user, loopback, nobody invited: the caller is the owner by construction.
  if (!ctx.members || ctx.members.list().length === 0) return next();

  const session = ctx.session;
  if (!session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'this session is not authenticated' });
  }
  if (!atLeast(session.role, required)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${path} needs the ${required} role; ${session.login} is a ${session.role}`,
    });
  }
  return next();
});

/** Every procedure goes through the role gate. There is no unguarded builder. */
const procedure = t.procedure.use(enforceRole);

function viewFor(ctx: DaemonContext, taskId: string): TaskView | null {
  return toTaskView(ctx.db, taskId, ctx.now());
}

function unknownAgent(err: unknown): never {
  if (err instanceof UnknownAgentError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  throw err;
}

function locateTaskCwd(ctx: DaemonContext, taskId: string): { cwd: string; baseSha: string } {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
  const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as
    | { path: string }
    | undefined;
  if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
  return { cwd: taskCwd(task, repo.path), baseSha: task.base_sha };
}

/**
 * §19.3 — the ledger sorts needs-you first, then live, then everything else. Never by creation
 * time by default: with eight agents running, "who needs me?" is the only question.
 */
const SORT_RANK: Record<TaskStatus, number> = {
  awaiting_approval: 0,
  needs_input: 1,
  review_changes_requested: 2,
  awaiting_review: 3,
  implementing: 4,
  verifying: 5,
  verify_failed: 6,
  blocked_external: 7,
  ci_failed: 8,
  pr_open: 9,
  queued: 10,
  idle: 11,
  stopped: 12,
  merged: 13,
  archived: 14,
};

export const appRouter = t.router({
  health: procedure
    .output(z.object({ ok: z.literal(true), tasks: z.number().int() }))
    .query(({ ctx }) => ({
      ok: true as const,
      tasks: listTaskFacts(ctx.db).length,
    })),

  taskList: procedure.output(z.array(TaskView)).query(({ ctx }) => {
    const views = listTaskFacts(ctx.db)
      .map((f) => viewFor(ctx, f.task.id))
      .filter((v): v is TaskView => v != null);

    return views.sort((a, b) => {
      const rank = SORT_RANK[a.status] - SORT_RANK[b.status];
      if (rank !== 0) return rank;
      return b.task.created_at - a.task.created_at;
    });
  }),

  taskGet: procedure
    .input(z.object({ taskId: TaskId }))
    .output(TaskView.nullable())
    .query(({ ctx, input }) => viewFor(ctx, input.taskId)),

  taskCreate: procedure
    .input(
      z.object({
        repoPath: z.string().min(1),
        title: z.string().min(1),
        intent: z.string().min(1),
        agentId: z.string().optional(),
        chatId: z.string().optional(),
        baseRef: z.string().optional(),
        checkoutRef: z.string().optional(),
        isolate: z.boolean().optional(),
        home: z.boolean().optional(),
      }),
    )
    .output(
      z.object({
        taskId: TaskId,
        isolated: z.boolean(),
        isolatedBecause: z
          .object({ taskId: z.string(), chatId: z.string(), title: z.string() })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        if (input.agentId) requireAgent(input.agentId);
        return await ctx.launcher.createTask(input);
      } catch (err) {
        unknownAgent(err);
      }
    }),

  orchestratorOpen: procedure
    .input(z.object({ repoPath: z.string().min(1), agentId: z.string().optional() }))
    .output(z.object({ taskId: TaskId, chatId: z.string(), isolated: z.literal(false) }))
    .mutation(async ({ ctx, input }) => {
      try {
        if (input.agentId) requireAgent(input.agentId);
        const created = await ctx.launcher.createTask({
          repoPath: input.repoPath,
          title: 'Plan',
          intent: 'Plan work across this repository and delegate focused tasks.',
          agentId: input.agentId,
          home: true,
        });
        const row = getTask(ctx.db, created.taskId);
        if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'plan chat missing' });
        return { taskId: created.taskId, chatId: row.chat_id, isolated: false as const };
      } catch (err) {
        unknownAgent(err);
      }
    }),

  /** Runs the §8.2 launch sequence. Long-running: worktree, lane, agent start. */
  taskLaunch: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ taskId: TaskId, paneId: z.string(), workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await ctx.launcher.launch(input.taskId);
        return { taskId: input.taskId, paneId: result.paneId, workspaceId: result.workspaceId };
      } catch (err) {
        if (err instanceof BranchHeldError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
        }
        throw err;
      }
    }),

  /** Sends a prompt into the task's agent lane. */
  taskSend: procedure
    .input(z.object({ taskId: TaskId, text: z.string().min(1), wait: z.boolean().optional() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launcher.sendTurn(input.taskId, input.text, {
        wait: input.wait ?? false,
        origin: 'human',
      });
      const task = getTask(ctx.db, input.taskId);
      if (task && task.title === 'New chat' && ctx.headless) {
        void agentTitle(ctx.headless, task.repo_id, input.text).then((title) => {
          if (title) ctx.db.prepare('UPDATE task SET title = ? WHERE id = ?').run(title, input.taskId);
        });
      }
      return { ok: true as const };
    }),

  /** Writes pasted photos under ~/.osade/inbox/<task>/ so the agent can open them. */
  taskDropImages: procedure
    .input(
      z.object({
        taskId: TaskId,
        files: z
          .array(
            z.object({
              name: z.string().min(1),
              mime: z.string().min(1),
              data: z.string().min(1),
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .output(z.object({ paths: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      if (!getTask(ctx.db, input.taskId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
      }
      try {
        return saveChatPhotos(input.taskId, input.files);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Reads the agent pane transcript — §4.4.1. On demand, never a render loop. */
  taskTranscript: procedure
    .input(z.object({ taskId: TaskId, lines: z.number().int().min(1).max(1000).optional() }))
    .output(z.object({ text: z.string(), revision: z.number(), truncated: z.boolean() }))
    .query(async ({ ctx, input }) => {
      const result = await ctx.launcher.readTranscript(input.taskId, input.lines ?? 200);
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'task has no live pane' });
      return result;
    }),

  /** A cmd/PowerShell (or $SHELL) PTY in this lane's cwd. Not the agent pane. */
  taskShellOpen: procedure
    .input(
      z.object({
        taskId: TaskId,
        cols: z.number().int().min(2).max(500).optional(),
        rows: z.number().int().min(2).max(200).optional(),
      }),
    )
    .output(z.object({ cwd: z.string() }))
    .mutation(({ ctx, input }) => {
      const located = locateTaskCwd(ctx, input.taskId);
      const size =
        input.cols != null && input.rows != null ? { cols: input.cols, rows: input.rows } : undefined;
      return { cwd: ctx.shells.open(input.taskId, located.cwd, size) };
    }),

  taskShellRead: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ text: z.string() }))
    .query(({ ctx, input }) => ({ text: ctx.shells.read(input.taskId) })),

  taskShellWrite: procedure
    .input(z.object({ taskId: TaskId, data: z.string().min(1) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      try {
        ctx.shells.write(input.taskId, input.data);
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (err as Error).message });
      }
      return { ok: true as const };
    }),

  taskShellResize: procedure
    .input(
      z.object({
        taskId: TaskId,
        cols: z.number().int().min(2).max(500),
        rows: z.number().int().min(2).max(200),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      ctx.shells.resize(input.taskId, { cols: input.cols, rows: input.rows });
      return { ok: true as const };
    }),

  taskShellClose: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      ctx.shells.close(input.taskId);
      return { ok: true as const };
    }),

  taskFsList: procedure
    .input(z.object({ taskId: TaskId, dirs: z.array(z.string()).optional() }))
    .output(
      z.object({
        cwd: z.string(),
        listings: z.array(
          z.object({
            dir: z.string(),
            entries: z.array(
              z.object({
                name: z.string(),
                path: z.string(),
                kind: z.enum(['dir', 'file']),
                flag: z.enum(['M', 'A', 'D', '?']).nullable(),
                insertions: z.number().int(),
                deletions: z.number().int(),
              }),
            ),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const located = locateTaskCwd(ctx, input.taskId);
      try {
        const changes = await fileChanges(located.cwd, located.baseSha);
        const dirs = input.dirs ?? [''];
        return {
          cwd: located.cwd,
          listings: dirs.map((dir) => ({ dir, entries: listDir(located.cwd, dir, changes) })),
        };
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  taskFsRead: procedure
    .input(z.object({ taskId: TaskId, path: z.string().min(1) }))
    .output(
      z.object({
        path: z.string(),
        text: z.string().nullable(),
        binary: z.boolean(),
        truncated: z.boolean(),
      }),
    )
    .query(({ ctx, input }) => {
      const located = locateTaskCwd(ctx, input.taskId);
      try {
        return readTaskFile(located.cwd, input.path);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  taskFsWrite: procedure
    .input(z.object({ taskId: TaskId, path: z.string().min(1), text: z.string() }))
    .output(z.object({ path: z.string(), bytes: z.number().int() }))
    .mutation(({ ctx, input }) => {
      const located = locateTaskCwd(ctx, input.taskId);
      try {
        return writeTaskFile(located.cwd, input.path, input.text);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  taskChangesList: procedure
    .input(z.object({ taskId: TaskId }))
    .output(
      z.object({
        files: z.array(
          z.object({
            path: z.string(),
            flag: z.enum(['M', 'A', 'D', '?']),
            insertions: z.number().int(),
            deletions: z.number().int(),
          }),
        ),
        outgoing: z
          .object({
            ahead: z.number().int(),
            commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
            files: z.array(
              z.object({
                path: z.string(),
                flag: z.enum(['M', 'A', 'D', '?']),
                insertions: z.number().int(),
                deletions: z.number().int(),
              }),
            ),
          })
          .nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const located = locateTaskCwd(ctx, input.taskId);
      try {
        return await listWorkingChanges(located.cwd, located.baseSha);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  taskChangesDiff: procedure
    .input(
      z.object({
        taskId: TaskId,
        path: z.string().min(1),
        vs: z.enum(['working', 'outgoing']),
      }),
    )
    .output(
      z.object({
        path: z.string(),
        flag: z.enum(['M', 'A', 'D', '?']).nullable(),
        diff: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const located = locateTaskCwd(ctx, input.taskId);
      try {
        return await readChangeDiff(located.cwd, input.path, input.vs, located.baseSha);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  taskArchive: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      ctx.shells.close(input.taskId);
      ctx.db.prepare('UPDATE task SET archived_at = ? WHERE id = ?').run(ctx.now(), input.taskId);
      return { ok: true as const };
    }),

  taskRetitle: procedure
    .input(z.object({ taskId: TaskId, title: z.string().min(1) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const result = ctx.db
        .prepare('UPDATE task SET title = ? WHERE id = ?')
        .run(input.title, input.taskId);
      if (result.changes === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
      return { ok: true as const };
    }),

  taskBranchOut: procedure
    .input(
      z.object({
        taskId: TaskId,
        branch: z.string().min(1).optional(),
        carryChanges: z.boolean(),
      }),
    )
    .output(z.object({ worktreePath: z.string(), branch: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        let branch = input.branch;
        if (!branch && ctx.headless) {
          const task = getTask(ctx.db, input.taskId);
          if (task) {
            const fallback = task.id.replace(/^t_/, '');
            branch = await agentSlug(ctx.headless, task.repo_id, task.title, fallback);
          }
        }
        return await ctx.launcher.branchOut(input.taskId, {
          branch,
          carryChanges: input.carryChanges,
        });
      } catch (err) {
        if (err instanceof AgentLiveError || err instanceof LaneIsolatedError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
        }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  taskSwitchBranch: procedure
    .input(z.object({ taskId: TaskId, branch: z.string().min(1) }))
    .output(z.object({ gateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = getTask(ctx.db, input.taskId);
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
      if (!isAttached(task)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'only an attached lane can switch the checkout',
        });
      }
      const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as
        | { path: string }
        | undefined;
      if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
      const status = await repoWorkingStatus(repo.path);
      const gateId = ctx.gates.request({
        taskId: input.taskId,
        gate: 'gate.branch_switch',
        payload: { branch: input.branch, repoId: task.repo_id, dirty: status.dirty },
      });
      return { gateId };
    }),

  repoStatus: procedure
    .input(z.object({ repoId: z.string().min(1) }))
    .output(
      z.object({
        branch: z.string(),
        dirty: z.boolean(),
        ahead: z.number().nullable(),
        behind: z.number().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(input.repoId) as
        | { path: string }
        | undefined;
      if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
      return repoWorkingStatus(repo.path);
    }),

  repoBranchList: procedure
    .input(z.object({ repoId: z.string().min(1) }))
    .output(z.array(z.string()))
    .query(async ({ ctx, input }) => {
      const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(input.repoId) as
        | { path: string }
        | undefined;
      if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
      return listLocalBranches(repo.path);
    }),

  repoBranchHolders: procedure
    .input(z.object({ repoId: z.string().min(1) }))
    .output(
      z.array(
        z.object({
          branch: z.string(),
          path: z.string(),
          holder: z
            .object({ taskId: z.string(), chatId: z.string(), title: z.string() })
            .nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(input.repoId) as
        | { path: string }
        | undefined;
      if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
      const checkouts = await listWorktreeCheckouts(repo.path);
      const tasks = ctx.db
        .prepare(
          `SELECT id, chat_id, title, worktree_path FROM task
            WHERE repo_id = ? AND archived_at IS NULL`,
        )
        .all(input.repoId) as {
        id: string;
        chat_id: string;
        title: string;
        worktree_path: string | null;
      }[];
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return checkouts
        .filter((row) => row.branch != null)
        .map((row) => {
          const target = norm(row.path);
          const match = tasks.find((t) => norm(t.worktree_path ?? repo.path) === target);
          return {
            branch: row.branch!,
            path: row.path,
            holder: match
              ? { taskId: match.id, chatId: match.chat_id, title: match.title }
              : null,
          };
        });
    }),

  taskMoveBranch: procedure
    .input(z.object({ taskId: TaskId, checkoutRef: z.string().min(1) }))
    .output(
      z.object({
        taskId: TaskId,
        isolated: z.boolean(),
        isolatedBecause: z
          .object({ taskId: z.string(), chatId: z.string(), title: z.string() })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.launcher.moveToBranch(input.taskId, input.checkoutRef);
      } catch (err) {
        if (err instanceof BranchHeldError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
        }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * Open a repository — what `osade .` calls.
   *
   * Idempotent, and resolves the *root* rather than taking the path literally: `osade .` is typed
   * from wherever you happen to be standing, which is usually a subdirectory. Registering here
   * rather than waiting for a first task is what lets the window open on a repo with nothing in
   * it yet and still know whose repo it is.
   */
  repoOpen: procedure
    .input(z.object({ path: z.string().min(1) }))
    .output(
      z.object({
        repoId: z.string(),
        path: z.string(),
        name: z.string(),
        /** `owner/name` when there is a GitHub remote; null for a local-only repo. */
        slug: z.string().nullable(),
        defaultBranch: z.string(),
        currentBranch: z.string(),
        defaultAgent: z.string().nullable(),
        taskCount: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const root = await repoRoot(input.path);
      if (!root) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `${input.path} is not inside a git repository.`,
        });
      }

      const repoId = await ctx.launcher.ensureRepo(root);
      const repo = ctx.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId) as {
        path: string;
        default_branch: string;
        default_agent: string | null;
        gh_owner: string | null;
        gh_name: string | null;
      };
      const counted = ctx.db
        .prepare('SELECT COUNT(*) AS n FROM task WHERE repo_id = ? AND archived_at IS NULL')
        .get(repoId) as { n: number };

      return {
        repoId,
        path: repo.path,
        name: basename(repo.path) || repo.path,
        slug: repo.gh_owner && repo.gh_name ? `${repo.gh_owner}/${repo.gh_name}` : null,
        defaultBranch: repo.default_branch,
        currentBranch: await currentBranch(repo.path),
        defaultAgent: repo.default_agent,
        taskCount: counted.n,
      };
    }),

  repoRulesGet: procedure
    .input(z.object({ repoId: z.string().min(1) }))
    .output(z.object({ text: z.string(), path: z.string() }))
    .query(({ ctx, input }) => {
      const path = requireRepoPath(ctx, input.repoId);
      return { text: readRepoRules(path), path: repoRulesPath(path) };
    }),

  repoRulesSave: procedure
    .input(z.object({ repoId: z.string().min(1), text: z.string() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      writeRepoRules(requireRepoPath(ctx, input.repoId), input.text);
      return { ok: true as const };
    }),

  repoSetDefaultAgent: procedure
    .input(z.object({ repoId: z.string().min(1), agentId: z.string().min(1) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      try {
        requireAgent(input.agentId);
      } catch (err) {
        unknownAgent(err);
      }
      const result = ctx.db
        .prepare('UPDATE repo SET default_agent = ? WHERE id = ?')
        .run(input.agentId, input.repoId);
      if (result.changes === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
      }
      return { ok: true as const };
    }),

  agentCatalogList: procedure
    .output(
      z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          installed: z.boolean(),
        }),
      ),
    )
    .query(() =>
      AGENT_CATALOG.map((entry) => ({
        id: entry.id,
        displayName: agentDisplayName(entry.id),
        installed: binaryOnPath(entry.binary),
      })),
    ),

  // ── verification (§10) ───────────────────────────────────────────────────

  /** Derives a plan and stores it. §10.1 — shown to the user before first use. */
  verifyPlanDerive: procedure
    .input(z.object({ taskId: TaskId }))
    .output(
      z.object({
        steps: z.array(
          z.object({
            name: z.string(),
            cmd: z.string(),
            cwd: z.string(),
            timeoutSec: z.number(),
            required: z.boolean(),
            source: z.enum(['ci', 'manifest', 'doc', 'user', 'agent']),
            evidence: z.string(),
          }),
        ),
        needsReview: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const task = getTask(ctx.db, input.taskId);
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
      const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as {
        path: string;
      };

      const plan = await deriveVerifyPlan(repo.path);
      if (plan.steps.length === 0 && ctx.headless) {
        try {
          const { text } = await ctx.headless.run({
            repoId: task.repo_id,
            prompt:
              'This repository has no CI, package.json scripts, or docs Osade could parse into checks. Reply with JSON {"steps":[{"name":"...","cmd":"...","cwd":".","timeoutSec":600}]} of guessed local verification commands. No markdown.',
            timeoutSec: 60,
          });
          const guessed = stepsFromAgentText(text);
          if (guessed.length > 0) {
            plan.steps = guessed;
            plan.needsReview = true;
          }
        } catch {
          // leave empty; the UI still offers Add
        }
      }
      ctx.db
        .prepare(
          `INSERT INTO verify_plan (repo_id, steps_json, needs_review, derived_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET steps_json = excluded.steps_json,
                                              needs_review = excluded.needs_review,
                                              derived_at = excluded.derived_at`,
        )
        .run(task.repo_id, JSON.stringify(plan.steps), plan.needsReview ? 1 : 0, ctx.now());
      return plan;
    }),

  /** §10.1 — the user confirms (or edits) the plan. Only then may it run. */
  verifyPlanConfirm: procedure
    .input(z.object({ taskId: TaskId, steps: z.array(z.unknown()).optional() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const task = getTask(ctx.db, input.taskId);
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
      if (input.steps) {
        ctx.db
          .prepare('UPDATE verify_plan SET steps_json = ? WHERE repo_id = ?')
          .run(JSON.stringify(input.steps), task.repo_id);
      }
      ctx.db
        .prepare('UPDATE verify_plan SET needs_review = 0, confirmed_at = ? WHERE repo_id = ?')
        .run(ctx.now(), task.repo_id);
      return { ok: true as const };
    }),

  /**
   * The plan this repo already has, if any — §10.1.
   *
   * Read-only, and the reason it exists: without it the renderer cannot tell a repo with a
   * confirmed plan from one with none, so it offered "Derive a verification plan" either way and
   * deriving resets `needs_review` to 1 — silently discarding the confirmation §10.1 exists to
   * collect. Found by looking at the panel for the first time.
   */
  verifyPlanGet: procedure
    .input(z.object({ taskId: TaskId }))
    .output(
      z
        .object({
          steps: z.array(
            z.object({
              name: z.string(),
              cmd: z.string(),
              cwd: z.string(),
              timeoutSec: z.number(),
              required: z.boolean(),
              source: z.enum(['ci', 'manifest', 'doc', 'user', 'agent']),
              evidence: z.string(),
            }),
          ),
          needsReview: z.boolean(),
        })
        .nullable(),
    )
    .query(({ ctx, input }) => {
      const task = getTask(ctx.db, input.taskId);
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });

      const stored = ctx.db
        .prepare('SELECT steps_json, needs_review FROM verify_plan WHERE repo_id = ?')
        .get(task.repo_id) as { steps_json: string; needs_review: number } | undefined;
      if (!stored) return null;

      return {
        steps: JSON.parse(stored.steps_json) as VerifyStep[],
        needsReview: stored.needs_review === 1,
      };
    }),

  verifyRun: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ passed: z.boolean(), headSha: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = getTask(ctx.db, input.taskId);
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });

      const stored = ctx.db
        .prepare('SELECT steps_json, needs_review FROM verify_plan WHERE repo_id = ?')
        .get(task.repo_id) as { steps_json: string; needs_review: number } | undefined;
      if (!stored) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no verification plan yet' });
      }

      const plan = {
        steps: JSON.parse(stored.steps_json) as VerifyStep[],
        needsReview: stored.needs_review === 1,
      };
      const facts = getTaskFacts(ctx.db, input.taskId)!;
      const head = facts.scm?.pr_head_sha ?? task.base_sha;

      const report = await ctx.verifier.run(input.taskId, plan, head);
      return { passed: report.passed, headSha: report.headSha };
    }),

  verifyRunLog: procedure
    .input(z.object({ runId: z.string().min(1) }))
    .output(z.object({ text: z.string() }))
    .query(({ ctx, input }) => {
      const row = ctx.db.prepare('SELECT log_path FROM verify_run WHERE id = ?').get(input.runId) as
        | { log_path: string }
        | undefined;
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown verify run' });
      return { text: tailFile(row.log_path, 40) };
    }),

  runHeadless: procedure
    .input(
      z.object({
        repoId: z.string().min(1),
        agentId: z.string().optional(),
        prompt: z.string().min(1),
        timeoutSec: z.number().int().min(5).max(600).optional(),
      }),
    )
    .output(z.object({ text: z.string(), agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.headless) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'no installed agent can run headless',
        });
      }
      try {
        return await ctx.headless.run(input);
      } catch (err) {
        if (err instanceof NoHeadlessAgentError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),

  // ── gates (§14) ──────────────────────────────────────────────────────────

  gateDecide: procedure
    .input(z.object({ gateId: z.string(), decision: z.enum(['approve', 'deny']) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      try {
        ctx.gates.decide(input.gateId, input.decision);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      if (input.decision === 'approve') {
        await executeApprovedGate(ctx, input.gateId);
      }
      return { ok: true as const };
    }),

  /** §14.2 — editing rewrites the payload and re-hashes, so the edit is what is bound. */
  gateEditAndApprove: procedure
    .input(z.object({ gateId: z.string(), payload: z.unknown() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      try {
        ctx.gates.editAndApprove(input.gateId, input.payload);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
      await executeApprovedGate(ctx, input.gateId);
      return { ok: true as const };
    }),

  // ── GitHub (§11) and triage (§12) ────────────────────────────────────────

  /** §11.1 — the issue list for a watched repo. Candidates, not tasks. */
  issueList: procedure
    .input(z.object({ repoId: z.string() }))
    .output(
      z.array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          body: z.string(),
          url: z.string(),
        }),
      ),
    )
    .query(({ ctx, input }) => ctx.poller.pollIssues(input.repoId)),

  /**
   * §12 — import an issue as a task.
   *
   * `triage` makes it a task that terminates in an artifact rather than a PR. That path is the
   * wedge, so it is a first-class option here rather than a mode discovered later.
   */
  issueImport: procedure
    .input(
      z.object({
        repoPath: z.string().min(1),
        issue: z.object({
          number: z.number().int(),
          title: z.string(),
          body: z.string(),
          url: z.string(),
        }),
        triage: z
          .enum(['reproduce', 'bisect', 'failing-test', 'duplicate-check', 'verify-pr-claim'])
          .optional(),
      }),
    )
    .output(z.object({ taskId: TaskId }))
    .mutation(async ({ ctx, input }) => {
      const taskId = await ctx.triage.importIssue(input.repoPath, input.issue, {
        triage: input.triage as TriageKind | undefined,
      });
      return { taskId };
    }),

  /** Forces a PR refresh without waiting out the 30s interval. */
  scmRefresh: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ refreshed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const facts = getTaskFacts(ctx.db, input.taskId);
      const prNumber = facts?.scm?.pr_number;
      if (prNumber == null) return { refreshed: false };
      return { refreshed: await ctx.poller.refreshPr(input.taskId, prNumber) };
    }),

  /**
   * §11.3 — what would happen if this task opened a PR.
   *
   * Shown *before* asking for approval: §11.3 says check permissions before offering the
   * action, not after.
   */
  prPlan: procedure
    .input(z.object({ taskId: TaskId }))
    .output(
      z.object({
        viaFork: z.boolean(),
        head: z.string(),
        target: z.string(),
        base: z.string(),
        title: z.string(),
        body: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const plan = await ctx.scmWrites.planFork(input.taskId);
        const task = getTask(ctx.db, input.taskId);
        const fallbackTitle = task?.title ?? 'Update';
        const copy = ctx.headless
          ? await agentPrCopy(ctx.headless, task?.repo_id ?? '', fallbackTitle)
          : { title: fallbackTitle, body: '' };
        return {
          viaFork: plan.viaFork,
          head: plan.head,
          target: `${plan.prOwner}/${plan.prRepo}`,
          base: plan.prBase,
          title: copy.title,
          body: copy.body,
        };
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (err as Error).message });
      }
    }),

  /** §11.2 — requests a gate for opening a PR. Nothing is written until it is approved. */
  prOpenRequest: procedure
    .input(
      z.object({
        taskId: TaskId,
        title: z.string().min(1),
        body: z.string(),
        draft: z.boolean().optional(),
      }),
    )
    .output(z.object({ gateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const plan = await ctx.scmWrites.planFork(input.taskId);
      // A1 — the approval is for this commit. `assertExecutableNow` re-reads the branch before
      // the PR opens and aborts if it moved.
      const headSha = await ctx.scmWrites.headSha(input.taskId);
      if (!headSha) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'this lane has no commit to open a pull request for',
        });
      }
      const payload = {
        title: input.title,
        body: input.body,
        head: plan.head,
        base: plan.prBase,
        draft: input.draft ?? false,
        head_sha: headSha,
      };
      return { gateId: await ctx.scmWrites.requestGate(input.taskId, 'gate.pr_open', payload) };
    }),

  /**
   * §11.2 / §12 — requests a gate for posting a comment on the originating issue.
   * Nothing is written until it is approved.
   */
  issueCommentRequest: procedure
    .input(z.object({ taskId: TaskId, body: z.string().min(1) }))
    .output(z.object({ gateId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = getTask(ctx.db, input.taskId);
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
      if (issueNumberFromRef(task.origin_ref) == null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'this task has no originating issue to comment on',
        });
      }
      const disclosure = '_Produced by an agent through Osade, and reviewed by a human before posting._';
      const body = input.body.includes(disclosure) ? input.body : `${input.body.trim()}\n\n---\n${disclosure}`;
      return { gateId: await ctx.scmWrites.requestGate(input.taskId, 'gate.issue_comment', { body }) };
    }),

  // ── §13 repository conventions ─────────────────────────────────────────────

  /** What is known about this repo, and whether more can be learned right now. */
  mineStatus: procedure
    .input(z.object({ repoId: z.string() }))
    .output(MineStatus)
    .query(({ ctx, input }) => {
      const knowledge = requireKnowledge(ctx);
      const availability = knowledge.availability(input.repoId);
      const rules = knowledge.list(input.repoId);
      return {
        available: availability.available,
        reason: availability.reason,
        running: knowledge.isRunning(input.repoId),
        lastRun: knowledge.lastRun(input.repoId),
        activeRules: rules.filter((r) => r.lifecycle === 'active').length,
        candidateRules: rules.filter((r) => r.lifecycle === 'candidate').length,
        dueForRemine: knowledge.dueForRemine(input.repoId),
      };
    }),

  /**
   * §13.4 — mining is always explicit. It spends GitHub quota and model tokens, so nothing
   * starts it on its own and no task launch waits on it.
   *
   * Returns as soon as the run is *started*, not when it finishes: a first mine of a large
   * repository is minutes of model calls, and holding an HTTP request open for that is the wrong
   * shape — a client that times out would learn nothing about a run still spending money. Poll
   * `mineStatus` for progress.
   */
  mineRepo: procedure
    .input(z.object({ repoId: z.string(), full: z.boolean().optional() }))
    .output(z.object({ runId: z.string() }))
    .mutation(({ ctx, input }) => {
      try {
        return requireKnowledge(ctx).startMine(input.repoId, { full: input.full });
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (err as Error).message });
      }
    }),

  /** §13.6 — the measurable claim. Reports what it measured, including bad news. */
  conventionImpact: procedure
    .input(z.object({ repoId: z.string() }))
    .output(ConventionImpact)
    .query(async ({ ctx, input }) => {
      try {
        return await requireKnowledge(ctx).measure(input.repoId);
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (err as Error).message });
      }
    }),

  conventionList: procedure
    .input(z.object({ repoId: z.string() }))
    .output(z.array(ConventionView))
    .query(({ ctx, input }) => requireKnowledge(ctx).list(input.repoId)),

  /** §13.4 — one-click confirmation. The renderer shows the evidence beside the toggle. */
  conventionConfirm: procedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ confirmed: z.boolean() }))
    .mutation(({ ctx, input }) => ({
      confirmed: requireKnowledge(ctx).confirm(input.id),
    })),

  conventionReject: procedure
    .input(z.object({ id: z.string(), reason: z.string().min(1) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      requireKnowledge(ctx).reject(input.id, input.reason);
      return { ok: true as const };
    }),

  // ── §M.1, §M.2 the retrieval layer ─────────────────────────────────────────

  /**
   * §M.1.7 — doc counts, p50/p95 per namespace, and which backend is answering.
   *
   * The degraded-retrieval badge reads this. `backend: 'fts5'` with a `degradedReason` is the
   * normal state of an install with no Moss credentials, not an error, so the UI says what is
   * missing rather than that something is broken.
   */
  retrievalStats: procedure
    .output(RetrievalStats)
    .query(({ ctx }) => requireRetrieval(ctx).stats()),

  /**
   * §M.1.4 — drop the index and re-project every row from SQLite.
   *
   * Safe by construction (R1): the index is derived, so the worst a rebuild costs is the time
   * it takes. It is a mutation because it is expensive, not because it changes any fact.
   */
  indexRebuild: procedure
    .input(z.object({ ns: Namespace.optional() }))
    .output(z.object({ indexed: z.number().int() }))
    .mutation(async ({ ctx, input }) => ({
      indexed: await requireRetrieval(ctx).rebuild(input.ns),
    })),

  /**
   * §M.2.4 — one turn's pack, with the cited text resolved.
   *
   * The stored row holds ids only, so the text is re-read from the source rows here. A cited
   * item whose row has since been deleted is dropped rather than rendered as a dead id: the
   * pack is a record of what was sent, and a link that goes nowhere is worse than one fewer
   * line.
   */
  contextPackGet: procedure
    .input(z.object({ id: z.string() }))
    .output(ContextPack.nullable())
    .query(({ ctx, input }) => readContextPack(ctx.db, input.id)),

  // ── §M.5 F1 self-maintaining APIs ──────────────────────────────────────────

  /** §M.5.3 — records the changelog. Extraction is a separate, explicit step. */
  migrationCreate: procedure
    .input(
      z.object({
        provider: z.string().min(1),
        package: z.string().min(1),
        fromVersion: z.string().nullable().optional(),
        toVersion: z.string().min(1),
        changelogText: z.string().min(1),
        sdkDiffRef: z.string().nullable().optional(),
      }),
    )
    .output(z.object({ migrationId: z.string() }))
    .mutation(({ ctx, input }) => ({
      migrationId: requireMigrations(ctx).create({ ...input, createdBy: 'local' }),
    })),

  /**
   * §M.5.3 — asks a headless agent for the changes.
   *
   * Reports what was dropped as well as what was kept: a run that extracted ten changes and
   * kept none is a model inventing changelog lines, and that has to be visible rather than
   * looking like a changelog with nothing in it.
   */
  migrationExtract: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(z.object({ kept: z.number().int(), dropped: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await requireMigrations(ctx).extractChanges(input.migrationId);
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (err as Error).message });
      }
    }),

  /** §M.5.3 — hand entry, for what the model missed. */
  migrationAddChange: procedure
    .input(
      z.object({
        migrationId: z.string(),
        kind: MigrationChangeKind,
        oldSymbol: z.string().nullable().optional(),
        newSymbol: z.string().nullable().optional(),
        description: z.string().min(1),
        evidence: z.string().optional(),
      }),
    )
    .output(z.object({ changeId: z.string() }))
    .mutation(({ ctx, input }) => ({
      changeId: requireMigrations(ctx).addChange(input.migrationId, {
        kind: input.kind,
        old_symbol: input.oldSymbol ?? null,
        new_symbol: input.newSymbol ?? null,
        description: input.description,
        ...(input.evidence ? { evidence: input.evidence } : {}),
      }),
    })),

  /** §M.5.3 — the gate between inference and action. Nothing downstream runs before this. */
  migrationChangesConfirm: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      try {
        requireMigrations(ctx).confirmChanges(input.migrationId, 'local');
        return { ok: true as const };
      } catch (err) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (err as Error).message });
      }
    }),

  /** §M.5.7 — assigns strata, arms and waves. Fixed at assignment. */
  migrationTargetsSet: procedure
    .input(z.object({ migrationId: z.string(), repoIds: z.array(z.string()).min(1) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await guardMigration(() => requireMigrations(ctx).setTargets(input.migrationId, input.repoIds));
      return { ok: true as const };
    }),

  /** §M.5.4 — parse, enrich and write the chunks. They reach Moss through the indexer. */
  migrationChunk: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(z.object({ chunks: z.number().int(), unparsed: z.array(z.string()) }))
    .mutation(({ ctx, input }) =>
      guardMigration(() => requireMigrations(ctx).chunkTargets(input.migrationId)),
    ),

  /** §M.5.5 — retrieval and grep, both recorded. */
  migrationDiscover: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(z.object({ sites: z.number().int(), queryMs: z.number() }))
    .mutation(({ ctx, input }) =>
      guardMigration(() => requireMigrations(ctx).discover(input.migrationId)),
    ),

  /** §M.5.6 — one wave, through the ordinary launch path. */
  migrationLaunchWave: procedure
    .input(z.object({ migrationId: z.string(), wave: z.number().int().min(0) }))
    .output(z.object({ launched: z.array(TaskId), deferred: z.array(z.string()) }))
    .mutation(({ ctx, input }) =>
      guardMigration(() => requireMigrations(ctx).launchWave(input.migrationId, input.wave)),
    ),

  migrationList: procedure
    .output(z.array(MigrationSummary))
    .query(({ ctx }) => requireMigrations(ctx).list()),

  migrationView: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(MigrationView.nullable())
    .query(({ ctx, input }) => requireMigrations(ctx).view(input.migrationId)),

  /** §M.5.7 — the A/B readout. Every number derived, `n` shown beside it. */
  migrationMetrics: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(MigrationMetrics)
    .query(({ ctx, input }) => requireMigrations(ctx).metrics(input.migrationId)),

  /** §M.5.8 — sites verification found that discovery did not. */
  migrationMisses: procedure
    .input(z.object({ migrationId: z.string() }))
    .output(z.array(DiscoveryMiss))
    .query(({ ctx, input }) => requireMigrations(ctx).misses(input.migrationId)),

  migrationMissesExport: procedure
    .input(z.object({ migrationId: z.string(), dir: z.string().min(1) }))
    .output(z.object({ written: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => ({
      written: await requireMigrations(ctx).exportMisses(input.migrationId, input.dir),
    })),

  // ── §M.6 F2 multiplayer lanes ──────────────────────────────────────────────

  /**
   * §M.6.2 — exchanges a teammate's GitHub token for an Osade session token.
   *
   * The only unauthenticated mutation in the router, and it has to be: it is the door. The
   * teammate's GitHub token is used once to answer "who are you" and is never stored — every
   * GitHub *write* still uses the host's token, behind a gate.
   */
  authExchange: procedure
    .input(z.object({ githubToken: z.string().min(1) }))
    .output(SessionGrant)
    .mutation(async ({ ctx, input }) => {
      try {
        const granted = await requireMembers(ctx).exchange(input.githubToken);
        return { ...granted, expires_at: ctx.now() + SESSION_TTL_MS };
      } catch (err) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: (err as Error).message });
      }
    }),

  authLogout: procedure.output(z.object({ ok: z.literal(true) })).mutation(({ ctx }) => {
    if (ctx.sessionToken) requireMembers(ctx).logout(ctx.sessionToken);
    return { ok: true as const };
  }),

  memberList: procedure.output(z.array(Member)).query(({ ctx }) => requireMembers(ctx).list()),

  memberInvite: procedure
    .input(z.object({ login: z.string().min(1), role: Role }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      requireMembers(ctx).invite(input.login, input.role, ctx.session?.login ?? 'owner');
      return { ok: true as const };
    }),

  memberSetRole: procedure
    .input(z.object({ login: z.string().min(1), role: Role }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      requireMembers(ctx).setRole(input.login, input.role);
      return { ok: true as const };
    }),

  /** §M.10 — removing a teammate revokes their live sessions in the same transaction. */
  memberRemove: procedure
    .input(z.object({ login: z.string().min(1) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      requireMembers(ctx).remove(input.login);
      return { ok: true as const };
    }),

  /** §M.6.7 — presence is a heartbeat, so "is Priya here?" is derived, never a stored flag. */
  presenceBeat: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ present: z.array(z.string()), claimedBy: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      const members = requireMembers(ctx);
      const login = ctx.session?.login;
      if (login) members.beat(login, input.taskId);
      // The claim rides on the heartbeat so a window learns who is driving without a claim of
      // its own — otherwise the only way to find out would be to try claiming.
      return { present: members.presence(input.taskId), claimedBy: members.claimedBy(input.taskId) };
    }),

  /** §M.6.7 — advisory. It records who is driving; it does not lock the lane. */
  taskClaim: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ claimedBy: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      const members = requireMembers(ctx);
      const login = ctx.session?.login ?? 'owner';
      members.beat(login, input.taskId);
      members.claim(input.taskId, login);
      return { claimedBy: members.claimedBy(input.taskId) };
    }),

  taskRelease: procedure
    .input(z.object({ taskId: TaskId }))
    .output(z.object({ claimedBy: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      const members = requireMembers(ctx);
      members.release(input.taskId, ctx.session?.login ?? 'owner');
      return { claimedBy: members.claimedBy(input.taskId) };
    }),

  /**
   * §M.6.5 — what happened while you were away.
   *
   * Gate decisions and verify failures are included by exact filter, never left to ranking: a
   * catch-up that dropped "Priya rejected the PR" because it scored eleventh would be worse
   * than none, because the reader would believe they had seen everything.
   */
  catchUp: procedure
    .input(z.object({ chatId: z.string().min(1) }))
    .output(CatchUpResult)
    .query(({ ctx, input }) =>
      requireCatchUp(ctx).since(ctx.session?.login ?? 'owner', input.chatId),
    ),

  /** §M.6.5 — cited hits, not a synthesised answer. The citation is the product. */
  askHistory: procedure
    .input(z.object({ chatId: z.string().min(1), question: z.string().min(1) }))
    .output(z.array(CatchUpItem))
    .query(({ ctx, input }) => requireCatchUp(ctx).ask(input.chatId, input.question)),

  /** §M.6.1 — the join code, or null on loopback where there is nothing to join. */
  shareInfo: procedure.output(ShareInfo).query(({ ctx }) => ctx.share?.() ?? {
    mode: 'loopback' as const,
    joinCode: null,
    fingerprint: null,
    members: ctx.members?.list() ?? [],
  }),

  // ── §M.7.4, §M.7.5, §M.8.4 — F3's maintainer half and the audit trail ──────

  /** §M.7.2 — the attestation this lane last issued, if any. */
  attestationGet: procedure
    .input(z.object({ taskId: TaskId }))
    .output(
      z
        .object({ head_sha: z.string(), approved_by: z.string(), approved_at: z.string(), tier: z.number().int() })
        .nullable(),
    )
    .query(({ ctx, input }) => {
      const latest = ctx.attest?.latestFor(input.taskId) ?? null;
      if (!latest) return null;
      return {
        head_sha: latest.head_sha,
        approved_by: latest.statement.approved_by,
        approved_at: latest.statement.approved_at,
        tier: latest.statement.tier,
      };
    }),

  /**
   * §M.7.4 — checks a PR body's block against the keys published in the repo.
   *
   * **Stale is not invalid.** A commit landing after approval means a named human really did
   * approve an earlier one; conflating that with a forged signature would teach maintainers to
   * ignore both.
   */
  attestationVerify: procedure
    .input(
      z.object({
        body: z.string(),
        currentHead: z.string().min(1),
        attestorsJson: z.string().optional(),
      }),
    )
    .output(AttestationCheck)
    .query(({ ctx, input }) => {
      const attest = ctx.attest;
      if (!attest) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'attestation is not configured' });
      }
      const published = input.attestorsJson
        ? (parseAttestorFile(input.attestorsJson)?.attestors ?? [])
        : [{ key_id: attest.key().keyId, public_key: attest.key().publicPem }];

      const result = attest.verifyBody(input.body, input.currentHead, published);
      return {
        state: result.state,
        reason: result.state === 'invalid' ? result.reason : null,
        approved_by: 'statement' in result ? result.statement.approved_by : null,
        approved_head: 'statement' in result ? result.statement.head_sha : null,
        current_head: input.currentHead,
      };
    }),

  /** §M.7.5 — the triage list: attested, then unique, then duplicate clusters. */
  prSignals: procedure
    .input(z.object({ repoId: z.string() }))
    .output(z.array(TriageRow))
    .query(({ ctx, input }) => requireSignals(ctx).triage(input.repoId)),

  /**
   * §M.8.4 — a read-only projection over the gates in a window.
   *
   * Nothing in it is computed by a model. Running it twice over the same window produces the
   * same bytes, which is what makes it something you can attach to a ticket.
   */
  auditExport: procedure
    .input(
      z.object({
        since: z.number().int(),
        until: z.number().int().optional(),
        repoId: z.string().optional(),
      }),
    )
    .output(z.array(AuditRow))
    .query(({ ctx, input }) =>
      auditExport(ctx.db, {
        since: input.since,
        ...(input.until != null ? { until: input.until } : {}),
        ...(input.repoId ? { repoId: input.repoId } : {}),
      }),
    ),

  // ── §M.8 F4 compliance on the gate ─────────────────────────────────────────

  /**
   * §M.8.1 — re-reads the policy files.
   *
   * Explicit rather than watched: a reload changes which clauses a pending gate is bound to,
   * and a filesystem watcher firing on a half-saved file would void approvals for no reason
   * anyone could see.
   */
  policyReload: procedure
    .output(PolicyReloadResult)
    .mutation(({ ctx }) => reloadPolicies(ctx.db, { onWarning: () => {} })),

  /** §M.8.3 — what the gate card shows, and whether approve is available yet. */
  gateClauses: procedure
    .input(z.object({ gateId: z.string() }))
    .output(GateClauseView)
    .query(({ ctx, input }) => readGateClauses(ctx, input.gateId)),

  /**
   * §M.8.3 — acknowledges one `requires_ack` clause.
   *
   * The ack records who and when. It is not an approval and does not decide the gate; it only
   * removes one obstacle a human policy author deliberately put in front of the button.
   */
  gateClauseAck: procedure
    .input(z.object({ gateId: z.string(), clauseId: z.string() }))
    .output(GateClauseView)
    .mutation(({ ctx, input }) => {
      // §M.6.3 — the ack names whoever the server authenticated, like `decided_by` does.
      requireClauses(ctx).ack(input.gateId, input.clauseId, ctx.session?.login ?? 'owner', ctx.now());
      return readGateClauses(ctx, input.gateId);
    }),

  /** The chip on a lane: the most recent pack for a task, or null before its first turn. */
  contextPackLatest: procedure
    .input(z.object({ taskId: TaskId }))
    .output(ContextPack.nullable())
    .query(({ ctx, input }) => {
      const row = ctx.db
        .prepare('SELECT id FROM context_pack WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(input.taskId) as { id: string } | undefined;
      return row ? readContextPack(ctx.db, row.id) : null;
    }),
});

function requireMigrations(ctx: DaemonContext): MigrationService {
  if (!ctx.migrations) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no migration service configured',
    });
  }
  return ctx.migrations;
}

/**
 * §M.5.3 — unconfirmed changes are a precondition failure, not a server error.
 *
 * The distinction matters to the UI: "confirm the changes first" is an instruction the user can
 * act on, while a 500 is a bug report.
 */
async function guardMigration<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MigrationNotConfirmedError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
    }
    throw err;
  }
}

function requireClauses(ctx: DaemonContext): GateClauses {
  if (!ctx.clauses) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no policy clause service configured',
    });
  }
  return ctx.clauses;
}

interface ClauseRow {
  hunk_ref: string;
  clause_id: string;
  score: number;
  acked_by: string | null;
  acked_at: number | null;
  clause_ref: string;
  title: string;
  text: string;
  requires_ack: number;
  scope: string;
  policy_path: string;
  file_sha: string;
}

/**
 * §M.8.3 — the card, assembled from rows.
 *
 * C1 in practice: every field here comes from a `policy_clause` joined to the `policy` file it
 * was read from, at the `file_sha` it had. There is nowhere for an uncited flag to enter.
 */
function readGateClauses(ctx: DaemonContext, gateId: string): GateClauseView {
  const rows = ctx.db
    .prepare(
      `SELECT hunk_ref, clause_id, score, acked_by, acked_at, clause_ref, title, text,
              requires_ack, scope, policy_path, file_sha
         FROM gate_clause
        -- The card shows what binds the gate now; the audit export shows everything it showed.
        WHERE gate_id = ? AND unbound_at IS NULL
        ORDER BY hunk_ref, clause_ref`,
    )
    .all(gateId) as ClauseRow[];

  const byHunk = new Map<string, GateClauseView['hunks'][number]>();
  let outstanding = 0;
  for (const row of rows) {
    const hunk = byHunk.get(row.hunk_ref) ?? { hunk_ref: row.hunk_ref, clauses: [] };
    if (row.requires_ack === 1 && row.acked_at == null) outstanding += 1;
    hunk.clauses.push({
      clause_id: row.clause_id,
      clause_ref: row.clause_ref,
      title: row.title,
      text: row.text,
      scope: row.scope === 'global' ? 'global' : 'repo',
      policy_path: row.policy_path,
      file_sha: row.file_sha,
      requires_ack: row.requires_ack === 1,
      score: row.score,
      acked_by: row.acked_by,
      acked_at: row.acked_at,
    });
    byHunk.set(row.hunk_ref, hunk);
  }

  return {
    gate_id: gateId,
    hunks: [...byHunk.values()],
    outstandingAcks: outstanding,
    approvable: outstanding === 0,
  };
}

/** Retrieval is always present in a running daemon; a test harness may omit it. */
function requireRetrieval(ctx: DaemonContext): RetrievalService {
  if (!ctx.retrieval) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no retrieval service configured',
    });
  }
  return ctx.retrieval;
}

interface PackRow {
  id: string;
  task_id: string;
  chat_turn_id: string | null;
  arm: string | null;
  backend: string;
  retrieval_ms: number;
  assembly_ms: number;
  tokens_used: number;
  overflow: number;
  degraded: number;
  items_json: string;
  created_at: number;
}

function readContextPack(db: Db, id: string): ContextPack | null {
  const row = db.prepare('SELECT * FROM context_pack WHERE id = ?').get(id) as PackRow | undefined;
  if (!row) return null;

  const stored = JSON.parse(row.items_json) as {
    id: string;
    ns: Namespace;
    score: number;
    src_table: string;
    src_id: string;
  }[];

  const items: ContextItem[] = [];
  for (const item of stored) {
    const doc = db
      .prepare('SELECT text, meta_json FROM retrieval_doc WHERE id = ?')
      .get(item.id) as { text: string; meta_json: string } | undefined;
    // §M.2.4 — text lives in the source rows and in the FTS5 doc store, never in items_json.
    // When neither has it any more, the citation is stale and is dropped.
    if (!doc) continue;
    let url: string | null = null;
    try {
      url = (JSON.parse(doc.meta_json) as { url?: string }).url ?? null;
    } catch {
      url = null;
    }
    items.push({ ...item, text: doc.text, url });
  }

  return {
    id: row.id,
    task_id: row.task_id,
    chat_turn_id: row.chat_turn_id,
    arm: row.arm === 'digest_on' || row.arm === 'digest_off' ? row.arm : null,
    backend: row.backend === 'moss' ? 'moss' : 'fts5',
    retrieval_ms: row.retrieval_ms,
    assembly_ms: row.assembly_ms,
    tokens_used: row.tokens_used,
    overflow: row.overflow,
    degraded: row.degraded === 1,
    items,
    created_at: row.created_at,
  };
}

/**
 * Approval is not the write. `gate.branch_switch` already executed here; public GitHub
 * writes used to stop at `decide`, so a live M2 run would approve a PR that never opened.
 */
async function executeApprovedGate(ctx: DaemonContext, gateId: string): Promise<void> {
  const row = ctx.db
    .prepare('SELECT gate, payload_json, task_id FROM gate_request WHERE id = ?')
    .get(gateId) as { gate: string; payload_json: string; task_id: string } | undefined;
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown gate' });

  const payload = JSON.parse(row.payload_json) as unknown;
  try {
    switch (row.gate) {
      case 'gate.branch_switch': {
        const branch = (payload as { branch: string }).branch;
        const task = getTask(ctx.db, row.task_id);
        if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown task' });
        const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(task.repo_id) as
          | { path: string }
          | undefined;
        if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
        await checkoutBranch(taskCwd(task, repo.path), branch);
        ctx.db.prepare('UPDATE task SET branch = ? WHERE id = ?').run(branch, task.id);
        ctx.gates.markExecuted(gateId);
        return;
      }
      case 'gate.pr_open':
        await ctx.scmWrites.openPr(row.task_id, gateId, payload as OpenPrPayload);
        return;
      case 'gate.issue_comment':
      case 'gate.pr_comment': {
        const task = getTask(ctx.db, row.task_id);
        const fromIssue = issueNumberFromRef(task?.origin_ref ?? null);
        const fromPr = getTaskFacts(ctx.db, row.task_id)?.scm?.pr_number ?? null;
        const issueNumber = row.gate === 'gate.pr_comment' ? fromPr ?? fromIssue : fromIssue ?? fromPr;
        if (issueNumber == null) {
          throw new Error('no issue or pull request to comment on');
        }
        await ctx.scmWrites.comment(row.task_id, gateId, payload as CommentPayload, { issueNumber });
        return;
      }
      default:
        return;
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
  }
}

function issueNumberFromRef(ref: string | null): number | null {
  if (!ref) return null;
  const match = /\/(?:issues|pull)\/(\d+)(?:\b|$)/u.exec(ref);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Mining is optional: a daemon with no model or no token configured serves every other procedure
 * normally. Saying so plainly beats a null dereference three frames down.
 */
function requireKnowledge(ctx: DaemonContext): Knowledge {
  if (!ctx.knowledge) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'this daemon has no knowledge service configured',
    });
  }
  return ctx.knowledge;
}

function requireRepoPath(ctx: DaemonContext, repoId: string): string {
  const repo = ctx.db.prepare('SELECT path FROM repo WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown repo' });
  return repo.path;
}

export type AppRouter = typeof appRouter;
