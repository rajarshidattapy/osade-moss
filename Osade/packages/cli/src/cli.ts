import { resolve } from 'node:path';

import type { AuditRow, TaskStatus, TaskView } from '@osade/contract';

import { api, OsadeCliError } from './client.js';
import { looksLikePath, openRepo } from './open.js';

/**
 * `osade` — the same surface for humans and agents (OSADE.md §17).
 *
 * Every call from an agent carries `OSADE_TASK_ID` from its environment, injected at lane
 * creation (§8.2 step 4), so writes are attributed and scoped without the caller asserting an
 * identity.
 */

/**
 * Where output goes.
 *
 * Injected rather than reached for, so `main` can be driven by a test that reads what a user
 * would have seen. §17's claim is that an orchestrating agent and a human drive the *same*
 * surface — a CLI whose behaviour is only observable by running a subprocess is one where that
 * claim goes unchecked.
 */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** §19.3 — the gutter glyph set is fixed-width and fixed-position, so it scans peripherally. */
const GLYPH: Record<TaskStatus, string> = {
  awaiting_approval: '⚑',
  needs_input: '⚑',
  review_changes_requested: '⚑',
  awaiting_review: '⚑',
  implementing: '●',
  verifying: '●',
  verify_failed: '✗',
  blocked_external: '✗',
  ci_failed: '✗',
  pr_open: '○',
  queued: '○',
  idle: '○',
  stopped: '○',
  merged: '✓',
  archived: '✓',
};

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function renderRow(view: TaskView): string {
  const activity = view.agent?.activity_text ?? '';
  return [
    GLYPH[view.status],
    pad(view.status, 24),
    pad(view.task.id, 12),
    pad(view.task.title, 34),
    activity,
  ]
    .join(' ')
    .trimEnd();
}

function currentTaskId(explicit?: string): string {
  const id = explicit ?? process.env.OSADE_TASK_ID;
  if (!id) {
    throw new OsadeCliError(
      'no task id given and OSADE_TASK_ID is not set.\n' +
        'pass one explicitly, or run this from inside a task lane.',
    );
  }
  return id;
}

/** Command groups, so a bare word is never mistaken for a directory of the same name. */
const GROUPS = ['task', 'index', 'migrate', 'policy', 'team', 'catchup', 'attest', 'audit', 'help'];

