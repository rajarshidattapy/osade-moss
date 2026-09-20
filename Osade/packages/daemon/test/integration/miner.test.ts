import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { Conventions } from '../../src/knowledge/conventions.js';
import { Miner } from '../../src/knowledge/miner.js';
import type { ModelPort, ModelRequest } from '../../src/knowledge/model.js';
import type { Corpus, PullRequestRecord, RepoDocRecord } from '../../src/knowledge/types.js';

const NOW = 1_756_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * A scripted model. Every threshold in §13.4 is enforced by `miner.ts` over whatever this
 * returns, so the tests below mostly work by having it return something the code must refuse.
 */
class FakeModel implements ModelPort {
  readonly calls: ModelRequest[] = [];

  constructor(
    private readonly handlers: {
      extract?: (req: ModelRequest) => string;
      cluster?: (req: ModelRequest) => string;
      verify?: (req: ModelRequest) => string;
    },
  ) {}

  async complete(req: ModelRequest): Promise<string> {
    this.calls.push(req);
    const handler = this.handlers[req.pass];
    if (!handler) return '{}';
    return handler(req);
  }

  callsTo(pass: ModelRequest['pass']): ModelRequest[] {
    return this.calls.filter((c) => c.pass === pass);
  }
}

let db: Db;

function pr(overrides: Partial<PullRequestRecord> & { number: number }): PullRequestRecord {
  const n = overrides.number;
  return {
    url: `https://github.com/acme/widget/pull/${n}`,
    title: `Change ${n}`,
    body: 'A change.',
    outcome: 'merged',
    author: 'contributor',
    closedAt: NOW - DAY,
    comments: [],
    ...overrides,
  };
}

function comment(n: number, state: 'changes_requested' | 'commented' = 'changes_requested') {
  return {
    url: `https://github.com/acme/widget/pull/${n}#discussion_r1`,
    author: 'maintainer',
    body: 'Please split the refactor out of this pull request.',
    state,
    at: NOW - DAY,
  } as const;
}

function corpus(overrides: Partial<Corpus> = {}): Corpus {
  return {
    repoId: 'r1',
    repoSlug: 'acme/widget',
    pullRequests: [
      pr({ number: 20, outcome: 'closed_unmerged', comments: [comment(20)] }),
      pr({ number: 21, outcome: 'closed_unmerged', comments: [comment(21)] }),
      pr({ number: 10 }),
      pr({ number: 11 }),
      pr({ number: 12, comments: [comment(12)] }),
      pr({ number: 13 }),
    ],
    docs: [],
    ...overrides,
  };
}

