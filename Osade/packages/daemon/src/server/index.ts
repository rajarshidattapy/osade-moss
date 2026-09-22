import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { WebSocketServer, type WebSocket } from 'ws';

import { ClientMessage, type ServerMessage } from '@osade/contract';

import type { Db } from '../db/index.js';
import { pruneChangeLog } from '../db/index.js';
import type { Gates } from '../domain/gates.js';
import type { LaunchTask } from '../domain/launch-task.js';
import type { Knowledge } from '../knowledge/service.js';
import type { IncomingMessage } from 'node:http';

import type { Attestations } from '../attest/service.js';
import type { CatchUp } from './catch-up.js';
import { loadTls, resolveBindAddress, type ListenMode } from './listen.js';
import type { Members, Session } from './members.js';
import type { PrSignals } from '../scm/signals.js';
import type { GateClauses } from '../domain/gate-clauses.js';
import type { MigrationService } from '../domain/migration.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { HeadlessRuns } from '../domain/headless-run.js';
import type { Triage } from '../domain/triage.js';
import type { VerifyRunner } from '../domain/verify-run.js';
import type { ScmPoller } from '../scm/poller.js';
import type { ScmWrites } from '../scm/writes.js';
import { osadePaths } from '../paths.js';
import { TaskShells } from '../domain/task-shell.js';
import { CdcBroadcaster } from './cdc-broadcaster.js';
import { appRouter, type DaemonContext } from './router.js';

/**
 * The daemon's HTTP + websocket surface.
 *
 * OSADE.md §2.1 bound `127.0.0.1` only. **OSADE-MOSS §M.6.1 replaces that**, and replaces it
 * with a stronger guarantee rather than a looser one — INVARIANT M1: a non-loopback bind
 * requires member auth *and* TLS, asserted in `listen.ts` before anything binds, fatally. The
 * default is still loopback; `server.listen: "lan"` is a deliberate act.
 *
 * The port is written to `~/.osade/daemon.port` so the CLI and the Electron app can find it
 * without a fixed port collision.
 *
 * §5.4 — the websocket carries only what `CdcBroadcaster` produces. This module wires the
 * socket; it never composes a message itself.
 */

const CHANGE_LOG_PRUNE_INTERVAL_MS = 5 * 60_000;

export interface DaemonServerOptions {
  db: Db;
  launcher: LaunchTask;
  gates: Gates;
  verifier: VerifyRunner;
  triage: Triage;
  scmWrites: ScmWrites;
  poller: ScmPoller;
  /** §13 — absent when no model is configured. Mining is optional; everything else is not. */
  knowledge?: Knowledge | null;
  /** §M.1 — the retrieval service backing `retrievalStats`, `indexRebuild` and context packs. */
  retrieval?: RetrievalService | null;
  /** §M.5 — F1's four stages. */
  migrations?: MigrationService | null;
  /** §M.8 — F4's clause matching and acks. */
  clauses?: GateClauses | null;
  /** §M.7 — F3's attestations. */
  attest?: Attestations | null;
  headless?: HeadlessRuns | null;
  /** §M.6 — F2. Absent on a single-user daemon that has never invited anyone. */
  members?: Members | null;
  catchUp?: CatchUp | null;
  /** §M.7.5 — F3's triage signals. */
  signals?: PrSignals | null;
  /** §M.6.1 — 'loopback' (default) or 'lan'. M1 is asserted before anything binds. */
  listenMode?: ListenMode;
  /** 0 asks the OS for a free port, which is the default and what the port file is for. */
  port?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
}

export interface RunningDaemon {
  readonly port: number;
  readonly broadcaster: CdcBroadcaster;
  close(): Promise<void>;
}

