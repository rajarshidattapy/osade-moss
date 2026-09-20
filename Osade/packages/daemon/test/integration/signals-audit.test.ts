import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { auditExport, toCsv, toJsonl } from '../../src/domain/audit.js';
import { Gates } from '../../src/domain/gates.js';
import { PrSignals, summariseDiff } from '../../src/scm/signals.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * P7 — slop signals (§M.7.5) and the audit export (§M.8.4).
 *
 * The two invariants under test:
 *
 *   **A2: signals are never acted on publicly without a gate.** Asserted structurally — after a
 *   duplicate is detected, nothing has been written to GitHub and no gate exists.
 *
 *   **§M.8.4: nothing in the export is computed by a model.** Asserted by checking that every
 *   value in a row traces to a stored fact, and that the export is byte-identical when run
 *   twice over the same window.
 */

const NOW = 1_756_000_000_000;

let db: Db;
let signals: PrSignals;
let retrieval: RetrievalService;

const DIFF_A = [
  '--- a/src/client.ts',
  '+++ b/src/client.ts',
  '@@ -10,3 +10,3 @@',
  ' export function go(q) {',
  '-  return client.search(q);',
  '+  return client.query(q, {});',
  ' }',
].join('\n');

/** The same change, different local names — what two agents solving one issue produce. */
const DIFF_B = [
  '--- a/src/client.ts',
  '+++ b/src/client.ts',
  '@@ -10,3 +10,3 @@',
  ' export function go(term) {',
  '-  return conn.search(term);',
  '+  return conn.query(term, {});',
  ' }',
].join('\n');

const DIFF_UNRELATED = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,2 @@',
  '-# Old title',
  '+# New title',
].join('\n');

function pr(number: number, diff: string, title = 'Migrate the SDK'): Parameters<PrSignals['record']>[0] {
  return {
    repoId: 'r1',
    number,
    author: number % 2 === 0 ? 'sam' : 'priya',
    title,
    body: 'This migrates the SDK to v2.',
    headSha: `head${number}`,
    openedAt: NOW + number,
    diff,
  };
}

beforeEach(async () => {
  db = openDb(':memory:');
  db.prepare(
    'INSERT INTO repo (id, org_id, path, gh_owner, gh_name, default_branch, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
  ).run('r1', '/repo', 'acme', 'web', 'main', NOW);
  retrieval = await RetrievalService.open(db, { port: new Fts5Adapter(db), onWarning: () => {} });
  signals = new PrSignals(db, retrieval, { now: () => NOW });
});

afterEach(() => {
  db.close();
});

describe('§M.7.5 — the structural summary', () => {
  it('indexes files and normalised hunk hashes, never the raw diff', () => {
    const summary = summariseDiff(DIFF_A);
    expect(summary.text).toContain('files: src/client.ts');
    expect(summary.hashes).toHaveLength(1);
    // Raw diff lines are not in what gets indexed: too large, and dominated by context lines
    // that are identical across unrelated changes.
    expect(summary.text).not.toContain('client.search');
  });

  it('gives the same change the same hash despite different local names', () => {
    // Reusing F1's α-renaming: "the same change" means the same thing whether Osade produced
    // it or a stranger did.
    expect(summariseDiff(DIFF_A).hashes).toEqual(summariseDiff(DIFF_B).hashes);
  });

  it('keeps unrelated changes apart', () => {
    expect(summariseDiff(DIFF_A).hashes).not.toEqual(summariseDiff(DIFF_UNRELATED).hashes);
  });
});