const HELP = `osade — run coding agents as open-source contributors

Usage:
  osade .                                  open the window on this repository
  osade <path>                             open the window on a repository

  osade task list                          the ledger, needs-you first
  osade task create <repo> <title> [intent]  register a task (does not launch)
  osade task start <task-id>               run the launch sequence (§8.2)
  osade task show [task-id]                one task's facts and derived status
  osade task send [task-id] <text> [--wait]  prompt the agent
  osade task read [task-id] [--lines N]    the agent pane transcript
  osade task archive [task-id]

  osade index stats                        retrieval backend, doc counts, p50/p95
  osade index rebuild [--ns <namespace>]   drop and re-project the index from SQLite

  osade migrate new <provider> <pkg> <to> <changelog-file>
  osade migrate changes <id>               extract changes from the changelog
  osade migrate add-change <id> <kind> <old> <new> <desc>   enter one by hand
  osade migrate confirm <id>               approve the changes; nothing runs before this
  osade migrate target <id> <repo-id>...   assign targets, strata, arms and waves
  osade migrate chunk <id>                 parse and index the targets
  osade migrate discover <id>              retrieval vs grep, both recorded
  osade migrate launch <id> [--wave N]     launch a wave of lanes
  osade migrate show <id>                  changes, targets and the discovery comparison
  osade migrate metrics <id>               the digest A/B readout, with n
  osade migrate misses <id> [--export DIR] what verification found that discovery missed

  osade policy reload                      re-read .osade/policies/*.md
  osade policy show <gate-id>              the clauses a gate's diff touches
  osade policy ack <gate-id> <clause-id>   acknowledge a requires_ack clause

  osade team share                         print the join code (LAN mode only)
  osade team list | invite | remove        who is in this session, and their role
  osade catchup <chat-id> [question]       what happened while you were away
  osade attest verify <body-file> <sha>    check a PR's attestation block
  osade audit export --since <date>        the gate trail, as evidence

Task id defaults to $OSADE_TASK_ID, which is set inside every agent lane.
osade . opens the window and does not wait; task verbs need a running daemon.
`;

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const [group, command, ...rest] = argv;

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    io.out(HELP);
    return 0;
  }

  // `osade .` and `osade <path>` — the shape people already know from `code .`.
  if (looksLikePath(group, GROUPS)) return openRepo(group, io);

  // §M.1.4 — the index is derived, so every verb here is safe to run at any time.
  if (group === 'index') return indexCommand(command, rest, io);
  if (group === 'migrate') return migrateCommand(command, rest, io);
  if (group === 'policy') return policyCommand(command, rest, io);
  if (group === 'team') return teamCommand(command, rest, io);
  if (group === 'catchup') return catchUpCommand([command, ...rest].filter(isText), io);
  if (group === 'attest') return attestCommand(command, rest, io);
  if (group === 'audit') return auditCommand(command, rest, io);

  if (group !== 'task') {
    io.err(`unknown command: ${group}\n  try: osade help, or osade . to open this repository\n`);
    return 2;
  }

  switch (command) {
    case 'list': {
      const tasks = await api.taskList();
      if (tasks.length === 0) {
        io.out('no tasks yet — osade task create <repo> <title>\n');
        return 0;
      }
      const needsYou = tasks.filter((t) => t.needsYou);
      for (const view of tasks) {
        // One blank line between the needs-you set and everything else, so the boundary is
        // visible without a header (§19.4: nothing moves on its own, nothing shouts).
        if (needsYou.length > 0 && view === tasks[needsYou.length]) io.out('\n');
        io.out(renderRow(view) + '\n');
      }
      return 0;
    }

    case 'create': {
      const [repoPath, title, ...intentParts] = rest;
      if (!repoPath || !title) {
        io.err('usage: osade task create <repo> <title> [intent]\n');
        return 2;
      }
      const { taskId } = await api.taskCreate({
        repoPath: resolve(repoPath),
        title,
        intent: intentParts.join(' ') || title,
      });
      io.out(`${taskId}\n`);
      return 0;
    }

    case 'start': {
      const taskId = currentTaskId(rest[0]);
      const result = await api.taskLaunch(taskId);
      io.out(`${taskId} launched in ${result.workspaceId} pane ${result.paneId}\n`);
      return 0;
    }

    case 'show': {
      const view = await api.taskGet(currentTaskId(rest[0]));
      if (!view) {
        io.err('no such task\n');
        return 1;
      }
      io.out(
        [
          `${view.task.id}  ${view.task.title}`,
          `status       ${view.status}${view.needsYou ? '  (needs you)' : ''}`,
          `branch       ${view.task.branch}`,
          `base         ${view.task.base_sha} on ${view.task.base_ref}`,
          `cwd          ${view.cwd}  (${view.attachment})`,
          `substrate    ${view.task.substrate_workspace_id ?? '—'} / ${view.agent?.substrate_pane_id ?? '—'}`,
          `agent state  ${view.agent?.substrate_state ?? '—'}  last event ${view.agent?.last_event ?? '—'}`,
          `activity     ${view.agent?.activity_text ?? '—'}`,
          `open gates   ${view.openGates.length}`,
          '',
        ].join('\n'),
      );
      return 0;
    }

    case 'send': {
      const wait = rest.includes('--wait');
      const args = rest.filter((a) => a !== '--wait');
      // `osade task send "text"` inside a lane, or `osade task send <id> "text"` outside it.
      const looksLikeId = args[0]?.startsWith('t_') === true;
      const taskId = currentTaskId(looksLikeId ? args[0] : undefined);
      const text = (looksLikeId ? args.slice(1) : args).join(' ');
      if (!text) {
        io.err('usage: osade task send [task-id] <text> [--wait]\n');
        return 2;
      }
      await api.taskSend(taskId, text, wait);
      io.out('sent\n');
      return 0;
    }

    case 'read': {
      const linesFlag = rest.indexOf('--lines');

      let lines: number | undefined;
      if (linesFlag >= 0) {
        // Validated here rather than sent onward: `--lines` with nothing after it used to reach
        // the daemon as NaN and come back as a schema error about a field the user never named.
        const parsed = Number(rest[linesFlag + 1]);
        if (!Number.isInteger(parsed) || parsed < 1) {
          io.err('usage: osade task read [task-id] [--lines N]   (N: a positive integer)\n');
          return 2;
        }
        lines = parsed;
      }

      // Skip by *index*, not by value. Filtering on `i !== linesFlag + 1` dropped argument 0 —
      // the task id — whenever `--lines` was absent and `indexOf` returned -1, so
      // `osade task read <id>` silently read whatever `$OSADE_TASK_ID` pointed at instead.
      const skip = linesFlag >= 0 ? new Set([linesFlag, linesFlag + 1]) : new Set<number>();
      const positional = rest.filter((_, i) => !skip.has(i));

      const result = await api.taskTranscript(currentTaskId(positional[0]), lines);
      io.out(result.text.endsWith('\n') ? result.text : result.text + '\n');
      if (result.truncated) io.err('(truncated)\n');
      return 0;
    }

    case 'archive': {
      await api.taskArchive(currentTaskId(rest[0]));
      io.out('archived\n');
      return 0;
    }

    default:
      io.err(`unknown task command: ${command ?? '(none)'}\n`);
      return 2;
  }
}

