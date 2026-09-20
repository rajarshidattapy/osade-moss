import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { HeadlessRuns } from '../../src/domain/headless-run.js';
import { Miner } from '../../src/knowledge/miner.js';
import { Knowledge } from '../../src/knowledge/service.js';
import type { ModelPort, ModelRequest } from '../../src/knowledge/model.js';
import { ScmClient, type ScmRequest } from '../../src/scm/client.js';

const NOW = 1_756_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let db: Db;

const silentModel: ModelPort = {
  async complete(req: ModelRequest) {
    if (req.pass === 'extract') return '{"observations":[]}';
    if (req.pass === 'cluster') return '{"rules":[]}';
    return '{"supported":0,"violated":0,"unknown":0,"notes":null}';
  },
};

function scmClient(handler: (route: string) => unknown = () => []): ScmClient {
  const request: ScmRequest = async (route) => ({
    status: 200,
    headers: {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4900',
      'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 3600),
    },
    data: handler(route),
  });
  return new ScmClient({ request, now: () => NOW });
}

/** A GitHub with two closed pull requests, so extraction has something to park on. */
function prCorpus(route: string): unknown {
  if (route === 'GET /repos/{owner}/{repo}/pulls') {
    return [
      {
        number: 20,
        html_url: 'https://github.com/acme/widget/pull/20',
        title: 'Change 20',
        body: 'body',
        user: { login: 'contributor' },
        merged_at: null,
        closed_at: '2025-08-02T00:00:00Z',
        updated_at: '2025-08-02T00:00:00Z',
      },
      {
        number: 19,
        html_url: 'https://github.com/acme/widget/pull/19',
        title: 'Change 19',
        body: 'body',
        user: { login: 'contributor' },
        merged_at: '2025-08-01T00:00:00Z',
        closed_at: '2025-08-01T00:00:00Z',
        updated_at: '2025-08-01T00:00:00Z',
      },
    ];
  }
  return [];
}

/**
 * Waits for a background run to let go of its repo.
 *
 * The whole point of `startMine` is that nothing awaits it, so a test has to watch the same
 * signal the UI does rather than hold a promise.
 */
