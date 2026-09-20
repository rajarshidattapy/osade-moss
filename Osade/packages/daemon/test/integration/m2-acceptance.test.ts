import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { getScmFact, getTask, getTaskFacts } from '../../src/db/task-repo.js';
import { deriveStatus } from '../../src/domain/derive-status.js';
import { Gates } from '../../src/domain/gates.js';
import { LaunchTask } from '../../src/domain/launch-task.js';
import { Triage } from '../../src/domain/triage.js';
import type { SubstrateClient } from '../../src/substrate/client.js';
import type { SubstrateEventSubscriber } from '../../src/substrate/event-subscriber.js';
import { ScmClient, type ScmRequest } from '../../src/scm/client.js';
import { ScmPoller } from '../../src/scm/poller.js';
import { ScmWrites } from '../../src/scm/writes.js';

/**
 * The M2 acceptance — OSADE.md §21.
 *
 * > Import a real issue from a repo you maintain; land one PR through the gate; run one triage
 * > task that produces a reproduction and no PR.
 *
 * This runs the whole shape against a **recorded GitHub** (§20.2), because the live version
 * needs a token and a repository the person running it maintains — see `docs/M2-ACCEPTANCE.md`
 * for that. What is proved here is every step Osade owns: the import, the gate, the write, the
 * facts that come back, the review loop, and a triage task that produces no PR at all.
 */

const NOW = 1_756_000_000_000;

let dir: string;
let repoPath: string;
let db: Db;
let gates: Gates;
let writer: ScmWrites;
let poller: ScmPoller;
let triage: Triage;
let launcher: LaunchTask;
const agentPrompts: string[] = [];
let script: Record<string, unknown[]>;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

const ISSUE = {
  number: 417,
  title: 'Crash when the config file is empty',
  body: 'Running `widget build` with an empty config throws a TypeError.',
  url: 'https://github.com/acme/widget/issues/417',
};

const PR_AFTER_REVIEW = {
  number: 88,
  html_url: 'https://github.com/acme/widget/pull/88',
  state: 'open',
  merged: false,
  draft: false,
  mergeable_state: 'clean',
  head: { sha: 'newsha' },
};

const request: ScmRequest = async (route) => {
  const queue = script[route];
  const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
  if (next instanceof Error) throw next;
  return {
    status: 200,
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900' },
    data: next,
  };
};

const fakeSubstrate = { socketPath: '/fake', request: async () => ({}) } as unknown as SubstrateClient;
const fakeSubscriber = { watchPane() {}, unwatchPane() {} } as unknown as SubstrateEventSubscriber;

beforeEach(() => {
  agentPrompts.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'osade-m2-'));
  process.env.OSADE_HOME = join(dir, 'home');
  repoPath = join(dir, 'repo');
  sh(dir, ['init', '-q', '-b', 'main', 'repo']);
  writeFileSync(join(repoPath, 'README.md'), '# widget\n');
  sh(repoPath, ['add', '-A']);
  sh(repoPath, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

  script = {
    'GET /repos/{owner}/{repo}/issues': [[{ ...ISSUE, html_url: ISSUE.url }]],
    'GET /repos/{owner}/{repo}': [{ permissions: { push: true } }],
    'POST /repos/{owner}/{repo}/pulls': [
      { number: 88, html_url: 'https://github.com/acme/widget/pull/88', head: { sha: 'headsha' } },
    ],
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_AFTER_REVIEW],
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
      [{ state: 'CHANGES_REQUESTED', body: 'Please handle the empty-string case too.' }],
    ],
    'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [
      { check_runs: [{ status: 'completed', conclusion: 'success' }] },
    ],
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': [
      { html_url: 'https://github.com/acme/widget/issues/417#issuecomment-1' },
    ],
  };

  db = openDb(':memory:');
  const scm = new ScmClient({ request, now: () => NOW });
  gates = new Gates(db, { now: () => NOW });
  writer = new ScmWrites(db, scm, gates, { now: () => NOW });
  launcher = new LaunchTask(db, fakeSubstrate, fakeSubscriber, { now: () => NOW });
  triage = new Triage(db, launcher, { now: () => NOW });
  poller = new ScmPoller(db, scm, {
    now: () => NOW,
    sendToAgent: async (_taskId, text) => {
      agentPrompts.push(text);
    },
  });
});

afterEach(() => {
  db.close();
  delete process.env.OSADE_HOME;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // leave it for the OS temp sweeper
  }
});

/** Attaches the GitHub identity the poller and writer need. */
function linkRemote(taskId: string): void {
  const task = getTask(db, taskId)!;
  db.prepare("UPDATE repo SET gh_owner = 'acme', gh_name = 'widget' WHERE id = ?").run(
    task.repo_id,
  );
}