/**
 * `osade index …` — OSADE-MOSS §M.1.4, §M.1.7.
 *
 * `rebuild` is not a repair tool that happens to be exposed; it is the *defined* recovery for
 * every retrieval failure in §M.10, which is only true because R1 makes the index derived.
 * That is worth stating in the CLI because it is what makes the command boring to run.
 */
async function indexCommand(command: string | undefined, rest: string[], io: Io): Promise<number> {
  switch (command) {
    case 'stats': {
      const stats = await api.retrievalStats();
      io.out(`backend   ${stats.backend}${stats.degradedReason ? ` (${stats.degradedReason})` : ''}
`);
      io.out(`indexer   ${stats.indexerLag} row(s) pending

`);
      io.out(`${pad('namespace', 14)}${pad('docs', 8)}${pad('queries', 9)}${pad('p50 ms', 9)}p95 ms
`);
      for (const ns of stats.namespaces) {
        io.out(
          `${pad(ns.ns, 14)}${pad(String(ns.docs), 8)}${pad(String(ns.queries), 9)}` +
            `${pad(ns.p50Ms == null ? '-' : ns.p50Ms.toFixed(1), 9)}` +
            `${ns.p95Ms == null ? '-' : ns.p95Ms.toFixed(1)}
`,
        );
      }
      return 0;
    }

    case 'rebuild': {
      const flag = rest.indexOf('--ns');
      const ns = flag === -1 ? undefined : rest[flag + 1];
      const result = await api.indexRebuild(ns ? { ns } : {});
      io.out(`indexed ${result.indexed} document(s)
`);
      return 0;
    }

    default:
      io.err(`unknown index command: ${command ?? '(none)'}
  try: osade index stats
`);
      return 2;
  }
}

/**
 * `osade migrate …` — OSADE-MOSS §M.5.
 *
 * The verbs mirror the stages, one command each, rather than a single `osade migrate run`.
 * That is deliberate: §M.5.3 puts a human confirmation between extraction and everything
 * downstream, and a one-shot command would either skip that gate or hide it behind a prompt.
 * Separate verbs make the gate a thing you can see in your shell history.
 */