/** Emits one observation per PR that has a comment, citing that comment's real URL. */
function extractOne(req: ModelRequest): string {
  const n = Number(/Pull request #(\d+)/.exec(req.user)?.[1] ?? 0);
  if (!req.user.includes('#discussion_r1')) return '{"observations":[]}';
  return JSON.stringify({
    observations: [
      {
        url: `https://github.com/acme/widget/pull/${n}#discussion_r1`,
        quote: 'Please split the refactor out of this pull request.',
        category: 'scope_limits',
        note: 'the reviewer asked for the refactor to be split out',
      },
    ],
  });
}

function clusterAll(req: ModelRequest): string {
  const ids = [...req.user.matchAll(/^(\S+) \[/gm)].map((m) => m[1]);
  return JSON.stringify({
    rules: [
      {
        category: 'scope_limits',
        rule_text: 'Keep each pull request to one concern.',
        rationale: 'Reviewers ask for refactors to be split out.',
        observation_ids: ids,
      },
    ],
  });
}

const verifySupported = () => '{"supported":3,"violated":0,"unknown":0,"notes":null}';

function seedRepo(): void {
  db.prepare('INSERT INTO repo (id, path, default_branch, created_at) VALUES (?, ?, ?, ?)').run(
    'r1',
    '/repo',
    'main',
    NOW,
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  seedRepo();
});

afterEach(() => {
  db.close();
});

describe('§13.4 — three bounded passes, not one mega-prompt', () => {
  it('makes a separate call per pass, in order, each with one job', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    const passes = model.calls.map((c) => c.pass);
    expect(passes.filter((p) => p === 'extract').length).toBeGreaterThan(1);
    expect(passes.indexOf('cluster')).toBeGreaterThan(passes.lastIndexOf('extract') - 1);
    expect(passes.lastIndexOf('cluster')).toBeLessThan(passes.indexOf('verify'));
  });

  it('shows the extract pass exactly one pull request at a time', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    for (const call of model.callsTo('extract')) {
      expect([...call.user.matchAll(/^Pull request #/gm)]).toHaveLength(1);
    }
  });

  it('never shows the clustering pass the raw pull request bodies', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    await new Miner(db, model, { now: () => NOW }).mine(
      corpus({
        pullRequests: [
          pr({ number: 20, outcome: 'closed_unmerged', body: 'SECRET-BODY', comments: [comment(20)] }),
          pr({ number: 21, outcome: 'closed_unmerged', comments: [comment(21)] }),
          pr({ number: 12, comments: [comment(12)] }),
          pr({ number: 13 }),
        ],
      }),
    );

    for (const call of model.callsTo('cluster')) {
      expect(call.user).not.toContain('SECRET-BODY');
    }
  });
});

describe('§13.4 pass 3 — the held-out sample is held out of extraction', () => {
  it('never extracts from the pull requests it verifies against', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    // 4 merged PRs → 1 held out, the newest.
    const extractedFrom = model
      .callsTo('extract')
      .map((c) => Number(/Pull request #(\d+)/.exec(c.user)?.[1]));
    expect(extractedFrom).not.toContain(13);
    expect(model.callsTo('verify')[0]?.user).toContain('#13');
  });

  it('keeps every rejected pull request in the extraction set', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    const extractedFrom = model
      .callsTo('extract')
      .map((c) => Number(/Pull request #(\d+)/.exec(c.user)?.[1]));
    expect(extractedFrom).toContain(20);
    expect(extractedFrom).toContain(21);
  });
});

describe('§13.1 — the model may only cite what it was shown', () => {
  it('drops an observation whose URL was not in the input', async () => {
    const model = new FakeModel({
      extract: () =>
        JSON.stringify({
          observations: [
            {
              url: 'https://github.com/acme/widget/pull/9999#invented',
              quote: 'made up',
              category: 'scope_limits',
              note: 'fabricated',
            },
          ],
        }),
      cluster: clusterAll,
      verify: verifySupported,
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(corpus());
    expect(result.observations).toBe(0);
    expect(result.written).toBe(0);
  });

  it('drops a cluster that cites an observation id that does not exist', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: () =>
        JSON.stringify({
          rules: [
            {
              category: 'scope_limits',
              rule_text: 'Invented rule.',
              rationale: null,
              observation_ids: ['pr9999-0'],
            },
          ],
        }),
      verify: verifySupported,
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(corpus());
    expect(result.candidates).toBe(0);
    expect(result.written).toBe(0);
  });

  it('writes every surviving rule with its evidence attached', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    const conventions = new Conventions(db, { now: () => NOW });
    const [rule] = conventions.list('r1');
    expect(rule?.evidence.length).toBeGreaterThanOrEqual(3);
    expect(rule?.evidence.every((e) => e.url.startsWith('https://github.com/'))).toBe(true);
    // §13.2 — a rejected PR is cited as such.
    expect(rule?.evidence.some((e) => e.kind === 'rejected_pr')).toBe(true);
  });
});

describe('§13.4 pass 2 thresholds — counted, not requested', () => {
  it('refuses a rule supported by fewer than three observations', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(
      corpus({
        pullRequests: [
          pr({ number: 20, outcome: 'closed_unmerged', comments: [comment(20)] }),
          pr({ number: 21, outcome: 'closed_unmerged', comments: [comment(21)] }),
          pr({ number: 13 }),
        ],
      }),
    );

    expect(result.candidates).toBe(1);
    expect(result.belowThreshold).toBe(1);
    expect(result.written).toBe(0);
  });

  it('refuses three observations that all come from one pull request', async () => {
    const model = new FakeModel({
      extract: () =>
        JSON.stringify({
          observations: [0, 1, 2].map((i) => ({
            url: 'https://github.com/acme/widget/pull/20#discussion_r1',
            quote: `point ${i}`,
            category: 'scope_limits',
            note: `the reviewer made point ${i}`,
          })),
        }),
      cluster: clusterAll,
      verify: verifySupported,
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(
      corpus({
        pullRequests: [pr({ number: 20, outcome: 'closed_unmerged', comments: [comment(20)] })],
      }),
    );

    expect(result.observations).toBe(3);
    expect(result.belowThreshold).toBe(1);
    expect(result.written).toBe(0);
  });

  it('accepts a single observation from CI config — mechanically enforced is definitionally true', async () => {
    const doc: RepoDocRecord = {
      kind: 'ci_config',
      path: '.github/workflows/ci.yml',
      url: 'https://github.com/acme/widget/blob/main/.github/workflows/ci.yml',
      content: 'jobs:\n  test:\n    steps:\n      - run: pnpm test\n',
    };

    const model = new FakeModel({
      extract: (req) =>
        req.user.includes('ci.yml')
          ? JSON.stringify({
              observations: [
                {
                  url: doc.url,
                  quote: '- run: pnpm test',
                  category: 'ci_gates',
                  note: 'the test job must pass',
                },
              ],
            })
          : '{"observations":[]}',
      cluster: clusterAll,
      verify: verifySupported,
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(
      corpus({ pullRequests: [pr({ number: 13 })], docs: [doc] }),
    );

    expect(result.written).toBe(1);
    const [rule] = new Conventions(db, { now: () => NOW }).list('r1');
    expect(rule?.evidence[0]?.kind).toBe('ci_config');
  });
});

describe('§13.4 — verification decides promotion', () => {
  it('marks a rule the merged sample contradicts as rejected, and keeps the evidence', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: () => '{"supported":0,"violated":4,"unknown":0,"notes":"merged anyway, repeatedly"}',
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(corpus());
    expect(result.rejected).toBe(1);
    expect(result.written).toBe(0);

    const [rule] = new Conventions(db, { now: () => NOW }).list('r1');
    expect(rule?.lifecycle).toBe('rejected');
    expect(rule?.retiredReason).toBe('merged anyway, repeatedly');
    expect(rule?.evidence.length).toBeGreaterThan(0);
  });

  it('leaves an unverifiable rule as a candidate for a human, rather than activating it', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: () => '{"supported":0,"violated":0,"unknown":4,"notes":null}',
    });

    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    const [rule] = new Conventions(db, { now: () => NOW }).list('r1');
    expect(rule?.lifecycle).toBe('candidate');
    expect(rule?.confidence).toBeLessThan(0.8);
  });

  it('activates a well-evidenced rule the sample supports', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });

    await new Miner(db, model, { now: () => NOW }).mine(corpus());

    const [rule] = new Conventions(db, { now: () => NOW }).list('r1');
    expect(rule?.lifecycle).toBe('active');
    expect(rule?.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe('§13.4 — incremental re-mining', () => {
  it('re-confirms an existing rule instead of duplicating it', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });

    let now = NOW;
    const miner = new Miner(db, model, { now: () => now });
    await miner.mine(corpus());

    now = NOW + 30 * DAY;
    const second = await miner.mine(corpus());

    expect(second.reconfirmed).toBe(1);
    expect(second.written).toBe(0);
    const rules = new Conventions(db, { now: () => now }).list('r1');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.lastConfirmedAt).toBe(now);
  });

  it('re-confirms a paraphrase of the same rule', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: (req) =>
        clusterAll(req).replace(
          'Keep each pull request to one concern.',
          'Keep each pull request scoped to one concern.',
        ),
      verify: verifySupported,
    });

    const conventions = new Conventions(db, { now: () => NOW });
    const existing = conventions.write({
      repoId: 'r1',
      category: 'scope_limits',
      ruleText: 'Keep each pull request to one concern.',
      confidence: 0.85,
      evidence: [
        {
          kind: 'rejected_pr',
          url: 'https://github.com/acme/widget/pull/1',
          observedAt: NOW - 400 * DAY,
        },
      ],
    });

    const result = await new Miner(db, model, { now: () => NOW }).mine(corpus());
    expect(result.reconfirmed).toBe(1);
    expect(conventions.list('r1')).toHaveLength(1);
    expect(conventions.get(existing)?.evidence.length).toBeGreaterThan(1);
  });

  it('records a high-water mark so the next run can start after it', async () => {
    const model = new FakeModel({
      extract: extractOne,
      cluster: clusterAll,
      verify: verifySupported,
    });
    const miner = new Miner(db, model, { now: () => NOW });

    expect(miner.highWaterPr('r1')).toBeNull();
    await miner.mine(corpus());
    expect(miner.highWaterPr('r1')).toBe(21);
  });

  it('does not advance the high-water mark when the run fails', async () => {
    const failing = new FakeModel({
      extract: extractOne,
      cluster: () => 'not json at all',
      verify: verifySupported,
    });
    const miner = new Miner(db, failing, { now: () => NOW });

    const result = await miner.mine(corpus());
    expect(result.error).toContain('cluster');
    expect(miner.highWaterPr('r1')).toBeNull();

    const run = db.prepare('SELECT error, finished_at FROM mine_run').get() as {
      error: string;
      finished_at: number;
    };
    expect(run.error).toBeTruthy();
    expect(run.finished_at).toBe(NOW);
  });

  it('loses one unreadable pull request, not the whole run', async () => {
    const warnings: string[] = [];
    const model = new FakeModel({
      extract: (req) => (req.user.includes('#20') ? 'garbage' : extractOne(req)),
      cluster: clusterAll,
      verify: verifySupported,
    });

    const result = await new Miner(db, model, {
      now: () => NOW,
      onWarning: (m) => warnings.push(m),
    }).mine(corpus());

    expect(warnings.some((w) => w.includes('#20'))).toBe(true);
    expect(result.observations).toBe(2);
    expect(result.error).toBeNull();
  });
});
