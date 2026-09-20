import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { getScmFact, getTaskFacts } from '../../src/db/task-repo.js';
import { deriveStatus } from '../../src/domain/derive-status.js';
import { ScmClient, type ScmRequest } from '../../src/scm/client.js';
import { ScmPoller } from '../../src/scm/poller.js';

/**
 * §11.1 — polling, ETags, rate limits, and the invariant that matters most:
 * **a failed fetch is a fact, not a state change.**
 *
 * Recorded fixtures rather than the network (§20.2). A test that needs GitHub to be up is a
 * test that will fail for reasons that have nothing to do with Osade.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let clock = NOW;

/** A scripted GitHub. Each route returns the next queued response. */
function recorded(script: Record<string, unknown[]>): {
  request: ScmRequest;
  calls: string[];
  headers: Record<string, string | undefined>;
} {
  const state = {
    calls: [] as string[],
    headers: {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4900',
      'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 3600),
    } as Record<string, string | undefined>,
  };

  const request: ScmRequest = async (route) => {
    state.calls.push(route);
    const queue = script[route];
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];

    if (next instanceof Error) throw next;
    if (next === 304) return { status: 304, headers: state.headers, data: null };
    return { status: 200, headers: state.headers, data: next };
  };

  return { ...state, request, get headers() {
    return state.headers;
  } };
}

const PR_OPEN = {
  number: 7,
  html_url: 'https://github.com/acme/widget/pull/7',
  state: 'open',
  merged: false,
  draft: false,
  mergeable_state: 'clean',
  head: { sha: 'abc123' },
};

function seed(): void {
  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?,?,?)').run('o1', 'acme', NOW);
  db.prepare(
    `INSERT INTO repo (id, org_id, path, gh_owner, gh_name, default_branch, created_at)
     VALUES ('r1','o1','/repo','acme','widget','main',?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, base_ref, base_sha, branch,
                       worktree_path, created_at)
     VALUES ('t1','r1','fix','x','manual','main','base','osade/fix','/wt',?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO scm_fact (task_id, pr_number, pr_state, unresolved_threads, fetched_at)
     VALUES ('t1', 7, 'open', 0, ?)`,
  ).run(NOW - 60_000);
}

beforeEach(() => {
  clock = NOW;
  db = openDb(':memory:');
  seed();
});

afterEach(() => db.close());