async function migrateCommand(
  command: string | undefined,
  rest: string[],
  io: Io,
): Promise<number> {
  switch (command) {
    case 'new': {
      const [provider, pkg, toVersion, changelogPath] = rest;
      if (!provider || !pkg || !toVersion || !changelogPath) {
        io.err('usage: osade migrate new <provider> <pkg> <to-version> <changelog-file>\n');
        return 2;
      }
      const { readFileSync } = await import('node:fs');
      const { migrationId } = await api.migrationCreate({
        provider,
        package: pkg,
        toVersion,
        changelogText: readFileSync(resolve(changelogPath), 'utf8'),
      });
      io.out(`${migrationId}\n`);
      return 0;
    }

    case 'changes': {
      const id = required(rest[0], 'osade migrate changes <id>', io);
      if (!id) return 2;
      const { kept, dropped } = await api.migrationExtract(id);
      io.out(`extracted ${kept} change(s)\n`);
      // §M.5.3 — a drop is not an error, but it is the one number worth seeing: it means the
      // model wrote a changelog line that was not in the changelog.
      if (dropped > 0) io.out(`dropped ${dropped} that did not quote the changelog\n`);
      return 0;
    }

    case 'add-change': {
      const [id, kind, oldSymbol, newSymbol, ...description] = rest;
      if (!id || !kind || description.length === 0) {
        io.err(
          'usage: osade migrate add-change <id> <rename|signature|removal|behavior> ' +
            '<old-symbol|-> <new-symbol|-> <description>\n',
        );
        return 2;
      }
      // §M.5.3 — hand entry. A human is the evidence, so unlike an extracted change this
      // needs no changelog citation. It is also the only way to drive a migration without a
      // headless agent, which is what makes the flow testable end to end.
      const { changeId } = await api.migrationAddChange({
        migrationId: id,
        kind,
        ...(oldSymbol && oldSymbol !== '-' ? { oldSymbol } : {}),
        ...(newSymbol && newSymbol !== '-' ? { newSymbol } : {}),
        description: description.join(' '),
      });
      io.out(`${changeId}\n`);
      return 0;
    }

    case 'confirm': {
      const id = required(rest[0], 'osade migrate confirm <id>', io);
      if (!id) return 2;
      await api.migrationChangesConfirm(id);
      io.out('confirmed — discovery and launch are now unlocked\n');
      return 0;
    }

    case 'target': {
      const [id, ...repoIds] = rest;
      if (!id || repoIds.length === 0) {
        io.err('usage: osade migrate target <id> <repo-id>...\n');
        return 2;
      }
      await api.migrationTargetsSet(id, repoIds);
      io.out(`${repoIds.length} target(s) assigned\n`);
      return 0;
    }

    case 'chunk': {
      const id = required(rest[0], 'osade migrate chunk <id>', io);
      if (!id) return 2;
      const { chunks, unparsed } = await api.migrationChunk(id);
      io.out(`${chunks} chunk(s) indexed\n`);
      if (unparsed.length > 0) io.out(`${unparsed.length} file(s) could not be parsed; grep still covers them\n`);
      return 0;
    }

    case 'discover': {
      const id = required(rest[0], 'osade migrate discover <id>', io);
      if (!id) return 2;
      const { sites, queryMs } = await api.migrationDiscover(id);
      io.out(`${sites} candidate site(s) in ${queryMs.toFixed(1)} ms of retrieval\n`);
      return 0;
    }

    case 'launch': {
      const id = required(rest[0], 'osade migrate launch <id> [--wave N]', io);
      if (!id) return 2;
      const flag = rest.indexOf('--wave');
      const wave = flag === -1 ? 0 : Number.parseInt(rest[flag + 1] ?? '0', 10);
      const { launched, deferred } = await api.migrationLaunchWave(id, wave);
      io.out(`launched ${launched.length} lane(s) in wave ${wave}\n`);
      for (const taskId of launched) io.out(`  ${taskId}\n`);
      // §M.5.6 — over the cap is a scheduling fact, not a failure, and it is said out loud
      // rather than queued somewhere the user cannot see.
      if (deferred.length > 0) io.out(`${deferred.length} deferred at the live-lane cap\n`);
      return 0;
    }

    case 'show': {
      const id = required(rest[0], 'osade migrate show <id>', io);
      if (!id) return 2;
      const view = await api.migrationView(id);
      if (!view) {
        io.err('no such migration\n');
        return 1;
      }
      io.out(`${view.id}  ${view.package} → ${view.to_version}\n`);
      io.out(
        `changes      ${view.changes.length}` +
          `${view.changes_confirmed_at ? ` (confirmed by ${view.changes_confirmed_by})` : ' (UNCONFIRMED)'}\n`,
      );
      io.out(`lanes        ${view.liveLanes}/${view.maxLiveLanes} live\n`);
      io.out(`canary       ${view.canaryGreen ? 'green' : 'not green yet'}\n\n`);

      if (view.discovery.length > 0) {
        // The §M.5.5 comparison, which is the evidence for the whole feature.
        io.out(`${pad('repo', 22)}${pad('both', 7)}${pad('moss', 7)}${pad('grep', 7)}chunks\n`);
        for (const row of view.discovery) {
          io.out(
            `${pad(row.repo_slug, 22)}${pad(String(row.both), 7)}` +
              `${pad(String(row.moss_only), 7)}${pad(String(row.grep_only), 7)}${row.chunks}\n`,
          );
        }
      }
      return 0;
    }

    case 'metrics': {
      const id = required(rest[0], 'osade migrate metrics <id>', io);
      if (!id) return 2;
      const metrics = await api.migrationMetrics(id);
      io.out(`${pad('arm', 14)}${pad('n', 5)}${pad('1st pass', 10)}${pad('turns', 8)}${pad('edits', 8)}tokens\n`);
      for (const arm of metrics.arms) {
        io.out(
          `${pad(arm.arm, 14)}${pad(String(arm.n), 5)}${pad(String(arm.firstAttemptPass), 10)}` +
            `${pad(arm.turnsToGreen == null ? '-' : arm.turnsToGreen.toFixed(1), 8)}` +
            `${pad(String(arm.humanEditsAtGate), 8)}${arm.contextTokens}\n`,
        );
      }
      // §M.5.7 — at this n it is a demonstration of the methodology, not a result, and the
      // tool should be the one saying so rather than the person reading it.
      const total = metrics.arms.reduce((sum, arm) => sum + arm.n, 0);
      if (total < 20) {
        io.out(`\nn = ${total}. Too small to conclude anything; this shows the method.\n`);
      }
      io.out(
        `retrieval p50 ${metrics.retrievalP50Ms?.toFixed(1) ?? '-'} ms, ` +
          `p95 ${metrics.retrievalP95Ms?.toFixed(1) ?? '-'} ms\n`,
      );
      return 0;
    }

    case 'misses': {
      const id = required(rest[0], 'osade migrate misses <id> [--export DIR]', io);
      if (!id) return 2;
      const flag = rest.indexOf('--export');
      if (flag !== -1) {
        const target = rest[flag + 1];
        if (!target) {
          io.err('usage: osade migrate misses <id> --export <dir>\n');
          return 2;
        }
        const { written } = await api.migrationMissesExport(id, resolve(target));
        io.out(`wrote ${written.length} fixture(s)\n`);
        return 0;
      }
      const misses = await api.migrationMisses(id);
      if (misses.length === 0) {
        io.out('no recorded misses — discovery proposed every site verification found\n');
        return 0;
      }
      for (const miss of misses) io.out(`${miss.file}:${miss.line}  ${miss.pattern}\n`);
      return 0;
    }

    default:
      io.err(`unknown migrate command: ${command ?? '(none)'}\n  try: osade migrate show <id>\n`);
      return 2;
  }
}

