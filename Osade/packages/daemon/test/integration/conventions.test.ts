import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate, openDb, type Db } from '../../src/db/index.js';
import {
  AUTO_PROMOTE_CONFIDENCE,
  Conventions,
  DECAY_MS,
  MAX_INJECTED_RULES,
  UnciteableRuleError,
  type Evidence,
} from '../../src/knowledge/conventions.js';

const NOW = 1_756_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let now: number;
let conventions: Conventions;

function seedRepo(): void {
  db.prepare('INSERT INTO repo (id, path, default_branch, created_at) VALUES (?, ?, ?, ?)').run(
    'r1',
    '/repo',
    'main',
    NOW,
  );
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    kind: 'review_comment',
    url: 'https://github.com/acme/widget/pull/12#discussion_r1',
    excerpt: 'please split this into two PRs',
    observedAt: NOW - DAY,
    ...overrides,
  };
}

type WriteInput = Parameters<Conventions['write']>[0];

function write(overrides: Partial<WriteInput> = {}): string {
  return conventions.write({
    repoId: 'r1',
    category: 'scope_limits',
    ruleText: 'Keep each pull request to one concern.',
    confidence: 0.9,
    evidence: [evidence()],
    ...overrides,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  seedRepo();
  now = NOW;
  conventions = new Conventions(db, { now: () => now });
});

afterEach(() => {
  db.close();
});

describe('§13.1 INVARIANT — a rule without evidence is not a rule', () => {
  it('rejects a convention with no evidence at write time', () => {
    expect(() => write({ evidence: [] })).toThrow(UnciteableRuleError);
  });

  it('rejects a convention whose evidence has no URL', () => {
    expect(() => write({ evidence: [evidence({ url: '   ' })] })).toThrow(UnciteableRuleError);
  });

  it('leaves nothing behind when it rejects', () => {
    expect(() => write({ evidence: [] })).toThrow();
    const rows = db.prepare('SELECT COUNT(*) AS n FROM convention').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('writes the rule and its evidence atomically', () => {
    const id = write({
      evidence: [
        evidence(),
        evidence({ kind: 'rejected_pr', url: 'https://github.com/acme/widget/pull/19' }),
      ],
    });

    const stored = conventions.get(id);
    expect(stored?.evidence).toHaveLength(2);
    expect(stored?.evidence.map((e) => e.kind)).toEqual(['review_comment', 'rejected_pr']);
    expect(stored?.lifecycle).toBe('candidate');
  });

  it('never lets a stored convention exist without evidence — checked over the whole table', () => {
    write();
    write({ category: 'commit_style', ruleText: 'Write commit subjects in the imperative.' });

    const orphans = db
      .prepare(
        `SELECT c.id FROM convention c
          WHERE NOT EXISTS (SELECT 1 FROM convention_evidence e WHERE e.convention_id = c.id)`,
      )
      .all();
    expect(orphans).toEqual([]);
  });

  it('truncates an over-long excerpt rather than refusing the rule', () => {
    const id = write({ evidence: [evidence({ excerpt: 'x'.repeat(500) })] });
    expect(conventions.get(id)?.evidence[0]?.excerpt).toHaveLength(200);
  });
});

describe('§13.4 lifecycle', () => {
  it('starts every mined rule as a candidate — nothing is injected unreviewed', () => {
    const id = write({ confidence: 0.99 });
    expect(conventions.get(id)?.lifecycle).toBe('candidate');
    expect(conventions.forInjection('r1').injected).toEqual([]);
  });

  it('auto-promotes only at or above the confidence threshold', () => {
    const weak = write({ confidence: AUTO_PROMOTE_CONFIDENCE - 0.01 });
    const strong = write({ confidence: AUTO_PROMOTE_CONFIDENCE });

    expect(conventions.promote(weak, 'confidence')).toBe(false);
    expect(conventions.promote(strong, 'confidence')).toBe(true);
    expect(conventions.get(weak)?.lifecycle).toBe('candidate');
    expect(conventions.get(strong)?.lifecycle).toBe('active');
  });

  it('promotes a low-confidence rule when a human confirms it', () => {
    const id = write({ confidence: 0.2 });
    expect(conventions.promote(id, 'human')).toBe(true);
    expect(conventions.get(id)?.lifecycle).toBe('active');
    expect(conventions.get(id)?.lastConfirmedAt).toBe(NOW);
  });

  it('will not resurrect a rejected rule', () => {
    const id = write({ confidence: 0.95 });
    conventions.reject(id, 'wrong');
    expect(conventions.promote(id, 'confidence')).toBe(false);
    expect(conventions.promote(id, 'human')).toBe(false);
    expect(conventions.get(id)?.lifecycle).toBe('rejected');
  });
});

describe('§13.4 decay', () => {
  it('drops an active rule back to candidate after 180 days unconfirmed', () => {
    const id = write();
    conventions.promote(id, 'confidence');

    now = NOW + DECAY_MS - DAY;
    expect(conventions.decay()).toBe(0);
    expect(conventions.get(id)?.lifecycle).toBe('active');

    now = NOW + DECAY_MS + DAY;
    expect(conventions.decay()).toBe(1);
    expect(conventions.get(id)?.lifecycle).toBe('candidate');
  });

  it('demotes rather than deletes — the evidence survives for a human to re-confirm', () => {
    const id = write();
    conventions.promote(id, 'confidence');
    now = NOW + DECAY_MS + DAY;
    conventions.decay();

    expect(conventions.get(id)?.evidence).toHaveLength(1);
    expect(conventions.get(id)?.retiredReason).toContain('180 days');

    expect(conventions.promote(id, 'human')).toBe(true);
    expect(conventions.get(id)?.lifecycle).toBe('active');
  });

  it('leaves candidates alone — decay is about staleness of active rules', () => {
    write();
    now = NOW + DECAY_MS * 4;
    expect(conventions.decay()).toBe(0);
  });
});

describe('§13.5 injection budget', () => {
  function activeRule(confidence: number, confirmedDaysAgo: number, text: string): string {
    now = NOW - confirmedDaysAgo * DAY;
    const id = write({ confidence, ruleText: text });
    conventions.promote(id, 'human');
    now = NOW;
    return id;
  }

  it('caps at 40 rules and reports the overflow rather than dropping it silently', () => {
    for (let i = 0; i < MAX_INJECTED_RULES + 7; i += 1) {
      activeRule(0.9, 1, `Rule number ${i}.`);
    }

    const { injected, overflow } = conventions.forInjection('r1');
    expect(injected).toHaveLength(MAX_INJECTED_RULES);
    expect(overflow).toBe(7);
  });

  it('ranks by confidence × recency, so a fresh rule beats an old one of equal confidence', () => {
    activeRule(0.9, 400, 'Old but confident.');
    activeRule(0.9, 1, 'Fresh and confident.');

    const [first] = conventions.forInjection('r1').injected;
    expect(first?.ruleText).toBe('Fresh and confident.');
  });

  it('does not let recency alone outrank a much stronger rule', () => {
    activeRule(0.99, 30, 'Strong, a month old.');
    activeRule(0.4, 0, 'Weak, today.');

    const [first] = conventions.forInjection('r1').injected;
    expect(first?.ruleText).toBe('Strong, a month old.');
  });

  it('injects only active rules of the requested repo', () => {
    db.prepare('INSERT INTO repo (id, path, default_branch, created_at) VALUES (?, ?, ?, ?)').run(
      'r2',
      '/other',
      'main',
      NOW,
    );
    const mine = write();
    conventions.promote(mine, 'human');
    const theirs = write({ repoId: 'r2' });
    conventions.promote(theirs, 'human');
    write({ ruleText: 'Still a candidate.' });

    const { injected } = conventions.forInjection('r1');
    expect(injected.map((c) => c.id)).toEqual([mine]);
  });
});

describe('storage', () => {
  it('survives a reopen — conventions are durable, not derived', () => {
    const id = write();
    conventions.promote(id, 'human');

    migrate(db);
    const reread = new Conventions(db, { now: () => now }).get(id);
    expect(reread?.lifecycle).toBe('active');
    expect(reread?.evidence).toHaveLength(1);
  });

  it('deletes evidence with its rule and not before', () => {
    const id = write();
    db.prepare('DELETE FROM convention WHERE id = ?').run(id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM convention_evidence').get() as { n: number };
    expect(left.n).toBe(0);
  });
});