export async function startDaemonServer(options: DaemonServerOptions): Promise<RunningDaemon> {
  const { db, launcher } = options;
  const now = options.now ?? Date.now;
  const onWarning = options.onWarning ?? (() => {});
  const shells = new TaskShells();

  const broadcaster = new CdcBroadcaster(db, { now });
  broadcaster.start();

  const context: DaemonContext = {
    db,
    launcher,
    gates: options.gates,
    verifier: options.verifier,
    triage: options.triage,
    scmWrites: options.scmWrites,
    poller: options.poller,
    shells,
    knowledge: options.knowledge ?? null,
    retrieval: options.retrieval ?? null,
    migrations: options.migrations ?? null,
    clauses: options.clauses ?? null,
    attest: options.attest ?? null,
    headless: options.headless ?? null,
    members: options.members ?? null,
    catchUp: options.catchUp ?? null,
    signals: options.signals ?? null,
    now,
  };

  // §M.6.1 — M1 is asserted *before* anything binds. A misconfigured LAN mode is a fatal boot,
  // not a warning: the thing being prevented is a laptop on conference wifi serving an
  // unauthenticated API that can start processes on the host.
  const tls = options.listenMode === 'lan' ? loadTls() : null;
  const bindAddress = resolveBindAddress({
    mode: options.listenMode ?? 'loopback',
    port: options.port ?? 0,
    auth: (options.members?.list().length ?? 0) > 0,
    tls: tls != null,
  });

  /**
   * §M.6.2 — the session comes from the bearer token, never from the request body.
   *
   * That is the whole of §M.6.3: `decided_by` is only worth anything if the identity behind it
   * was established by the server. A client that could name itself could approve as anyone.
   */
  const hostToken = randomBytes(32).toString('base64url');
  const sessionFor = (token: string | null): Session | null =>
    isHostToken(token, hostToken) ? hostSession(options.members) : (options.members?.resolve(token) ?? null);

  const contextFor = (req: IncomingMessage): DaemonContext => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') === true ? header.slice(7) : null;
    // The host token is not a member session: logging it out would lock the owner out of
    // their own daemon until the next boot, so it never reaches `sessionToken`.
    const host = isHostToken(token, hostToken);
    return { ...context, session: sessionFor(token), sessionToken: host ? null : token };
  };

  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: ({ req }) => contextFor(req as IncomingMessage),
  });

  const http: Server = createServer((req, res) => {
    // The renderer is a file:// origin under Electron, so CORS is permissive — but only
    // loopback can reach this listener at all, which is the actual boundary (§2.1).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ok: true, build: runningBuildId() }),
      );
      return;
    }
    trpcHandler(req, res);
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    // §M.6.2 — an unauthenticated websocket is closed *before* the snapshot is sent. The
    // snapshot is the whole ledger; sending it and then checking would be a disclosure with a
    // polite error attached.
    if (options.members && options.members.list().length > 0) {
      const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
      if (!sessionFor(token)) {
        socket.close(4401, 'auth_expired');
        return;
      }
    }

    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    // §18.1 — the renderer discards local state on connect and takes the snapshot.
    const unsubscribe = broadcaster.subscribe(send);

    socket.on('message', (raw) => {
      const parsed = ClientMessage.safeParse(safeJson(raw.toString()));
      if (!parsed.success) {
        onWarning(`websocket: dropped malformed client message`);
        return;
      }
      // `hello` is the only client message in M0; re-snapshot on request.
      if (parsed.data.type === 'hello') send(broadcaster.snapshot());
    });

    socket.on('close', () => unsubscribe());
    socket.on('error', () => unsubscribe());
  });

  const port = await listen(http, options.port ?? 0, bindAddress);

  const paths = osadePaths();
  mkdirSync(dirname(paths.portFile), { recursive: true });
  writeFileSync(paths.portFile, String(port));
  // 0600: the token is exactly as private as the database next to it. (Windows ignores the
  // mode; there the profile directory's ACL is what keeps other users out.)
  writeFileSync(paths.tokenFile, hostToken, { mode: 0o600 });
  writeFileSync(paths.pidFile, String(process.pid));

  // §5.4 — retain the last 50k change_log rows; prune on a timer.
  const pruneTimer = setInterval(() => {
    try {
      pruneChangeLog(db);
    } catch (err) {
      onWarning(`change_log prune failed: ${(err as Error).message}`);
    }
  }, CHANGE_LOG_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  let closed = false;
  return {
    port,
    broadcaster,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      shells.closeAll();
      broadcaster.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      rmSync(paths.portFile, { force: true });
      rmSync(paths.tokenFile, { force: true });
      rmSync(paths.pidFile, { force: true });
    },
  };
}

function isHostToken(token: string | null, hostToken: string): boolean {
  if (!token || token.length !== hostToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(hostToken));
}

/** The host acts as the owner row when there is one, so `decided_by` names a real login. */
function hostSession(members: Members | null | undefined): Session {
  const owner = members?.list().find((member) => member.role === 'owner');
  return { login: owner?.login ?? 'owner', role: 'owner' };
}

function listen(server: Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('daemon did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Contents of the running entry (`dist/cli.js` when spawned). Desktop refuses to adopt a mismatch. */
function runningBuildId(): string {
  const fromEnv = process.env.OSADE_DAEMON_BUILD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const path = process.argv[1];
    if (!path) return '';
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { appRouter } from './router.js';
export type { AppRouter } from './router.js';
export { CdcBroadcaster } from './cdc-broadcaster.js';