function required(value: string | undefined, usage: string, io: Io): string | null {
  if (value) return value;
  io.err(`usage: ${usage}\n`);
  return null;
}

/**
 * `osade policy …` — OSADE-MOSS §M.8.
 *
 * `ack` lives here and not only in the window because §17's symmetry is the point: a maintainer
 * approving from a terminal passes the same acknowledgement as one approving from the UI. A
 * rule enforced in a single client is not enforced.
 */
async function policyCommand(
  command: string | undefined,
  rest: string[],
  io: Io,
): Promise<number> {
  switch (command) {
    case 'reload': {
      const result = await api.policyReload();
      io.out(`${result.clauses} clause(s) from ${result.policies} file(s)\n`);
      if (result.removed > 0) io.out(`${result.removed} deleted policy file(s) dropped\n`);
      return 0;
    }

    case 'show': {
      const gateId = required(rest[0], 'osade policy show <gate-id>', io);
      if (!gateId) return 2;
      const view = await api.gateClauses(gateId);
      if (view.hunks.length === 0) {
        io.out('no policy clauses matched this change\n');
        return 0;
      }
      for (const hunk of view.hunks) {
        io.out(`${hunk.hunk_ref}\n`);
        for (const clause of hunk.clauses) {
          const ack = clause.requires_ack
            ? clause.acked_at
              ? ` [acked by ${clause.acked_by}]`
              : ' [NEEDS ACK]'
            : '';
          io.out(`  ${clause.clause_ref} ${clause.title} (${clause.score.toFixed(2)})${ack}\n`);
          // The file and its content hash, so the rule can be read rather than trusted (C1).
          io.out(
            `    ${clause.policy_path} @ ${clause.file_sha.slice(0, 8)}  id=${clause.clause_id}\n`,
          );
        }
      }
      io.out(
        view.approvable
          ? '\napprove is available\n'
          : `\n${view.outstandingAcks} clause(s) must be acknowledged before approval\n`,
      );
      return 0;
    }

    case 'ack': {
      const [gateId, clauseId] = rest;
      if (!gateId || !clauseId) {
        io.err('usage: osade policy ack <gate-id> <clause-id>\n');
        return 2;
      }
      const view = await api.gateClauseAck(gateId, clauseId);
      io.out(
        view.approvable
          ? 'acknowledged — approve is now available\n'
          : `acknowledged — ${view.outstandingAcks} still outstanding\n`,
      );
      return 0;
    }

    default:
      io.err(`unknown policy command: ${command ?? '(none)'}\n  try: osade policy reload\n`);
      return 2;
  }
}

