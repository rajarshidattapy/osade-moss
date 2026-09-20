import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { getTask, getTaskFacts } from '../../src/db/task-repo.js';
import { deriveStatus } from '../../src/domain/derive-status.js';
import { LaunchTask } from '../../src/domain/launch-task.js';
import { Triage, triageBrief } from '../../src/domain/triage.js';
import type { SubstrateClient } from '../../src/substrate/client.js';
import type { SubstrateEventSubscriber } from '../../src/substrate/event-subscriber.js';
import type { ImportableIssue } from '../../src/scm/poller.js';

/**
 * §12 — issue intake and triage.
 *
 * The wedge: a maintainer will accept a bot that saves them 40 minutes of triage long before
 * they accept a bot that adds a PR to their queue. So a triage task must genuinely terminate
 * in an artifact rather than quietly becoming a patch.
 */

const NOW = 1_756_000_000_000;

let dir: string;
let repo: string;
let db: Db;
let launcher: LaunchTask;
let triage: Triage;

const ISSUE: ImportableIssue = {
  number: 417,
  title: 'Crash when the config file is empty',
  body: 'Running `widget build` with an empty config throws a TypeError.',
  url: 'https://github.com/acme/widget/issues/417',
};

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

const fakeSubstrate = { socketPath: '/fake', request: async () => ({}) } as unknown as SubstrateClient;
const fakeSubscriber = {
  watchPane() {},
  unwatchPane() {},
} as unknown as SubstrateEventSubscriber;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osade-triage-'));
  process.env.OSADE_HOME = join(dir, 'home');
  repo = join(dir, 'repo');
  sh(dir, ['init', '-q', '-b', 'main', 'repo']);
  writeFileSync(join(repo, 'README.md'), '# x\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

  db = openDb(':memory:');
  launcher = new LaunchTask(db, fakeSubstrate, fakeSubscriber, { now: () => NOW });
  triage = new Triage(db, launcher, { now: () => NOW });
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

describe('§12 — importing an issue', () => {
  it('creates a task carrying the issue number, body and URL', async () => {
    const taskId = await triage.importIssue(repo, ISSUE);
    const task = getTask(db, taskId)!;

    expect(task.title).toBe('#417 Crash when the config file is empty');
    expect(task.intent).toContain('Running `widget build`');
    expect(task.origin_kind).toBe('issue');
    // The URL is kept so a comment can be posted back to the right place later — behind a
    // gate (§11.2).
    expect(task.origin_ref).toBe(ISSUE.url);
  });

  it('an imported issue starts queued, like any other task', async () => {
    const taskId = await triage.importIssue(repo, ISSUE);
    expect(deriveStatus(getTaskFacts(db, taskId)!, NOW)).toBe('queued');
  });
});

describe('§12 — triage tasks', () => {
  it('marks origin_kind as triage and records which kind', async () => {
    const taskId = await triage.importIssue(repo, ISSUE, { triage: 'reproduce' });

    expect(getTask(db, taskId)!.origin_kind).toBe('triage');
    expect(triage.isTriage(taskId)).toBe(true);
    expect(triage.triageKind(taskId)).toBe('reproduce');
  });

  it('every brief tells the agent to report, not to fix', () => {
    // The failure mode §12 exists to prevent is a triage task that becomes a patch.
    for (const kind of [
      'reproduce',
      'bisect',
      'failing-test',
      'duplicate-check',
      'verify-pr-claim',
    ] as const) {
      expect(triageBrief(kind).toLowerCase()).toMatch(/do not (fix|change)/);
    }
  });

  it('puts the brief into the intent the agent actually receives', async () => {
    const taskId = await triage.importIssue(repo, ISSUE, { triage: 'bisect' });
    const intent = getTask(db, taskId)!.intent;

    expect(intent).toContain('#417');
    expect(intent).toContain('git bisect');
    expect(intent).toContain('Do not fix anything');
  });

  it('an ordinary import carries no triage brief', async () => {
    const taskId = await triage.importIssue(repo, ISSUE);
    expect(getTask(db, taskId)!.intent).not.toContain('Do not fix');
    expect(triage.triageKind(taskId)).toBe(null);
  });
});

describe('§12 — the artifact a triage task terminates in', () => {
  it('writes evidence to disk and records it against the task', async () => {
    const taskId = await triage.importIssue(repo, ISSUE, { triage: 'reproduce' });
    const runs = join(dir, 'runs');

    const artifact = await triage.recordArtifact(
      taskId,
      'reproduce',
      'Reproduces on main at 3f2a1b.',
      '```\n$ widget build\nTypeError: cannot read length of undefined\n```',
      runs,
    );

    const written = readFileSync(artifact.path, 'utf8');
    expect(written).toContain('# Triage: reproduce');
    expect(written).toContain('Reproduces on main at 3f2a1b.');
    expect(written).toContain('TypeError');
    // The issue is cited, so a maintainer reading the artifact knows what it answers.
    expect(written).toContain(ISSUE.url);

    expect(triage.artifactFor(taskId)).toEqual(artifact);
  });

  it('the artifact survives independently of the database', async () => {
    const taskId = await triage.importIssue(repo, ISSUE, { triage: 'reproduce' });
    const artifact = await triage.recordArtifact(taskId, 'reproduce', 'yes', 'log', join(dir, 'runs'));

    // Evidence is what a maintainer reads; it must not vanish with osade.db.
    db.close();
    expect(readFileSync(artifact.path, 'utf8')).toContain('yes');
    db = openDb(':memory:');
  });

  it('a triage task produces no PR — §12', async () => {
    const taskId = await triage.importIssue(repo, ISSUE, { triage: 'reproduce' });
    await triage.recordArtifact(taskId, 'reproduce', 'yes', 'log', join(dir, 'runs'));

    const facts = getTaskFacts(db, taskId)!;
    expect(facts.scm).toBe(null);
    expect(deriveStatus(facts, NOW)).not.toBe('pr_open');
  });

  it('the comment discloses agent authorship, and disclosure survives the body', async () => {
    const taskId = await triage.importIssue(repo, ISSUE, { triage: 'reproduce' });
    const artifact = await triage.recordArtifact(
      taskId,
      'reproduce',
      'Reproduces on main.',
      'steps…',
      join(dir, 'runs'),
    );

    const comment = triage.composeComment(artifact, 'steps…');
    expect(comment).toContain('Reproduces on main.');
    // §23 open question 3 — always disclose. Composed into the body so edit-and-approve
    // cannot quietly drop it.
    expect(comment).toContain('Produced by an agent through Osade');
  });
});
