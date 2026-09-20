import type { SubstrateAgentStatus } from '@osade/contract';

import type { Db } from '../db/index.js';
import { getAgentFact } from '../db/task-repo.js';
import { reduceAgentInput, type AgentInput } from '../domain/agent-reducer.js';
import { classifyExternalBlock } from '../domain/external-block.js';
import type { SubstrateClient } from './client.js';
import { SubstrateEventStream, type SubstrateEventEnvelope, type Subscription } from './event-stream.js';

/**
 * The substrate event subscriber — OSADE.md §7.2.
 *
 * INVARIANT: this is a **connection manager, not a socket**. the substrate's `events.subscribe` has two
 * families: global lifecycle events take no parameters, but `pane.agent_status_changed`
 * requires a `pane_id` and rejects a subscription without one. And `pane.updated` is *not* a
 * status feed — it fires only on agent-name change and a few unrelated actions, verified by
 * holding one open across a complete `working → done` turn and receiving nothing.
 *
 * So: one global connection, plus one per live agent pane. Opened when a pane id appears,
 * closed on `pane.exited` / `pane.closed`. ~15 concurrent tasks is ~16 connections.
 *
 * INVARIANT (§5.4.1): every fact write is gated on a monotonic counter and every (re)connect
 * reconciles against `session.snapshot` before the stream is trusted. the substrate replays its
 * 512-entry ring buffer on connect and can drop silently, and its envelopes carry no sequence
 * number, so neither guard is optional.
 */

/** Global lifecycle events. These carry no parameters and ride one shared connection. */
const GLOBAL_SUBSCRIPTIONS: readonly Subscription[] = [
  { type: 'workspace.created' },
  { type: 'workspace.closed' },
  { type: 'worktree.created' },
  { type: 'worktree.removed' },
  { type: 'tab.created' },
  { type: 'tab.closed' },
  { type: 'pane.created' },
  { type: 'pane.closed' },
  { type: 'pane.exited' },
  { type: 'pane.agent_detected' },
];

export interface EventSubscriberOptions {
  now?: () => number;
  /** Injected in tests so a fake substrate can be driven without a socket. */
  createStream?: (socketPath: string, subs: readonly Subscription[]) => SubstrateEventStream;
  onWarning?: (message: string) => void;
  /** After a turn settles (`done` / `blocked` / `idle`). Persist the reply and flush queued chat. */
  onAgentQuiet?: (taskId: string) => void;
  /** After the pane process exits. Fail any turn still waiting on it. */
  onPaneExited?: (taskId: string) => void;
}

interface PaneBinding {
  taskId: string;
  stream: SubstrateEventStream;
}

export class SubstrateEventSubscriber {
  readonly #db: Db;
  readonly #client: SubstrateClient;
  readonly #now: () => number;
  readonly #createStream: (socketPath: string, subs: readonly Subscription[]) => SubstrateEventStream;
  readonly #onWarning: (message: string) => void;
  readonly #onAgentQuiet: ((taskId: string) => void) | null;
  readonly #onPaneExited: ((taskId: string) => void) | null;
  readonly #panes = new Map<string, PaneBinding>();
  #global: SubstrateEventStream | null = null;

  constructor(db: Db, client: SubstrateClient, options: EventSubscriberOptions = {}) {
    this.#db = db;
    this.#client = client;
    this.#now = options.now ?? Date.now;
    this.#createStream =
      options.createStream ?? ((path, subs) => new SubstrateEventStream(path, subs));
    this.#onWarning = options.onWarning ?? (() => {});
    this.#onAgentQuiet = options.onAgentQuiet ?? null;
    this.#onPaneExited = options.onPaneExited ?? null;
  }

  get paneCount(): number {
    return this.#panes.size;
  }

