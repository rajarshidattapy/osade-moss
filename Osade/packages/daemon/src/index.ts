import { mkdirSync } from 'node:fs';

import { openDb } from './db/index.js';
import { getAgentFact, getTask } from './db/task-repo.js';
import { failOpenTurns } from './domain/chat-turns.js';
import { Checkpoints } from './domain/checkpoints.js';
import { Gates } from './domain/gates.js';
import { LaunchTask } from './domain/launch-task.js';
import { Triage } from './domain/triage.js';
import { VerifyRunner } from './domain/verify-run.js';
import { ScmClient } from './scm/client.js';
import { ScmPoller } from './scm/poller.js';
import { ScmWrites } from './scm/writes.js';
import { HeadlessRuns, pickHeadlessAgent } from './domain/headless-run.js';
import { Knowledge } from './knowledge/service.js';
import { loadConfig } from './config.js';
import { MigrationService } from './domain/migration.js';
import { FixPatterns } from './domain/fix-patterns.js';
import { GateClauses } from './domain/gate-clauses.js';
import { reloadPolicies } from './knowledge/policies.js';
import { ContextAssembler } from './retrieval/assembler.js';
import { RetrievalService } from './retrieval/service.js';
import { SubstrateClient } from './substrate/client.js';
import { assertNoDrift, SubstrateDriftError } from './substrate/drift-check.js';
import { SubstrateEventSubscriber } from './substrate/event-subscriber.js';
import { runtimeBinary } from './substrate/runtime-binary.js';
import { osadePaths } from './paths.js';
import { startDaemonServer, type RunningDaemon } from './server/index.js';

/**
 * The daemon runtime.
 *
 * OSADE.md §20.1 — this module is a library, not a script: no `console.*` and no
 * `process.exit`. `cli.ts` owns both, and is deliberately kept off this import graph so a
 * short-lived subcommand does not eagerly load the whole server stack.
 */

export interface StartDaemonOptions {
  /** Path to substrate binary the drift check runs against (§4.1.1). */
  substrateBinary?: string;
  /** Skip the boot drift check. Tests only — never in a shipped path. */
  skipDriftCheck?: boolean;
  port?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
  onInfo?: (message: string) => void;
}