/**
 * `osade team …` — OSADE-MOSS §M.6.
 *
 * The same surface a teammate uses in the window (§17). That symmetry is why the role matrix
 * lives in the daemon rather than in either client: a rule enforced in one of them is not
 * enforced.
 */
async function teamCommand(
  command: string | undefined,
  rest: string[],
  io: Io,
): Promise<number> {
  switch (command) {
    case 'share': {
      const info = await api.shareInfo();
      if (info.mode === 'loopback' || !info.joinCode) {
        // M1: LAN mode needs auth and TLS. Saying so beats printing a code that cannot work.
        io.out('this daemon is loopback-only — set server.listen to "lan" with TLS to share\n');
        return 0;
      }
      io.out(`${info.joinCode}\n\n`);
      io.out(`fingerprint  ${info.fingerprint ?? '-'}\n`);
      io.out(`members      ${info.members.length}\n`);
      return 0;
    }

    case 'list': {
      const members = await api.memberList();
      if (members.length === 0) {
        io.out('no members yet — osade team invite <login> <role>\n');
        return 0;
      }
      for (const member of members) {
        io.out(`${pad(member.login, 24)}${pad(member.role, 12)}invited by ${member.invited_by}\n`);
      }
      return 0;
    }

    case 'invite': {
      const [login, role] = rest;
      if (!login || !role) {
        io.err('usage: osade team invite <login> <maintainer|viewer>\n');
        return 2;
      }
      await api.memberInvite(login, role);
      io.out(`invited ${login} as ${role}\n`);
      return 0;
    }

    case 'remove': {
      const login = required(rest[0], 'osade team remove <login>', io);
      if (!login) return 2;
      await api.memberRemove(login);
      // §M.10 — their live sessions went with them, in the same transaction.
      io.out(`removed ${login}; their sessions are revoked\n`);
      return 0;
    }

    case 'join': {
      // Joining is an Electron-main concern: it stores the endpoint and session token in
      // safeStorage (§M.6.4). A CLI has nowhere safe to keep a token, so it says so rather
      // than inventing a plaintext file for one.
      io.err('joining from the terminal is not supported — paste the code into the Osade window\n');
      return 2;
    }

    default:
      io.err(`unknown team command: ${command ?? '(none)'}\n  try: osade team list\n`);
      return 2;
  }
}

/**
 * `osade catchup <chat-id> [question]` — §M.6.5.
 *
 * Marks the chat read, exactly as opening the window does. Guaranteed items are flagged with
 * `!` so a reader can tell "everything important, plus what else happened" from "the twelve
 * most relevant things" — a distinction that decides whether they are actually caught up.
 */
async function catchUpCommand(rest: string[], io: Io): Promise<number> {
  const chatId = required(rest[0], 'osade catchup <chat-id> [question]', io);
  if (!chatId) return 2;

  const question = rest.slice(1).join(' ').trim();
  if (question.length > 0) {
    const hits = await api.askHistory(chatId, question);
    if (hits.length === 0) {
      io.out('nothing in this chat matches\n');
      return 0;
    }
    // Cited hits, never a synthesised answer. The citation is the product.
    for (const hit of hits) io.out(`[${hit.src_table}:${hit.src_id}] ${oneLine(hit.text)}\n`);
    return 0;
  }

  const result = await api.catchUp(chatId);
  if (result.items.length === 0) {
    io.out('nothing new since you last looked\n');
    return 0;
  }
  for (const item of result.items) {
    io.out(`${item.guaranteed ? '!' : ' '} ${pad(item.kind, 18)}${oneLine(item.text)}\n`);
  }
  io.out(
    `\n${result.items.length} item(s) via ${result.backend} in ${result.retrieval_ms.toFixed(1)} ms\n`,
  );
  return 0;
}