  /** Opens the global connection and reconciles before trusting anything it sends. */
  async start(): Promise<void> {
    await this.reconcile();

    const stream = this.#createStream(this.#client.socketPath, GLOBAL_SUBSCRIPTIONS);
    stream.on('event', (envelope) => {
      try {
        this.#handleGlobal(envelope);
      } catch (err) {
        this.#onWarning(`substrate global event write: ${(err as Error).message}`);
      }
    });
    stream.on('closed', ({ willRetry }) => {
      // A reconnect replays the ring buffer, so reconcile again before trusting the stream.
      if (willRetry) void this.reconcile().catch(() => {});
    });
    stream.on('error', (err) => this.#onWarning(`the substrate global event stream: ${err.message}`));
    stream.start();
    this.#global = stream;
  }

  stop(): void {
    this.#global?.stop();
    this.#global = null;
    for (const { stream } of this.#panes.values()) stream.stop();
    this.#panes.clear();
  }

  /**
   * §5.4.1 step 3 — pull the authoritative state and write it before trusting the stream.
   *
   * This is a bounded read on a connection event, not polling: it never drives the UI directly
   * and it never runs on a timer.
   */
  async reconcile(): Promise<void> {
    let snapshot: { agents?: unknown[] };
    try {
      snapshot = (await this.#client.request('session.snapshot', {})) as { agents?: unknown[] };
    } catch (err) {
      // A failed reconcile is a fact, not a state change (§5.2). Record nothing, kill nothing.
      this.#onWarning(`session.snapshot failed: ${(err as Error).message}`);
      return;
    }

    for (const raw of snapshot.agents ?? []) {
      const agent = raw as {
        pane_id?: string;
        agent_status?: SubstrateAgentStatus;
        state_change_seq?: number;
        terminal_title_stripped?: string | null;
        agent_session?: { value?: string } | null;
      };
      if (!agent.pane_id || !agent.agent_status) continue;

      const taskId = this.#taskForPane(agent.pane_id);
      if (!taskId) continue;

      this.#apply(taskId, {
        kind: 'status',
        status: agent.agent_status,
        seq: agent.state_change_seq ?? 0,
        at: this.#now(),
        activityText: agent.terminal_title_stripped ?? null,
      });

      if (agent.agent_session?.value) {
        this.#apply(taskId, {
          kind: 'session',
          at: this.#now(),
          agentSessionId: agent.agent_session.value,
        });
      }
    }
  }

  /**
   * Opens a status connection for one task's agent pane.
   *
   * Called after `agent.start` returns a pane id, and after reconcile finds a pane Osade did
   * not know about. Idempotent.
   */
  watchPane(taskId: string, paneId: string): void {
    this.#db
      .prepare('UPDATE agent_fact SET substrate_pane_id = ? WHERE task_id = ?')
      .run(paneId, taskId);
    if (this.#panes.has(paneId)) return;

    const stream = this.#createStream(this.#client.socketPath, [
      { type: 'pane.agent_status_changed', pane_id: paneId },
    ]);
    stream.on('event', (envelope) => {
      try {
        this.#handlePaneEvent(taskId, envelope);
      } catch (err) {
        this.#onWarning(`pane ${paneId} fact write: ${(err as Error).message}`);
      }
    });
    stream.on('error', (err) => this.#onWarning(`pane ${paneId} status stream: ${err.message}`));
    this.#panes.set(paneId, { taskId, stream });
    stream.start();
  }

  unwatchPane(paneId: string): void {
    const binding = this.#panes.get(paneId);
    if (!binding) return;
    binding.stream.stop();
    this.#panes.delete(paneId);
  }

  #handleGlobal(envelope: SubstrateEventEnvelope): void {
    const paneId = (envelope.data.pane_id ?? (envelope.data.pane as { pane_id?: string })?.pane_id) as
      | string
      | undefined;

    switch (envelope.event) {
      case 'pane_created':
      case 'pane.created': {
        if (!paneId) return;
        const taskId = this.#taskForPane(paneId);
        if (taskId) this.watchPane(taskId, paneId);
        return;
      }

      case 'pane_exited':
      case 'pane.exited': {
        if (!paneId) return;
        const taskId = this.#panes.get(paneId)?.taskId ?? this.#taskForPane(paneId);
        this.unwatchPane(paneId);
        if (taskId) {
          // §5.2 — a pane exiting is not a death certificate. `terminated` is set only by an
          // explicit process exit, and the substrate's `pane.exited` does not distinguish a crash from
          // a substrate restart, so Osade does not infer one. §8.2.1 relaunches instead.
          this.#apply(taskId, {
            kind: 'pane_exited',
            seq: this.#nextSeqFor(taskId),
            at: this.#now(),
            explicit: false,
          });
          this.#onPaneExited?.(taskId);
        }
        return;
      }

      case 'pane_closed':
      case 'pane.closed': {
        if (paneId) this.unwatchPane(paneId);
        return;
      }

      default:
        return;
    }
  }

  #handlePaneEvent(taskId: string, envelope: SubstrateEventEnvelope): void {
    const data = envelope.data as {
      agent_status?: SubstrateAgentStatus;
      title?: string | null;
      state_change_seq?: number;
    };
    if (!data.agent_status) return;

    this.#apply(taskId, {
      kind: 'status',
      status: data.agent_status,
      // the substrate's subscription envelope carries no sequence number (§5.4.1), so synthesise a
      // monotonic one per task. It only has to order this daemon's own writes; the snapshot
      // reconcile is what re-anchors to the substrate's authoritative counter.
      seq: this.#nextSeqFor(taskId),
      at: this.#now(),
      activityText: data.title ?? undefined,
    });

    // Session-limit / auth copy lives in the pane dump, not the title. Classify after `done`
    // so a quota exit cannot land in awaiting_review.
    if (data.agent_status === 'done') {
      void this.#enrichExternalBlock(taskId);
    }
  }

  async #enrichExternalBlock(taskId: string): Promise<void> {
    const paneId = this.#paneIdFor(taskId);
    if (!paneId) return;
    const dump = await this.#paneDump(paneId);
    if (!classifyExternalBlock(dump)) return;
    this.#apply(taskId, {
      kind: 'status',
      status: 'done',
      seq: this.#nextSeqFor(taskId),
      at: this.#now(),
      activityText: dump,
    });
  }

  async #paneDump(paneId: string): Promise<string> {
    try {
      const result = await this.#client.request(
        'pane.read',
        { pane_id: paneId, source: 'recent', lines: 80, format: 'text', strip_ansi: true },
      );
      return (result as { read?: { text?: string } }).read?.text ?? '';
    } catch {
      return '';
    }
  }

  #paneIdFor(taskId: string): string | null {
    for (const [paneId, binding] of this.#panes) {
      if (binding.taskId === taskId) return paneId;
    }
    const row = this.#db
      .prepare('SELECT substrate_pane_id FROM agent_fact WHERE task_id = ?')
      .get(taskId) as { substrate_pane_id: string | null } | undefined;
    return row?.substrate_pane_id ?? null;
  }

  /**
   * Applies one input through the pure reducer and persists the patch.
   *
   * §5.4.1 — the patch and `state_change_seq` land in one transaction. A fact stored without
   * advancing the counter, or a counter advanced without the fact, reintroduces the bug.
   */
  #apply(taskId: string, input: AgentInput): void {
    const apply = this.#db.transaction((): boolean => {
      const current = getAgentFact(this.#db, taskId);
      const { patch } = reduceAgentInput(current, input);
      if (patch == null) return false;

      if (current == null) {
        this.#db
          .prepare('INSERT OR IGNORE INTO agent_fact (task_id) VALUES (?)')
          .run(taskId);
      }

      const columns = Object.keys(patch);
      if (columns.length === 0) return false;

      const assignments = columns.map((c) => `${c} = ?`).join(', ');
      const values = columns.map((c) => {
        const v = (patch as Record<string, unknown>)[c];
        return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null);
      });
      this.#db
        .prepare(`UPDATE agent_fact SET ${assignments} WHERE task_id = ?`)
        .run(...values, taskId);
      return true;
    });
    let wrote = false;
    try {
      wrote = apply();
    } catch (err) {
      this.#onWarning(`agent_fact write for ${taskId}: ${(err as Error).message}`);
      return;
    }
    if (wrote && input.kind === 'status') {
      if (
        input.status === 'idle' ||
        input.status === 'done' ||
        input.status === 'blocked'
      ) {
        this.#onAgentQuiet?.(taskId);
      }
    }
  }

  #nextSeqFor(taskId: string): number {
    const row = this.#db
      .prepare('SELECT state_change_seq AS seq FROM agent_fact WHERE task_id = ?')
      .get(taskId) as { seq: number } | undefined;
    return (row?.seq ?? 0) + 1;
  }

  #taskForPane(paneId: string): string | null {
    const row = this.#db
      .prepare('SELECT task_id FROM agent_fact WHERE substrate_pane_id = ?')
      .get(paneId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }
}