export interface Daemon extends RunningDaemon {
  readonly dbPath: string;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<Daemon> {
  const paths = osadePaths();
  const onWarning = options.onWarning ?? (() => {});
  const onInfo = options.onInfo ?? (() => {});

  // §2.2 — everything under ~/.osade, created before anything touches disk.
  for (const dir of [paths.root, paths.logsDir, paths.runsDir, paths.reviewDir, paths.skillsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // §4.1.1 — the boot drift check runs before the first API call. Fatal on protocol or a
  // missing pinned method; a superset only warns, or every the substrate upgrade is an outage.
  if (!options.skipDriftCheck) {
    try {
      const result = await assertNoDrift(options.substrateBinary ?? runtimeBinary());
      if (result.ok) onInfo(result.message);
      else onWarning(result.message);
    } catch (err) {
      if (err instanceof SubstrateDriftError) throw err;
      throw err;
    }
  }

  const db = openDb(paths.db);
  const substrate = new SubstrateClient();
  let launch: LaunchTask | null = null;
  const subscriber = new SubstrateEventSubscriber(db, substrate, {
    now: options.now,
    onWarning,
    onAgentQuiet: (taskId) => {
      void (async () => {
        await launch?.settle(taskId);
        if (getAgentFact(db, taskId)?.substrate_state === 'blocked') return;
        await launch?.sendQueued(taskId);
      })().catch((err: Error) => {
        onWarning(`settle chat for ${taskId}: ${err.message}`);
      });
    },
    onPaneExited: (taskId) => {
      const agentId = getTask(db, taskId)?.agent_id ?? 'agent';
      failOpenTurns(
        db,
        taskId,
        `${agentId} exited before finishing`,
        options.now?.() ?? Date.now(),
      );
    },
  });
  const checkpoints = new Checkpoints(db, { now: options.now, onWarning });

  // §M.1 — retrieval opens before anything that assembles context. `open` never throws: with
  // no credentials, no SDK or an unreachable Moss it returns a service on FTS5 and says why
  // (R3, §M.10). The indexer starts here so `turns` and `conventions` are live from boot.
  const config = loadConfig({ onWarning });
  const retrieval = await RetrievalService.open(db, {
    config: config.retrieval,
    now: options.now,
    onWarning,
  });
  retrieval.start();
  if (retrieval.backend === 'fts5') {
    onInfo(`retrieval is on the FTS5 fallback: ${(await retrieval.stats()).degradedReason ?? 'unknown'}`);
  }
  const assembler = new ContextAssembler(db, retrieval, {
    config: config.retrieval,
    now: options.now,
  });

  // §M.8.1 — policies are read at boot so the first gate of a session already carries its
  // clauses. A failure here is a warning, not a boot error: a malformed policy file must not
  // stop the daemon, it must stop being cited.
  const clauses = new GateClauses(db, retrieval);
  try {
    const loaded = reloadPolicies(db, { onWarning });
    if (loaded.clauses > 0) {
      onInfo(`loaded ${loaded.clauses} policy clause(s) from ${loaded.policies} file(s)`);
    }
  } catch (err) {
    onWarning(`loading policies failed: ${(err as Error).message}`);
  }

  const launcher = new LaunchTask(db, substrate, subscriber, {
    now: options.now,
    onWarning,
    checkpoints,
    assembler,
  });
  launch = launcher;
  const gates = new Gates(db, { now: options.now });
  // §10.2 — the failure loop. Wired here rather than inside the runner so the dependency
  // points one way: the runner knows nothing about launching.
  // §M.5.5 / §M.5.8 — what a lane learns when verification settles. A pass publishes verified
  // fix patterns to its siblings; a failure records what discovery missed. Neither can fail a
  // verification: `learn` swallows its own errors by contract.
  const fixPatterns = new FixPatterns(db, { now: options.now, onWarning });
  const verifier = new VerifyRunner(db, substrate, {
    now: options.now,
    onWarning,
    sendToAgent: (taskId, text) => launcher.sendTurn(taskId, text, { origin: 'automation' }),
    onRunFinished: (run) => fixPatterns.learn(run),
  });

  // A substrate that is not running is not an error at boot: agents survive the app, but the app
  // also has to start when nothing is running yet. The subscriber reconciles when it can.
  await subscriber.start().catch((err: Error) => {
    onWarning(`the substrate event subscriber did not start: ${err.message}`);
  });

  // §11 — GitHub. The token reaches us over the spawn handshake and is held in memory only
  // (§2.1); nothing writes it to disk.
  const scm = new ScmClient({ token: process.env.OSADE_GITHUB_TOKEN, now: options.now, onWarning });
  const scmWrites = new ScmWrites(db, scm, gates, { now: options.now, onWarning, clauses });
  const triage = new Triage(db, launcher, { now: options.now });
  const poller = new ScmPoller(db, scm, {
    now: options.now,
    onWarning,
    // §21 M2 — a reviewer's requested changes go back to the agent, like a verify failure.
    sendToAgent: (taskId, text) => launcher.sendTurn(taskId, text, { origin: 'automation' }),
  });
  poller.start();

  const headless = new HeadlessRuns((repoId) => {
    const row = db.prepare('SELECT default_agent FROM repo WHERE id = ?').get(repoId) as
      | { default_agent: string | null }
      | undefined;
    return row?.default_agent ?? null;
  });
  try {
    pickHeadlessAgent({});
  } catch {
    onInfo('mining is unavailable: no headless agent on PATH');
  }
  const knowledge = new Knowledge(db, scm, null, { now: options.now, onWarning, headless });

  // §M.5 — F1. The model is the same headless agent mining uses, so a daemon with no agent on
  // PATH can still run a migration from hand-entered changes (§M.5.3).
  const migrations = new MigrationService(db, {
    now: options.now,
    onWarning,
    retrieval,
    launcher,
    headless,
  });

  const server = await startDaemonServer({
    db,
    launcher,
    gates,
    verifier,
    triage,
    scmWrites,
    poller,
    knowledge,
    headless,
    retrieval,
    migrations,
    clauses,
    port: options.port,
    now: options.now,
    onWarning,
  });

  onInfo(`osade daemon listening on 127.0.0.1:${server.port}`);

  return {
    ...server,
    dbPath: paths.db,
    async close() {
      poller.stop();
      subscriber.stop();
      // Before the database closes: §M.1.3 pushes the sessions when cloudSync is on, and that
      // needs nothing from SQLite, but the indexer must stop tailing a handle about to go away.
      await retrieval.close();
      await server.close();
      db.close();
    },
  };
}

export { osadePaths } from './paths.js';
export type { AppRouter } from './server/router.js';
