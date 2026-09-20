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
  const launcher = new LaunchTask(db, substrate, subscriber, {
    now: options.now,
    onWarning,
    checkpoints,
  });
  launch = launcher;
  const gates = new Gates(db, { now: options.now });
  // §10.2 — the failure loop. Wired here rather than inside the runner so the dependency
  // points one way: the runner knows nothing about launching.
  const verifier = new VerifyRunner(db, substrate, {
    now: options.now,
    onWarning,
    sendToAgent: (taskId, text) => launcher.sendTurn(taskId, text, { origin: 'automation' }),
  });

  // A substrate that is not running is not an error at boot: agents survive the app, but the app
  // also has to start when nothing is running yet. The subscriber reconciles when it can.
  await subscriber.start().catch((err: Error) => {
    onWarning(`the substrate event subscriber did not start: ${err.message}`);
  });

  // §11 — GitHub. The token reaches us over the spawn handshake and is held in memory only
  // (§2.1); nothing writes it to disk.
  const scm = new ScmClient({ token: process.env.OSADE_GITHUB_TOKEN, now: options.now, onWarning });
  const scmWrites = new ScmWrites(db, scm, gates, { now: options.now, onWarning });
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
      await server.close();
      db.close();
    },
  };
}

export { osadePaths } from './paths.js';
export type { AppRouter } from './server/router.js';
