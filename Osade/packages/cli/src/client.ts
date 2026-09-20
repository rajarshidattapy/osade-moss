import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AttestationCheck,
  AuditRow,
  CatchUpItem,
  CatchUpResult,
  DiscoveryMiss,
  GateClauseView,
  MigrationMetrics,
  MigrationView,
  Member,
  PolicyReloadResult,
  RetrievalStats,
  SessionGrant,
  ShareInfo,
  TaskView,
  TriageRow,
} from '@osade/contract';

/**
 * A tiny tRPC-over-HTTP client for the `osade` CLI.
 *
 * OSADE.md §17 — DECISION: agents coordinate by driving this CLI, exactly as a human would.
 * There is no agent-to-agent protocol and no privileged path: an orchestrator cannot bypass a
 * gate, because gates live in the daemon rather than in the caller. Anything an orchestrator
 * can do, a human can do from a terminal, and vice versa. That symmetry is the point.
 *
 * Deliberately hand-rolled rather than pulling in `@trpc/client`: the CLI must stay cheap to
 * start, and this is three fetches.
 */

export class OsadeCliError extends Error {}

function portFilePath(): string {
  const root = process.env.OSADE_HOME ?? join(homedir(), '.osade');
  return join(root, 'daemon.port');
}

export function daemonBaseUrl(): string {
  if (process.env.OSADE_DAEMON_URL) return process.env.OSADE_DAEMON_URL;
  let port: string;
  try {
    port = readFileSync(portFilePath(), 'utf8').trim();
  } catch {
    throw new OsadeCliError(
      `the osade daemon does not appear to be running (no ${portFilePath()}).\n` +
        `start it with: osade-daemon start`,
    );
  }
  // §2.1 — loopback only. There is no remote mode in v1.
  return `http://127.0.0.1:${port}`;
}

async function call(kind: 'query' | 'mutation', path: string, input: unknown): Promise<unknown> {
  const base = daemonBaseUrl();
  const url =
    kind === 'query'
      ? `${base}/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${base}/${path}`;

  const response = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(kind === 'mutation' ? { body: JSON.stringify(input) } : {}),
  });

  const body = (await response.json()) as {
    result?: { data?: unknown };
    error?: { message?: string; json?: { message?: string } };
  };

  if (body.error) {
    throw new OsadeCliError(body.error.json?.message ?? body.error.message ?? 'daemon error');
  }
  return body.result?.data;
}