describe('M2 acceptance — the contribution loop', () => {
  it('imports an issue, lands a PR through the gate, and reads back what GitHub says', async () => {
    // 1. Import. §12 — the issue becomes a task carrying its URL.
    const issues = await (async () => {
      const taskId = await triage.importIssue(repoPath, ISSUE);
      linkRemote(taskId);
      return taskId;
    })();
    const taskId = issues;

    expect(getTask(db, taskId)!.origin_kind).toBe('issue');
    expect(getTask(db, taskId)!.origin_ref).toBe(ISSUE.url);
    expect(deriveStatus(getTaskFacts(db, taskId)!, NOW)).toBe('queued');

    // 2. §11.3 — where would this go? Checked before the action is offered.
    const plan = await writer.planFork(taskId);
    expect(plan.viaFork).toBe(false);
    expect(plan.prOwner).toBe('acme');

    // 3. §11.2 — requesting is not writing.
    const payload = {
      title: 'fix: handle an empty config',
      body: `Closes #${ISSUE.number}.`,
      head: plan.head,
      base: plan.prBase,
      draft: false,
    };
    const gateId = await writer.requestGate(taskId, 'gate.pr_open', payload);

    // §6 row 3 — an undecided gate is the loudest thing in the ledger.
    expect(deriveStatus(getTaskFacts(db, taskId)!, NOW)).toBe('awaiting_approval');
    expect(getScmFact(db, taskId)).toBe(null);

    // 4. A human approves those exact bytes, and only then does anything reach GitHub.
    gates.decide(gateId, 'approve');
    const pr = await writer.openPr(taskId, gateId, payload);
    expect(pr.number).toBe(88);

    let facts = getTaskFacts(db, taskId)!;
    expect(facts.scm?.pr_number).toBe(88);
    expect(deriveStatus(facts, NOW)).toBe('pr_open');

    // 5. §11.1 — the poller reads back what GitHub actually says.
    await poller.refreshPr(taskId, 88);

    facts = getTaskFacts(db, taskId)!;
    expect(facts.scm?.checks_state).toBe('success');
    expect(facts.scm?.review_state).toBe('changes_requested');
    // §6 row 5 — a reviewer wants something, so this is back in the needs-you set.
    expect(deriveStatus(facts, NOW)).toBe('review_changes_requested');

    // 6. …and the reviewer's own words reached the agent.
    expect(agentPrompts).toHaveLength(1);
    expect(agentPrompts[0]).toContain('Please handle the empty-string case too.');
    expect(agentPrompts[0]).toContain('Do not push, comment, or update the pull request');
  });

  it('runs a triage task that produces a reproduction and no PR — the wedge', async () => {
    const taskId = await triage.importIssue(repoPath, ISSUE, { triage: 'reproduce' });
    linkRemote(taskId);

    expect(triage.isTriage(taskId)).toBe(true);
    expect(getTask(db, taskId)!.intent).toContain('Do not fix anything');

    // The task terminates in an artifact on disk, not a pull request.
    const artifact = await triage.recordArtifact(
      taskId,
      'reproduce',
      'Reproduces on main at 3f2a1b.',
      '```\n$ widget build\nTypeError: cannot read length of undefined\n```',
      join(dir, 'runs'),
    );

    const evidence = readFileSync(artifact.path, 'utf8');
    expect(evidence).toContain('Reproduces on main');
    expect(evidence).toContain(ISSUE.url);

    // §12 — no PR, ever, for a triage task.
    const facts = getTaskFacts(db, taskId)!;
    expect(facts.scm).toBe(null);
    expect(deriveStatus(facts, NOW)).not.toBe('pr_open');

    // Reporting it back is a public write, so it is gated like any other (§11.2).
    const body = { body: triage.composeComment(artifact, 'steps…') };
    const gateId = await writer.requestGate(taskId, 'gate.issue_comment', body);

    await expect(writer.comment(taskId, gateId, body, { issueNumber: 417 })).rejects.toThrow(
      /has not been decided/,
    );

    gates.decide(gateId, 'approve');
    const posted = await writer.comment(taskId, gateId, body, { issueNumber: 417 });
    expect(posted.url).toContain('issuecomment');

    // §23 q3 — the disclosure survives into what was actually posted.
    expect(body.body).toContain('Produced by an agent through Osade');
  });

  it('a GitHub outage mid-flow changes no facts — §11.1', async () => {
    const taskId = await triage.importIssue(repoPath, ISSUE);
    linkRemote(taskId);

    const payload = {
      title: 't',
      body: 'b',
      head: 'osade/x',
      base: 'main',
      draft: false,
    };
    const gateId = await writer.requestGate(taskId, 'gate.pr_open', payload);
    gates.decide(gateId, 'approve');
    await writer.openPr(taskId, gateId, payload);
    await poller.refreshPr(taskId, 88);

    const before = getScmFact(db, taskId)!;
    expect(before.checks_state).toBe('success');

    // GitHub falls over on the next cycle.
    script['GET /repos/{owner}/{repo}/pulls/{pull_number}'] = [new Error('502 Bad Gateway')];
    await poller.refreshPr(taskId, 88);

    const after = getScmFact(db, taskId)!;
    expect(after.fetch_failed_at).toBe(NOW);
    expect(after.pr_state).toBe(before.pr_state);
    expect(after.checks_state).toBe(before.checks_state);
    expect(after.review_state).toBe(before.review_state);
  });
});