/** `osade attest verify` — §M.7.4. */
async function attestCommand(
  command: string | undefined,
  rest: string[],
  io: Io,
): Promise<number> {
  if (command !== 'verify') {
    io.err(`unknown attest command: ${command ?? '(none)'}\n  try: osade attest verify <file> <sha>\n`);
    return 2;
  }
  const [bodyFile, head, attestors] = rest;
  if (!bodyFile || !head) {
    io.err('usage: osade attest verify <pr-body-file> <current-head-sha> [attestors.json]\n');
    return 2;
  }

  const { readFileSync } = await import('node:fs');
  const result = await api.attestationVerify({
    body: readFileSync(resolve(bodyFile), 'utf8'),
    currentHead: head,
    ...(attestors ? { attestorsJson: readFileSync(resolve(attestors), 'utf8') } : {}),
  });

  switch (result.state) {
    case 'valid':
      io.out(`valid — approved by ${result.approved_by} for ${head.slice(0, 8)}\n`);
      return 0;
    case 'stale':
      // Stale is not invalid: a named human did approve an earlier commit. Exit 0, because
      // nothing is wrong — there is simply newer code.
      io.out(
        `stale — approved by ${result.approved_by} for ${result.approved_head?.slice(0, 8)}, ` +
          `but the head is now ${head.slice(0, 8)}\n`,
      );
      return 0;
    case 'absent':
      io.out('no attestation in this pull request\n');
      return 1;
    default:
      io.err(`invalid — ${result.reason ?? 'the signature does not verify'}\n`);
      return 1;
  }
}

/** `osade audit export --since <date>` — §M.8.4. */
async function auditCommand(
  command: string | undefined,
  rest: string[],
  io: Io,
): Promise<number> {
  if (command !== 'export') {
    io.err(
      `unknown audit command: ${command ?? '(none)'}\n  try: osade audit export --since <date>\n`,
    );
    return 2;
  }

  const sinceIndex = rest.indexOf('--since');
  const sinceArg = sinceIndex === -1 ? undefined : rest[sinceIndex + 1];
  const since = sinceArg ? Date.parse(sinceArg) : Number.NaN;
  if (!Number.isFinite(since)) {
    io.err('usage: osade audit export --since <YYYY-MM-DD> [--repo <id>] [--format jsonl|csv]\n');
    return 2;
  }

  const repoIndex = rest.indexOf('--repo');
  const repoId = repoIndex === -1 ? undefined : rest[repoIndex + 1];
  const formatIndex = rest.indexOf('--format');
  const format = formatIndex === -1 ? 'jsonl' : rest[formatIndex + 1];

  const rows = await api.auditExport({ since, ...(repoId ? { repoId } : {}) });
  if (format === 'csv') {
    io.out(csvOf(rows));
    return 0;
  }
  // JSON Lines: one self-contained record per line, so a partial file is still readable.
  for (const row of rows) io.out(`${JSON.stringify(row)}\n`);
  return 0;
}

/**
 * CSV for the spreadsheet an auditor will actually open.
 *
 * Rendered here rather than in the daemon so the procedure keeps returning typed rows — a
 * procedure that returned a formatted string would put presentation behind the contract.
 */
function csvOf(rows: readonly AuditRow[]): string {
  const header = [
    'gate_id',
    'gate',
    'repo',
    'decided_at',
    'decision',
    'decided_by',
    'head_sha',
    'verification',
    'clauses_shown',
    'clauses_acked',
    'attestation_id',
  ];
  const cell = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const lines = rows.map((row) =>
    [
      row.gate_id,
      row.gate,
      row.repo,
      row.decided_at ?? '',
      row.decision ?? '',
      row.decided_by ?? '',
      row.head_sha ?? '',
      row.verification.map((step) => `${step.step}=${step.exit ?? '?'}`).join(';'),
      row.clauses_shown.map((clause) => clause.ref).join(';'),
      row.clauses_acked.map((clause) => clause.ref).join(';'),
      row.attestation_id ?? '',
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 100 ? `${collapsed.slice(0, 99)}…` : collapsed;
}

function isText(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