describe('§11.1 — reads', () => {
  it('writes PR, checks and review facts from one poll', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [{ state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z' }],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [
        { check_runs: [{ status: 'completed', conclusion: 'success' }] },
      ],
    });
    const poller = new ScmPoller(db, new ScmClient({ request: gh.request }), { now: () => clock });

    expect(await poller.pollOpenPrs()).toBe(1);

    const fact = getScmFact(db, 't1')!;
    expect(fact.pr_state).toBe('open');
    expect(fact.pr_head_sha).toBe('abc123');
    expect(fact.checks_state).toBe('success');
    expect(fact.review_state).toBe('approved');
    expect(fact.mergeable).toBe('clean');
    expect(fact.fetch_failed_at).toBe(null);
  });

  it('sends a conditional request once it has an ETag', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN, 304],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [[]],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    gh.headers.etag = 'W/"abc"';

    const client = new ScmClient({ request: gh.request });
    const poller = new ScmPoller(db, client, { now: () => clock });

    await poller.refreshPr('t1', 7);
    // A 304 is a successful poll with nothing new: `fetched_at` moves, facts do not.
    const before = getScmFact(db, 't1')!;
    clock = NOW + 1000;
    expect(await poller.refreshPr('t1', 7)).toBe(false);

    const after = getScmFact(db, 't1')!;
    expect(after.fetched_at).toBeGreaterThan(before.fetched_at);
    expect(after.pr_head_sha).toBe(before.pr_head_sha);
    expect(after.fetch_failed_at).toBe(null);
  });

  it('INVARIANT: a failed fetch is a fact, not a state change', async () => {
    // Establish good facts first.
    const good = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [[{ state: 'APPROVED' }]],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [
        { check_runs: [{ status: 'completed', conclusion: 'success' }] },
      ],
    });
    await new ScmPoller(db, new ScmClient({ request: good.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    const before = getScmFact(db, 't1')!;
    expect(before.checks_state).toBe('success');

    // Now GitHub falls over.
    const bad = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [new Error('502 Bad Gateway')],
    });
    clock = NOW + 30_000;
    const warnings: string[] = [];
    const failing = new ScmPoller(db, new ScmClient({ request: bad.request }), {
      now: () => clock,
      onWarning: (m) => warnings.push(m),
    });

    expect(await failing.refreshPr('t1', 7)).toBe(false);

    const after = getScmFact(db, 't1')!;
    // Only fetch_failed_at moved. A 502 must not read as a closed PR, failing checks, or a
    // withdrawn review.
    expect(after.fetch_failed_at).toBe(NOW + 30_000);
    expect(after.pr_state).toBe(before.pr_state);
    expect(after.checks_state).toBe(before.checks_state);
    expect(after.review_state).toBe(before.review_state);
    expect(after.pr_head_sha).toBe(before.pr_head_sha);
    expect(warnings.join()).toContain('PR poll failed');
  });

  it('a failed fetch does not change derived status either', async () => {
    const bad = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [new Error('network down')],
    });
    const poller = new ScmPoller(db, new ScmClient({ request: bad.request }), { now: () => clock });

    const before = deriveStatus(getTaskFacts(db, 't1')!, clock);
    await poller.refreshPr('t1', 7);
    expect(deriveStatus(getTaskFacts(db, 't1')!, clock)).toBe(before);
  });

  it('reads checks as pending while any run is incomplete, failure if any failed', async () => {
    const mixed = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [[]],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [
        {
          check_runs: [
            { status: 'completed', conclusion: 'success' },
            { status: 'in_progress', conclusion: null },
          ],
        },
      ],
    });
    await new ScmPoller(db, new ScmClient({ request: mixed.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);
    expect(getScmFact(db, 't1')!.checks_state).toBe('pending');

    const failed = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [[]],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [
        {
          check_runs: [
            { status: 'completed', conclusion: 'success' },
            { status: 'completed', conclusion: 'failure' },
          ],
        },
      ],
    });
    await new ScmPoller(db, new ScmClient({ request: failed.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    expect(getScmFact(db, 't1')!.checks_state).toBe('failure');
    expect(deriveStatus(getTaskFacts(db, 't1')!, clock)).toBe('ci_failed');
  });

  it('an approval after a change request clears the needs-you state', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        // Chronological: the reviewer asked, then was satisfied.
        [{ state: 'CHANGES_REQUESTED' }, { state: 'APPROVED' }],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    expect(getScmFact(db, 't1')!.review_state).toBe('approved');
    expect(getScmFact(db, 't1')!.unresolved_threads).toBe(0);
    expect(deriveStatus(getTaskFacts(db, 't1')!, clock)).toBe('pr_open');
  });

  it("one reviewer's approval does not clear another reviewer's request", async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [
          { state: 'CHANGES_REQUESTED', user: { login: 'ada' } },
          { state: 'APPROVED', user: { login: 'grace' } },
        ],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    // Ada is still waiting. Dropping this task out of the needs-you set because someone else
    // approved is how a maintainer's request gets silently abandoned.
    expect(getScmFact(db, 't1')!.review_state).toBe('changes_requested');
    expect(getScmFact(db, 't1')!.unresolved_threads).toBe(1);
    expect(deriveStatus(getTaskFacts(db, 't1')!, clock)).toBe('review_changes_requested');
  });

  it('counts reviewers who are still asking, not review rows', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [
          { state: 'CHANGES_REQUESTED', user: { login: 'ada' } },
          { state: 'CHANGES_REQUESTED', user: { login: 'ada' } },
          { state: 'CHANGES_REQUESTED', user: { login: 'grace' } },
          { state: 'APPROVED', user: { login: 'alan' } },
        ],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    // Two people are waiting, not four reviews and not one boolean.
    expect(getScmFact(db, 't1')!.unresolved_threads).toBe(2);
  });

  it('a dismissed review stops counting against the task', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [
          { state: 'CHANGES_REQUESTED', user: { login: 'ada' } },
          { state: 'DISMISSED', user: { login: 'ada' } },
        ],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    expect(getScmFact(db, 't1')!.unresolved_threads).toBe(0);
    expect(getScmFact(db, 't1')!.review_state).toBe('none');
  });

  it('a later comment does not withdraw an outstanding request', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [
          { state: 'CHANGES_REQUESTED', user: { login: 'ada' } },
          // GitHub: a COMMENTED review carries no verdict and leaves the standing one alone.
          { state: 'COMMENTED', user: { login: 'ada' } },
        ],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
    }).refreshPr('t1', 7);

    expect(getScmFact(db, 't1')!.review_state).toBe('changes_requested');
    expect(getScmFact(db, 't1')!.unresolved_threads).toBe(1);
  });
});

describe('§11.1 — rate limits', () => {
  it('backs off below 20% remaining rather than waiting to be told off', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [[]],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    gh.headers['x-ratelimit-remaining'] = '400'; // 8% of 5000

    const client = new ScmClient({ request: gh.request, now: () => clock });
    const warnings: string[] = [];
    const poller = new ScmPoller(db, client, { now: () => clock, onWarning: (m) => warnings.push(m) });

    await poller.refreshPr('t1', 7);
    expect(client.shouldBackOff).toBe(true);

    const callsBefore = gh.calls.length;
    expect(await poller.pollOpenPrs()).toBe(0);
    expect(gh.calls.length).toBe(callsBefore);
    expect(warnings.join()).toContain('rate limit');
  });

  it('does not back off with plenty of budget', async () => {
    const gh = recorded({ 'GET /repos/{owner}/{repo}': [{ permissions: { push: true } }] });
    const client = new ScmClient({ request: gh.request, now: () => clock });
    await client.get('GET /repos/{owner}/{repo}', { owner: 'a', repo: 'b' });
    expect(client.shouldBackOff).toBe(false);
  });
});