export const api = {
  /** §17 — what `osade .` calls. Idempotent, and resolves to the repository root. */
  repoOpen: (path: string) =>
    call('mutation', 'repoOpen', { path }) as Promise<{
      repoId: string;
      path: string;
      name: string;
      slug: string | null;
      defaultBranch: string;
      currentBranch: string;
      defaultAgent: string | null;
      taskCount: number;
    }>,

  taskList: () => call('query', 'taskList', undefined) as Promise<TaskView[]>,
  taskGet: (taskId: string) =>
    call('query', 'taskGet', { taskId }) as Promise<TaskView | null>,
  taskCreate: (input: {
    repoPath: string;
    title: string;
    intent: string;
    agentId?: string;
    chatId?: string;
    baseRef?: string;
    checkoutRef?: string;
    isolate?: boolean;
  }) =>
    call('mutation', 'taskCreate', input) as Promise<{
      taskId: string;
      isolated: boolean;
      isolatedBecause?: { taskId: string; chatId: string; title: string };
    }>,
  taskLaunch: (taskId: string) =>
    call('mutation', 'taskLaunch', { taskId }) as Promise<{
      taskId: string;
      paneId: string;
      workspaceId: string;
    }>,
  taskSend: (taskId: string, text: string, wait: boolean) =>
    call('mutation', 'taskSend', { taskId, text, wait }) as Promise<{ ok: true }>,
  taskTranscript: (taskId: string, lines?: number) =>
    call('query', 'taskTranscript', { taskId, lines }) as Promise<{
      text: string;
      revision: number;
      truncated: boolean;
    }>,
  taskArchive: (taskId: string) =>
    call('mutation', 'taskArchive', { taskId }) as Promise<{ ok: true }>,

  /** §M.1.7 — the degraded-retrieval badge's data, in a terminal. */
  retrievalStats: () => call('query', 'retrievalStats', undefined) as Promise<RetrievalStats>,
  indexRebuild: (input: { ns?: string }) =>
    call('mutation', 'indexRebuild', input) as Promise<{ indexed: number }>,

  // §M.5 — F1. The CLI mirrors the procedures (§17 symmetry): anything the window can drive,
  // a terminal can drive, and an orchestrator agent has no privileged path either.
  migrationCreate: (input: {
    provider: string;
    package: string;
    fromVersion?: string | null;
    toVersion: string;
    changelogText: string;
  }) => call('mutation', 'migrationCreate', input) as Promise<{ migrationId: string }>,
  migrationExtract: (migrationId: string) =>
    call('mutation', 'migrationExtract', { migrationId }) as Promise<{
      kept: number;
      dropped: number;
    }>,
  migrationAddChange: (input: {
    migrationId: string;
    kind: string;
    oldSymbol?: string;
    newSymbol?: string;
    description: string;
  }) => call('mutation', 'migrationAddChange', input) as Promise<{ changeId: string }>,
  migrationChangesConfirm: (migrationId: string) =>
    call('mutation', 'migrationChangesConfirm', { migrationId }) as Promise<{ ok: true }>,
  migrationTargetsSet: (migrationId: string, repoIds: string[]) =>
    call('mutation', 'migrationTargetsSet', { migrationId, repoIds }) as Promise<{ ok: true }>,
  migrationChunk: (migrationId: string) =>
    call('mutation', 'migrationChunk', { migrationId }) as Promise<{
      chunks: number;
      unparsed: string[];
    }>,
  migrationDiscover: (migrationId: string) =>
    call('mutation', 'migrationDiscover', { migrationId }) as Promise<{
      sites: number;
      queryMs: number;
    }>,
  migrationLaunchWave: (migrationId: string, wave: number) =>
    call('mutation', 'migrationLaunchWave', { migrationId, wave }) as Promise<{
      launched: string[];
      deferred: string[];
    }>,
  migrationView: (migrationId: string) =>
    call('query', 'migrationView', { migrationId }) as Promise<MigrationView | null>,
  migrationMetrics: (migrationId: string) =>
    call('query', 'migrationMetrics', { migrationId }) as Promise<MigrationMetrics>,
  migrationMisses: (migrationId: string) =>
    call('query', 'migrationMisses', { migrationId }) as Promise<DiscoveryMiss[]>,
  migrationMissesExport: (migrationId: string, dir: string) =>
    call('mutation', 'migrationMissesExport', { migrationId, dir }) as Promise<{
      written: string[];
    }>,

  // §M.8 — F4.
  policyReload: () => call('mutation', 'policyReload', undefined) as Promise<PolicyReloadResult>,
  gateClauses: (gateId: string) =>
    call('query', 'gateClauses', { gateId }) as Promise<GateClauseView>,
  gateClauseAck: (gateId: string, clauseId: string) =>
    call('mutation', 'gateClauseAck', { gateId, clauseId }) as Promise<GateClauseView>,
// §M.6 — F2. Identity, roles and catching up.
  authExchange: (githubToken: string) =>
    call('mutation', 'authExchange', { githubToken }) as Promise<SessionGrant>,
  memberList: () => call('query', 'memberList', undefined) as Promise<Member[]>,
  memberInvite: (login: string, role: string) =>
    call('mutation', 'memberInvite', { login, role }) as Promise<{ ok: true }>,
  memberRemove: (login: string) =>
    call('mutation', 'memberRemove', { login }) as Promise<{ ok: true }>,
  catchUp: (chatId: string) => call('query', 'catchUp', { chatId }) as Promise<CatchUpResult>,
  askHistory: (chatId: string, question: string) =>
    call('query', 'askHistory', { chatId, question }) as Promise<CatchUpItem[]>,
  shareInfo: () => call('query', 'shareInfo', undefined) as Promise<ShareInfo>,

  // §M.7 — F3. Attestation and the maintainer's triage list.
  attestationVerify: (input: { body: string; currentHead: string; attestorsJson?: string }) =>
    call('query', 'attestationVerify', input) as Promise<AttestationCheck>,
  prSignals: (repoId: string) => call('query', 'prSignals', { repoId }) as Promise<TriageRow[]>,

  // §M.8.4 — the audit trail.
  auditExport: (input: { since: number; until?: number; repoId?: string }) =>
    call('query', 'auditExport', input) as Promise<AuditRow[]>,
};