async function settle(knowledge: Knowledge, repoId: string): Promise<void> {
  for (let i = 0; i < 200 && knowledge.isRunning(repoId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (knowledge.isRunning(repoId)) throw new Error(`mining run on ${repoId} never finished`);
}

function seedRepo(id: string, owner: string | null, name: string | null): void {
  db.prepare(
    'INSERT INTO repo (id, path, default_branch, gh_owner, gh_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, `/repo-${id}`, 'main', owner, name, NOW);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedRepo('r1', 'acme', 'widget');
});

afterEach(() => {
  db.close();
});

describe('mining availability is reported, not discovered halfway through', () => {
  it('says so when no model is configured', () => {
    const knowledge = new Knowledge(db, scmClient(), null, { now: () => NOW });
    const availability = knowledge.availability('r1');

    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('headless');
  });

  it('is available through a local headless agent, without an API key', () => {
    const headless = new HeadlessRuns(() => null, async () => '{}', () => true);
    const knowledge = new Knowledge(db, scmClient(), null, { now: () => NOW, headless });
    expect(knowledge.availability('r1').available).toBe(true);
  });

  it('says so when there is no GitHub token', () => {
    const knowledge = new Knowledge(db, null, silentModel, { now: () => NOW });
    expect(knowledge.availability('r1').reason).toContain('OSADE_GITHUB_TOKEN');
  });

  it('explains that a repo with no GitHub remote has no review record to mine', () => {
    seedRepo('r2', null, null);
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => NOW });

    const availability = knowledge.availability('r2');
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('no review record to mine');
  });

  it('refuses to mine when it is unavailable, rather than half-running', async () => {
    const knowledge = new Knowledge(db, scmClient(), null, { now: () => NOW });
    await expect(knowledge.mine('r1')).rejects.toThrow(/headless/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mine_run').get()).toEqual({ n: 0 });
  });
});

describe('mining runs in the background — it takes minutes', () => {
  /** A model that parks on the first call, so a run can be observed mid-flight. */
  function parked(): { model: ModelPort; release: () => void; started: Promise<void> } {
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (markStarted = resolve));

    return {
      release,
      started,
      model: {
        async complete(req) {
          markStarted();
          await blocked;
          return silentModel.complete(req);
        },
      },
    };
  }

  it('returns a run id at once rather than holding the caller for the whole run', async () => {
    const { model, release, started } = parked();
    const knowledge = new Knowledge(db, scmClient(prCorpus), model, { now: () => NOW });

    const { runId } = knowledge.startMine('r1');
    expect(runId).toMatch(/^mr_/);

    await started;
    expect(knowledge.isRunning('r1')).toBe(true);

    release();
    await settle(knowledge, 'r1');
  });

  it('records the run before any work happens, so a poll sees it immediately', () => {
    const { model } = parked();
    const knowledge = new Knowledge(db, scmClient(prCorpus), model, { now: () => NOW });

    const { runId } = knowledge.startMine('r1');

    const run = knowledge.lastRun('r1');
    expect(run?.id).toBe(runId);
    expect(run?.phase).toBe('fetching');
    expect(run?.finishedAt).toBeNull();
  });

  it('reports which pass it is in and how far through', async () => {
    const { model, release, started } = parked();
    const knowledge = new Knowledge(db, scmClient(prCorpus), model, { now: () => NOW });

    knowledge.startMine('r1');
    await started;

    const run = knowledge.lastRun('r1');
    expect(run?.phase).toBe('extracting');
    expect(run?.progressTotal).toBeGreaterThan(0);

    release();
    await settle(knowledge, 'r1');
    expect(knowledge.lastRun('r1')?.finishedAt).toBe(NOW);
  });

  it('refuses a second run while one is in flight', async () => {
    const { model, release, started } = parked();
    const knowledge = new Knowledge(db, scmClient(prCorpus), model, { now: () => NOW });

    knowledge.startMine('r1');
    await started;
    expect(() => knowledge.startMine('r1')).toThrow(/already in progress/);

    release();
    await settle(knowledge, 'r1');
  });

  it('cannot be started twice in the same tick', () => {
    const { model } = parked();
    const knowledge = new Knowledge(db, scmClient(prCorpus), model, { now: () => NOW });

    knowledge.startMine('r1');
    expect(() => knowledge.startMine('r1')).toThrow(/already in progress/);
  });

  it('records a background failure durably — there is no caller to throw at', async () => {
    // GitHub failing outright, rather than a model failing on one PR: an extract failure is a
    // per-PR warning by design, so it is the fetch that can take a whole run down.
    const brokenGitHub = scmClient(() => {
      throw Object.assign(new Error('502 Bad Gateway'), { status: 502 });
    });
    const knowledge = new Knowledge(db, brokenGitHub, silentModel, { now: () => NOW });

    knowledge.startMine('r1');
    await settle(knowledge, 'r1');

    const run = knowledge.lastRun('r1');
    expect(run?.finishedAt).toBe(NOW);
    expect(run?.error).toContain('502');
    expect(knowledge.isRunning('r1')).toBe(false);
    // And a failed run leaves the next one free to start.
    expect(knowledge.availability('r1').available).toBe(true);
  });

  it('does not advance the high-water mark past pull requests a failed run never read', async () => {
    const brokenGitHub = scmClient(() => {
      throw Object.assign(new Error('502 Bad Gateway'), { status: 502 });
    });
    const knowledge = new Knowledge(db, brokenGitHub, silentModel, { now: () => NOW });

    knowledge.startMine('r1');
    await settle(knowledge, 'r1');

    expect(new Miner(db, silentModel, { now: () => NOW }).highWaterPr('r1')).toBeNull();
  });
});

describe('a run whose daemon died', () => {
  it('is marked interrupted at startup rather than looking live forever', () => {
    db.prepare('INSERT INTO mine_run (id, repo_id, started_at, phase) VALUES (?, ?, ?, ?)').run(
      'mr_orphan',
      'r1',
      NOW - DAY,
      'extracting',
    );

    const warnings: string[] = [];
    const knowledge = new Knowledge(db, scmClient(), silentModel, {
      now: () => NOW,
      onWarning: (m) => warnings.push(m),
    });

    const run = knowledge.lastRun('r1');
    expect(run?.phase).toBe('interrupted');
    expect(run?.finishedAt).toBe(NOW);
    expect(run?.error).toContain('daemon stopped');
    expect(warnings.some((w) => w.includes('did not finish'))).toBe(true);
    // And the button works again.
    expect(knowledge.availability('r1').available).toBe(true);
  });

  it('does not let the interrupted run advance the high-water mark', () => {
    db.prepare(
      'INSERT INTO mine_run (id, repo_id, started_at, high_water_pr) VALUES (?, ?, ?, ?)',
    ).run('mr_orphan', 'r1', NOW - DAY, 900);

    new Knowledge(db, scmClient(), silentModel, { now: () => NOW });

    const miner = new Miner(db, silentModel, { now: () => NOW });
    expect(miner.highWaterPr('r1')).toBeNull();
  });
});