describe('§11.1 — issue list', () => {
  it('returns issues and never pull requests', async () => {
    const gh = recorded({
      'GET /repos/{owner}/{repo}/issues': [
        [
          { number: 1, title: 'a bug', body: 'it breaks', html_url: 'u1' },
          { number: 2, title: 'a PR', body: '', html_url: 'u2', pull_request: { url: 'x' } },
        ],
      ],
    });
    const poller = new ScmPoller(db, new ScmClient({ request: gh.request }), { now: () => clock });

    const issues = await poller.pollIssues('r1');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.number).toBe(1);
  });

  it('a failed issue poll yields nothing rather than throwing', async () => {
    const gh = recorded({ 'GET /repos/{owner}/{repo}/issues': [new Error('403')] });
    const warnings: string[] = [];
    const poller = new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
      onWarning: (m) => warnings.push(m),
    });

    await expect(poller.pollIssues('r1')).resolves.toEqual([]);
    expect(warnings.join()).toContain('issue poll failed');
  });
});

describe('§21 M2 — review feedback loops back into the agent lane', () => {
  const changesRequested = {
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN, PR_OPEN],
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
      [{ state: 'CHANGES_REQUESTED', body: 'Please add a test for the null case.' }],
    ],
    'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
  };

  it("hands the reviewer's own words to the agent", async () => {
    const sent: { taskId: string; text: string }[] = [];
    const gh = recorded(changesRequested);
    const poller = new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
      sendToAgent: async (taskId, text) => {
        sent.push({ taskId, text });
      },
    });

    await poller.refreshPr('t1', 7);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.taskId).toBe('t1');
    expect(sent[0]!.text).toContain('Please add a test for the null case.');
    expect(sent[0]!.text).toContain('https://github.com/acme/widget/pull/7');
    // §14 — the agent never performs a gated action itself.
    expect(sent[0]!.text).toContain('Do not push, comment, or update the pull request');
  });

  it('does not replay a request the reviewer has already withdrawn', async () => {
    const sent: string[] = [];
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [PR_OPEN, PR_OPEN],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [
          // Ada asked, then was satisfied. Grace is the one still waiting.
          { state: 'CHANGES_REQUESTED', body: 'Rename this module.', user: { login: 'ada' } },
          { state: 'APPROVED', body: 'Looks good now.', user: { login: 'ada' } },
          { state: 'CHANGES_REQUESTED', body: 'Add a test for null.', user: { login: 'grace' } },
        ],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });

    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
      sendToAgent: async (_taskId, text) => {
        sent.push(text);
      },
    }).refreshPr('t1', 7);

    expect(sent).toHaveLength(1);
    expect(sent[0]!).toContain('Add a test for null.');
    // Re-fixing something already accepted spends the agent's turn for nothing.
    expect(sent[0]!).not.toContain('Rename this module.');
  });

  it('delivers once on the transition, not on every poll', async () => {
    const sent: string[] = [];
    const gh = recorded(changesRequested);
    const poller = new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
      sendToAgent: async (_taskId, text) => {
        sent.push(text);
      },
    });

    await poller.refreshPr('t1', 7);
    await poller.refreshPr('t1', 7);

    // A reviewer who asked once should not be re-delivered every 30 seconds.
    expect(sent).toHaveLength(1);
  });

  it('does not send into a fork when no lane is on the PR branch', async () => {
    const sent: string[] = [];
    const gh = recorded({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': [
        { ...PR_OPEN, head: { sha: 'abc123', ref: 'feat/review' } },
      ],
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [
        [{ state: 'CHANGES_REQUESTED', body: 'Please add a test for the null case.' }],
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': [{ check_runs: [] }],
    });
    await new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
      sendToAgent: async (_taskId, text) => {
        sent.push(text);
      },
    }).refreshPr('t1', 7);

    expect(sent).toHaveLength(0);
    expect(getScmFact(db, 't1')!.review_state).toBe('changes_requested');
    expect(getScmFact(db, 't1')!.pr_head_ref).toBe('feat/review');
  });

  it('an undeliverable prompt degrades the loop, not the facts', async () => {
    const gh = recorded(changesRequested);
    const warnings: string[] = [];
    const poller = new ScmPoller(db, new ScmClient({ request: gh.request }), {
      now: () => clock,
      onWarning: (m) => warnings.push(m),
      sendToAgent: async () => {
        throw new Error('no live agent pane');
      },
    });

    expect(await poller.refreshPr('t1', 7)).toBe(true);
    expect(getScmFact(db, 't1')!.review_state).toBe('changes_requested');
    expect(deriveStatus(getTaskFacts(db, 't1')!, clock)).toBe('review_changes_requested');
    expect(warnings.join()).toContain('could not deliver review feedback');
  });
});