describe('§M.7.6 criterion 4 — near-duplicate detection', () => {
  it('flags two PRs with the same normalised hunks', async () => {
    await signals.record(pr(411, DIFF_A));
    await retrieval.indexer.drain();
    await signals.record(pr(412, DIFF_B, 'Update SDK usage'));

    const stored = signals.signalsFor('r1', 412);
    const duplicate = stored.find((signal) => signal.kind === 'near_duplicate');
    expect(duplicate, 'the second PR should be flagged against the first').toBeDefined();
    expect(duplicate!.related_pr).toBe(411);
    expect(duplicate!.score).toBeGreaterThan(0);
  });

  it('does not flag an unrelated PR', async () => {
    await signals.record(pr(411, DIFF_A));
    await retrieval.indexer.drain();
    await signals.record(pr(500, DIFF_UNRELATED, 'Fix a typo in the README'));

    expect(signals.signalsFor('r1', 500).filter((s) => s.kind === 'near_duplicate')).toEqual([]);
  });

  it('never compares a PR with itself', async () => {
    await signals.record(pr(411, DIFF_A));
    await retrieval.indexer.drain();
    await signals.record(pr(411, DIFF_A));
    expect(signals.signalsFor('r1', 411).filter((s) => s.related_pr === 411)).toEqual([]);
  });

  it('INVARIANT A2 — nothing is written to GitHub and no gate is created', async () => {
    await signals.record(pr(411, DIFF_A));
    await retrieval.indexer.drain();
    await signals.record(pr(412, DIFF_B));

    // A duplicate was detected. Nothing followed from it except a row: no auto-close, no
    // auto-label, no comment. A maintainer replying goes through `gate.pr_comment`.
    expect(signals.signalsFor('r1', 412).length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM gate_request').get()).toEqual({ n: 0 });
  });

  it('records a score, and the type has nowhere to put a verdict', async () => {
    await signals.record(pr(411, DIFF_A));
    await retrieval.indexer.drain();
    await signals.record(pr(412, DIFF_B));

    const row = signals.triage('r1').find((candidate) => candidate.number === 412)!;
    // "similar to #411 (0.91)" — the score is shown beside the link. Two people solving the
    // same issue is the normal outcome of an open tracker, not misconduct.
    expect(row.similar_to).toContain(411);
    expect(row.top_score).toBeGreaterThan(0);
    expect(Object.keys(row)).not.toContain('spam');
  });
});

describe('§M.7.5 — triage ordering', () => {
  it('puts attested first, then unique, then duplicates', async () => {
    await signals.record(pr(401, DIFF_UNRELATED, 'Docs tweak'));
    await retrieval.indexer.drain();
    await signals.record(pr(402, DIFF_A));
    await retrieval.indexer.drain();
    await signals.record(pr(403, DIFF_B));
    signals.recordAttestation('r1', 403, 'valid');

    const order = signals.triage('r1').map((row) => row.number);
    expect(order[0]).toBe(403);
    // 402 and 401 follow; 402 is a duplicate of 403 so it sorts last.
    expect(order).toContain(401);
    expect(order.indexOf(401)).toBeLessThan(order.indexOf(402));
  });

  it('keeps one attestation verdict per PR', () => {
    signals.recordAttestation('r1', 410, 'valid');
    signals.recordAttestation('r1', 410, 'stale');

    const kinds = signals.signalsFor('r1', 410).map((signal) => signal.kind);
    // Showing "attested" next to "stale" would mean neither.
    expect(kinds).toEqual(['attestation_stale']);
  });

  it('distinguishes stale from invalid in the triage row', () => {
    signals.recordAttestation('r1', 420, 'stale');
    signals.recordAttestation('r1', 421, 'invalid');
    db.prepare(
      `INSERT INTO pr_record (id, repo_id, number, author, title, body_excerpt, diff_summary,
                              head_sha, opened_at, fetched_at)
       VALUES ('a', 'r1', 420, 'x', 't', '', '', 'h', ?, ?), ('b', 'r1', 421, 'x', 't', '', '', 'h', ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);

    const rows = new Map(signals.triage('r1').map((row) => [row.number, row]));
    expect(rows.get(420)).toMatchObject({ stale: true, invalid: false, attested: false });
    expect(rows.get(421)).toMatchObject({ stale: false, invalid: true, attested: false });
  });
});

describe('§M.8.4 — the audit export', () => {
  function seedGate(): string {
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, created_at)
       VALUES ('t1', 'r1', 'x', 'x', 'manual', 'c1', 'main', 'base', 'osade/x', '/wt', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr1', 't1', 'test', 'pnpm test', ?, ?, 0, 1, 'headaaa', '/logs/vr1')`,
    ).run(NOW, NOW + 5);

    const gates = new Gates(db, { now: () => NOW });
    const id = gates.request({
      taskId: 't1',
      gate: 'gate.pr_open',
      payload: { title: 'x', body: 'y', head_sha: 'headaaa' },
    });
    gates.decide(id, 'approve', 'github:priya');
    return id;
  }

  it('is one row per decision, with who approved what', () => {
    const gateId = seedGate();
    const [row] = auditExport(db, { since: 0 });

    expect(row).toMatchObject({
      gate_id: gateId,
      gate: 'gate.pr_open',
      repo: 'acme/web',
      decision: 'approve',
      decided_by: 'github:priya',
      head_sha: 'headaaa',
    });
    expect(row!.verification).toEqual([{ step: 'test', cmd: 'pnpm test', exit: 0 }]);
  });

  it('cites only verification for the commit that was approved', () => {
    seedGate();
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr_other', 't1', 'lint', 'pnpm lint', ?, ?, 1, 1, 'otherhead', '/logs/x')`,
    ).run(NOW, NOW + 6);

    const [row] = auditExport(db, { since: 0 });
    // Runs at another head verified other code. Including them would let an export claim
    // checks that never ran against what was approved.
    expect(row!.verification.map((v) => v.step)).toEqual(['test']);
  });

  it('is deterministic — the same window twice gives the same bytes', () => {
    seedGate();
    expect(toJsonl(auditExport(db, { since: 0 }))).toBe(toJsonl(auditExport(db, { since: 0 })));
  });

  it('respects the window and the repo filter', () => {
    seedGate();
    expect(auditExport(db, { since: NOW + 1000 })).toEqual([]);
    expect(auditExport(db, { since: 0, repoId: 'r1' })).toHaveLength(1);
    expect(auditExport(db, { since: 0, repoId: 'other' })).toEqual([]);
  });

  it('contains nothing a model produced', () => {
    seedGate();
    const [row] = auditExport(db, { since: 0 });
    // Every field is a stored fact, a hash of one, or an ISO rendering of a stored timestamp.
    // There is no summary, no rating, no judgement — and nowhere to put one.
    const keys = Object.keys(row!);
    for (const forbidden of ['summary', 'risk', 'rating', 'assessment', 'confidence']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(row!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders CSV with quoting that survives a comma', () => {
    seedGate();
    db.prepare("UPDATE gate_request SET execution_error = 'failed, badly' WHERE task_id = 't1'").run();

    const csv = toCsv(auditExport(db, { since: 0 }));
    expect(csv.split('\n')[0]).toContain('gate_id,gate,repo');
    expect(csv).toContain('"failed, badly"');
  });

  it('is empty rather than malformed when there is nothing in the window', () => {
    expect(toJsonl([])).toBe('');
    expect(toCsv([]).trim().split('\n')).toHaveLength(1);
  });
});