describe('§13.4 — weekly re-mine, offered rather than performed', () => {
  function completedRun(finishedAt: number, error: string | null = null): void {
    db.prepare(
      'INSERT INTO mine_run (id, repo_id, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?)',
    ).run(`mr_${finishedAt}`, 'r1', finishedAt - 1000, finishedAt, error);
  }

  it('a repo nobody has mined is not overdue', () => {
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => NOW });
    expect(knowledge.dueForRemine('r1')).toBe(false);
  });

  it('is not due within the week', () => {
    completedRun(NOW - 6 * DAY);
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => NOW });
    expect(knowledge.dueForRemine('r1')).toBe(false);
  });

  it('is due after a week', () => {
    completedRun(NOW - 8 * DAY);
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => NOW });
    expect(knowledge.dueForRemine('r1')).toBe(true);
  });

  it('does not count a failed run as having mined anything', () => {
    completedRun(NOW - 10 * DAY);
    completedRun(NOW - DAY, 'boom');
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => NOW });
    expect(knowledge.dueForRemine('r1')).toBe(true);
  });

  it('never starts a run on its own — mining spends real money', async () => {
    completedRun(NOW - 30 * DAY);
    let calls = 0;
    const counting: ModelPort = {
      async complete(req) {
        calls += 1;
        return silentModel.complete(req);
      },
    };

    const knowledge = new Knowledge(db, scmClient(prCorpus), counting, { now: () => NOW });
    expect(knowledge.dueForRemine('r1')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
    expect(knowledge.isRunning('r1')).toBe(false);
  });
});

describe('one run at a time', () => {
  it('refuses a second concurrent run on the same repo', async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));

    const slowModel: ModelPort = {
      async complete(req) {
        await blocked;
        return silentModel.complete(req);
      },
    };

    const knowledge = new Knowledge(db, scmClient(() => []), slowModel, { now: () => NOW });
    const first = knowledge.mine('r1');

    expect(knowledge.isRunning('r1')).toBe(true);
    await expect(knowledge.mine('r1')).rejects.toThrow(/already in progress/);

    release();
    await first;
    expect(knowledge.isRunning('r1')).toBe(false);
  });

  it('clears the guard when a run throws', async () => {
    const angryModel: ModelPort = {
      async complete() {
        throw new Error('boom');
      },
    };
    const knowledge = new Knowledge(db, scmClient(), angryModel, { now: () => NOW });

    await knowledge.mine('r1');
    expect(knowledge.isRunning('r1')).toBe(false);
  });
});

describe('decay runs before mining, not after', () => {
  it('demotes a stale rule rather than letting the run silently renew it', async () => {
    let now = NOW;
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => now });

    const id = knowledge.conventions.write({
      repoId: 'r1',
      category: 'commit_style',
      ruleText: 'Sign every commit off.',
      confidence: 0.9,
      evidence: [
        { kind: 'doc', url: 'https://github.com/acme/widget/blob/main/CONTRIBUTING.md', observedAt: NOW },
      ],
    });
    knowledge.conventions.promote(id, 'confidence');

    now = NOW + 200 * DAY;
    const warnings: string[] = [];
    const watching = new Knowledge(db, scmClient(), silentModel, {
      now: () => now,
      onWarning: (m) => warnings.push(m),
    });
    await watching.mine('r1');

    expect(watching.conventions.get(id)?.lifecycle).toBe('candidate');
    expect(warnings.some((w) => w.includes('180 days'))).toBe(true);
  });
});

describe('what the UI reads', () => {
  it('lists candidates first — those are the ones asking for a decision', () => {
    const knowledge = new Knowledge(db, scmClient(), silentModel, { now: () => NOW });
    const evidence = [
      { kind: 'ci_config' as const, url: 'https://github.com/acme/widget/ci.yml', observedAt: NOW },
    ];

    const active = knowledge.conventions.write({
      repoId: 'r1',
      category: 'ci_gates',
      ruleText: 'Keep CI green.',
      confidence: 0.9,
      evidence,
    });
    knowledge.conventions.promote(active, 'confidence');
    knowledge.conventions.write({
      repoId: 'r1',
      category: 'commit_style',
      ruleText: 'Sign your commits.',
      confidence: 0.4,
      evidence,
    });

    expect(knowledge.list('r1').map((c) => c.lifecycle)).toEqual(['candidate', 'active']);
  });

  it('reports the last run, including a failed one', async () => {
    const brokenModel: ModelPort = {
      async complete(req) {
        return req.pass === 'cluster' ? 'nonsense' : silentModel.complete(req);
      },
    };
    const knowledge = new Knowledge(db, scmClient(), brokenModel, { now: () => NOW });
    await knowledge.mine('r1');

    const last = knowledge.lastRun('r1');
    expect(last?.startedAt).toBe(NOW);
    expect(last?.finishedAt).toBe(NOW);
  });
});
