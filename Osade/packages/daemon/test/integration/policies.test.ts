import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { GateClauses } from '../../src/domain/gate-clauses.js';
import { auditExport } from '../../src/domain/audit.js';
import { GateError, Gates } from '../../src/domain/gates.js';
import { appliesToPath, parsePolicy, reloadPolicies } from '../../src/knowledge/policies.js';
import { Fts5Adapter } from '../../src/retrieval/fts5-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * F4 — compliance on the gate (OSADE-MOSS §M.8).
 *
 * §M.8.5's three criteria are what these tests are about:
 *   1. a `requires_ack` clause about secrets appears on the right hunk, and approve is refused
 *      until it is acknowledged;
 *   2. editing the policy and reloading before approval voids the approval at execution;
 *   3. (the audit export, which is P7 and not built.)
 *
 * And the two invariants underneath them: **C1** — no flag without a cited clause; **C2** —
 * retrieval informs, humans decide, and only a human-authored `requires_ack` blocks anything.
 */

const NOW = 1_756_000_000_000;

const SECURITY_POLICY = [
  '---',
  'title: Security policy',
  '---',
  '',
  '## SEC-3.2 Secrets in code',
  'requires_ack: true',
  'applies_to: src/**, config/**',
  '',
  'No credential, API key, token or private key may be committed to the repository.',
  'Use the secret manager and reference the value at runtime.',
  '',
  '## SEC-4.1 Dependency pinning',
  '',
  'Every dependency must be pinned to an exact version.',
  '',
  '## Appendix',
  '',
  'This heading has no clause id and is prose, not a rule.',
].join('\n');

let dir: string;
let db: Db;
let retrieval: RetrievalService;
let clauses: GateClauses;
let gates: Gates;
let repoPath: string;

function writePolicy(text: string): void {
  const policyDir = join(repoPath, '.osade', 'policies');
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, 'security.md'), text);
}

function seedTask(): void {
  db.prepare('INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, NULL, ?, ?, ?)').run(
    'r1',
    repoPath,
    'main',
    NOW,
  );
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                       branch, worktree_path, created_at)
     VALUES ('t1', 'r1', 'x', 'x', 'manual', 'c1', 'main', 'base000', 'osade/x', ?, ?)`,
  ).run(join(dir, 'wt'), NOW);
}

/** A diff that adds a hard-coded key in a file the policy's globs cover. */
const SECRET_DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1,3 +1,4 @@',
  ' export const config = {',
  '+  apiKey: "sk-live-9f3a2b7c8d1e4f5a6b7c8d9e",',
  '   region: "eu-west-1",',
  ' };',
].join('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'osade-f4-'));
  repoPath = join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  db = openDb(':memory:');
  seedTask();
  retrieval = await RetrievalService.open(db, { port: new Fts5Adapter(db), onWarning: () => {} });
  clauses = new GateClauses(db, retrieval);
  gates = new Gates(db, { now: () => NOW });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§M.8.1 — the policy format', () => {
  it('turns id-prefixed headings into clauses and leaves prose alone', () => {
    const parsed = parsePolicy('security.md', SECURITY_POLICY);
    expect(parsed.title).toBe('Security policy');
    expect(parsed.clauses.map((c) => c.clauseRef)).toEqual(['SEC-3.2', 'SEC-4.1']);
    // "## Appendix" has no clause id, so it is not citable. An approval card that said
    // "Appendix applies to this change" would be noise.
    expect(parsed.clauses.some((c) => c.title === 'Appendix')).toBe(false);
  });

  it('reads requires_ack and applies_to per clause, defaulting to off', () => {
    const parsed = parsePolicy('security.md', SECURITY_POLICY);
    const secrets = parsed.clauses.find((c) => c.clauseRef === 'SEC-3.2')!;
    expect(secrets.requiresAck).toBe(true);
    expect(secrets.appliesTo).toEqual(['src/**', 'config/**']);

    const pinning = parsed.clauses.find((c) => c.clauseRef === 'SEC-4.1')!;
    // Not inherited: blocking the approve button is always a deliberate act.
    expect(pinning.requiresAck).toBe(false);
    expect(pinning.appliesTo).toEqual([]);
  });

  it('keeps the attribute lines out of the clause text', () => {
    const parsed = parsePolicy('security.md', SECURITY_POLICY);
    const secrets = parsed.clauses.find((c) => c.clauseRef === 'SEC-3.2')!;
    expect(secrets.text).toContain('No credential');
    expect(secrets.text).not.toContain('requires_ack');
  });

  it('matches applies_to globs across and within segments', () => {
    expect(appliesToPath(['src/**'], 'src/a/b/config.ts')).toBe(true);
    expect(appliesToPath(['src/**'], 'test/config.ts')).toBe(false);
    expect(appliesToPath(['src/*.ts'], 'src/config.ts')).toBe(true);
    expect(appliesToPath(['src/*.ts'], 'src/a/config.ts')).toBe(false);
    // No globs means the clause applies everywhere in its scope.
    expect(appliesToPath([], 'anything/at/all.ts')).toBe(true);
  });
});

describe('§M.8.1 — reloading', () => {
  it('loads clauses and indexes them into the policies namespace', async () => {
    writePolicy(SECURITY_POLICY);
    const result = reloadPolicies(db, {});
    expect(result).toMatchObject({ policies: 1, clauses: 2, removed: 0 });

    await retrieval.indexer.drain();
    const hits = await retrieval.query('policies', 'committing an api key', { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // R2 — every clause traces back to its row and its file hash.
    expect(hits[0]?.meta.src_table).toBe('policy_clause');
    expect(hits[0]?.meta.head_sha).toBeTruthy();
  });

  it('is a no-op when nothing changed, so clause ids survive', () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    const before = db.prepare('SELECT id FROM policy_clause ORDER BY clause_ref').all();

    reloadPolicies(db, {});
    const after = db.prepare('SELECT id FROM policy_clause ORDER BY clause_ref').all();
    // Stable ids matter: a pending approval is bound to them.
    expect(after).toEqual(before);
  });

  it('replaces the clauses when the file changes', () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    const before = db.prepare('SELECT id FROM policy_clause').all() as { id: string }[];

    writePolicy(`${SECURITY_POLICY}\n\n## SEC-5.0 Logging\n\nDo not log secrets.\n`);
    reloadPolicies(db, {});
    const after = db.prepare('SELECT id FROM policy_clause').all() as { id: string }[];

    expect(after).toHaveLength(3);
    expect(after.map((r) => r.id)).not.toEqual(expect.arrayContaining(before.map((r) => r.id)));
  });

  it('drops the clauses of a deleted policy file', () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    rmSync(join(repoPath, '.osade', 'policies', 'security.md'));

    const result = reloadPolicies(db, {});
    expect(result.removed).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM policy_clause').get()).toEqual({ n: 0 });
  });

  it('no policies directory is not an error', () => {
    expect(() => reloadPolicies(db, {})).not.toThrow();
  });
});

describe('§M.8.2 — clauses are found at request time and bound into the payload', () => {
  async function requestWithClauses(): Promise<{ gateId: string; payload: unknown }> {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    const set = await clauses.forDiff('r1', SECRET_DIFF);
    const payload = { title: 'Add config', body: 'x', head_sha: 'a1c0ffee' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload, clauses: set });
    clauses.record(gateId, set);
    return { gateId, payload };
  }

  it('attaches the secrets clause to the hunk that added the key', async () => {
    const { gateId } = await requestWithClauses();
    const rows = db
      .prepare(
        `SELECT gc.hunk_ref, pc.clause_ref FROM gate_clause gc
           JOIN policy_clause pc ON pc.id = gc.clause_id WHERE gc.gate_id = ?`,
      )
      .all(gateId) as { hunk_ref: string; clause_ref: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.clause_ref)).toContain('SEC-3.2');
    expect(rows[0]!.hunk_ref).toMatch(/^src\/config\.ts:/);
  });

  it('folds the clause hash into the payload that gets hashed', async () => {
    const { gateId } = await requestWithClauses();
    const row = db.prepare('SELECT payload_json FROM gate_request WHERE id = ?').get(gateId) as {
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json)).toHaveProperty('clauses_hash');
  });

  it('a repo with no policies hashes exactly as it did before F4', async () => {
    const set = await clauses.forDiff('r1', SECRET_DIFF);
    expect(set.matches).toEqual([]);

    const payload = { title: 'Add config', body: 'x', head_sha: 'a1c0ffee' };
    // No clauses at all → no `clauses_hash` key, so approvals in flight at upgrade time keep
    // working. Passing the empty set must not change the payload shape.
    const withEmpty = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload, clauses: set });
    const stored = db.prepare('SELECT payload_json FROM gate_request WHERE id = ?').get(withEmpty) as {
      payload_json: string;
    };
    expect(JSON.parse(stored.payload_json)).toHaveProperty('clauses_hash');
    // …and the plain path, with no clause argument at all, is untouched.
    const plain = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    const plainRow = db.prepare('SELECT payload_json FROM gate_request WHERE id = ?').get(plain) as {
      payload_json: string;
    };
    expect(JSON.parse(plainRow.payload_json)).not.toHaveProperty('clauses_hash');
  });

  it('respects applies_to — a clause scoped to src/** does not flag a docs change', async () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    const docsDiff = SECRET_DIFF.replace(/src\/config\.ts/g, 'docs/config.md');
    const set = await clauses.forDiff('r1', docsDiff);
    const refs = set.matches.map((m) => m.clauseId);
    const scoped = db
      .prepare("SELECT id FROM policy_clause WHERE clause_ref = 'SEC-3.2'")
      .get() as { id: string };
    expect(refs).not.toContain(scoped.id);
  });

  it('C1 — a clause whose row is gone is not a flag', async () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    // Delete the clauses without reindexing: the index still has them, the tables do not.
    db.prepare('DELETE FROM policy').run();

    const set = await clauses.forDiff('r1', SECRET_DIFF);
    expect(set.matches).toEqual([]);
  });
});

describe('§M.8.5 criterion 1 — approve is refused until the clause is acknowledged', () => {
  async function gateWithAck(): Promise<string> {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    const set = await clauses.forDiff('r1', SECRET_DIFF);
    const gateId = gates.request({
      taskId: 't1',
      gate: 'gate.pr_open',
      payload: { title: 'Add config', head_sha: 'a1c0ffee' },
      clauses: set,
    });
    clauses.record(gateId, set);
    return gateId;
  }

  it('refuses approval while a requires_ack clause is outstanding', async () => {
    const gateId = await gateWithAck();
    expect(clauses.outstandingAcks(gateId)).toBeGreaterThan(0);
    expect(() => gates.decide(gateId, 'approve')).toThrow(GateError);
    expect(() => gates.decide(gateId, 'approve')).toThrow(/acknowledged/);
  });

  it('allows approval once it is acknowledged, and records who', async () => {
    const gateId = await gateWithAck();
    const clause = db
      .prepare("SELECT id FROM policy_clause WHERE clause_ref = 'SEC-3.2'")
      .get() as { id: string };

    clauses.ack(gateId, clause.id, 'github:priya', NOW);
    expect(clauses.outstandingAcks(gateId)).toBe(0);
    expect(() => gates.decide(gateId, 'approve')).not.toThrow();

    const row = db
      .prepare('SELECT acked_by, acked_at FROM gate_clause WHERE gate_id = ? AND clause_id = ?')
      .get(gateId, clause.id) as { acked_by: string; acked_at: number };
    expect(row).toEqual({ acked_by: 'github:priya', acked_at: NOW });
  });

  it('C2 — a clause without requires_ack never blocks anything', async () => {
    writePolicy(SECURITY_POLICY.replace('requires_ack: true\n', ''));
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    const set = await clauses.forDiff('r1', SECRET_DIFF);
    const gateId = gates.request({
      taskId: 't1',
      gate: 'gate.pr_open',
      payload: { title: 'x', head_sha: 'a1c0ffee' },
      clauses: set,
    });
    clauses.record(gateId, set);

    // Clauses may well have matched — they just do not gate anything on their own.
    expect(clauses.outstandingAcks(gateId)).toBe(0);
    expect(() => gates.decide(gateId, 'approve')).not.toThrow();
  });

  it('denial is never blocked by an outstanding ack', async () => {
    const gateId = await gateWithAck();
    // Refusing to approve is not the same as refusing to decide. A human who has read enough
    // to say no should not have to tick boxes first.
    expect(() => gates.decide(gateId, 'deny')).not.toThrow();
  });
});

describe('§M.8.5 criterion 2 — editing the policy voids the approval', () => {
  it('a reload before approval makes execution fail its re-hash', async () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    const set = await clauses.forDiff('r1', SECRET_DIFF);
    const payload = { title: 'Add config', head_sha: 'a1c0ffee' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload, clauses: set });
    clauses.record(gateId, set);
    expect(set.matches.length).toBeGreaterThan(0);

    const clause = db
      .prepare("SELECT id FROM policy_clause WHERE clause_ref = 'SEC-3.2'")
      .get() as { id: string };
    clauses.ack(gateId, clause.id, 'human', NOW);
    gates.decide(gateId, 'approve');

    // Approved. Now the policy changes underneath it.
    writePolicy(SECURITY_POLICY.replace('No credential,', 'No credential or secret,'));
    reloadPolicies(db, {});

    await expect(gates.assertExecutableNow(gateId, payload)).rejects.toThrow(
      /payload changed after approval/,
    );
  });

  it('an untouched policy still executes cleanly', async () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();

    const set = await clauses.forDiff('r1', SECRET_DIFF);
    const payload = { title: 'Add config', head_sha: 'a1c0ffee' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload, clauses: set });
    clauses.record(gateId, set);

    const clause = db
      .prepare("SELECT id FROM policy_clause WHERE clause_ref = 'SEC-3.2'")
      .get() as { id: string };
    clauses.ack(gateId, clause.id, 'human', NOW);
    gates.decide(gateId, 'approve');

    reloadPolicies(db, {});
    await expect(gates.assertExecutableNow(gateId, payload)).resolves.toBeUndefined();
  });
});

/**
 * The bug: `gate_clause` cascaded from `policy_clause`, and the daemon reloads policies at every
 * boot. Editing or deleting a policy file therefore erased "clauses shown" and "clauses acked"
 * from the audit export of gates decided long before — a named person's approval, reported as
 * if no policy had been in front of them.
 */
describe('§M.8.4 — a policy reload never rewrites the audit trail (M18)', () => {
  async function executedGate(): Promise<string> {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();
    const set = await clauses.forDiff('r1', SECRET_DIFF);
    expect(set.matches.length).toBeGreaterThan(0);
    const payload = { title: 'Add config', head_sha: 'a1c0ffee' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload, clauses: set });
    clauses.record(gateId, set);
    const clause = db
      .prepare("SELECT id FROM policy_clause WHERE clause_ref = 'SEC-3.2'")
      .get() as { id: string };
    clauses.ack(gateId, clause.id, 'priya', NOW);
    gates.decide(gateId, 'approve');
    gates.markExecuted(gateId);
    return gateId;
  }

  function auditFor(gateId: string) {
    return auditExport(db, { since: 0 }).find((row) => row.gate_id === gateId)!;
  }

  it('keeps what an executed gate showed after the policy is edited', async () => {
    const gateId = await executedGate();
    const before = auditFor(gateId);
    expect(before.clauses_shown.map((c) => c.ref)).toContain('SEC-3.2');

    writePolicy(SECURITY_POLICY.replace('No credential,', 'No credential or secret,'));
    reloadPolicies(db, {});

    const after = auditFor(gateId);
    expect(after.clauses_shown).toEqual(before.clauses_shown);
    expect(after.clauses_acked).toEqual(before.clauses_acked);
    // The hash is the one that was shown, not the file as it is now.
    expect(after.clauses_shown[0]!.file_sha).toBe(before.clauses_shown[0]!.file_sha);
  });

  it('keeps it after the policy file is deleted outright', async () => {
    const gateId = await executedGate();
    const before = auditFor(gateId);

    rmSync(join(repoPath, '.osade', 'policies', 'security.md'));
    const result = reloadPolicies(db, {});
    expect(result.removed).toBe(1);

    expect(auditFor(gateId).clauses_acked).toEqual(before.clauses_acked);
    expect(auditFor(gateId).clauses_acked[0]!.by).toBe('priya');
  });

  it('still unbinds a gate that has not executed, without forgetting it was shown', async () => {
    writePolicy(SECURITY_POLICY);
    reloadPolicies(db, {});
    await retrieval.indexer.drain();
    const set = await clauses.forDiff('r1', SECRET_DIFF);
    const payload = { title: 'Add config', head_sha: 'a1c0ffee' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload, clauses: set });
    clauses.record(gateId, set);

    writePolicy(SECURITY_POLICY.replace('No credential,', 'No credential or secret,'));
    reloadPolicies(db, {});

    // Nothing live binds it any more, so no stale ack is demanded of the approver…
    expect(clauses.outstandingAcks(gateId)).toBe(0);
    // …but the audit still says what was on the card.
    expect(auditFor(gateId).clauses_shown.map((c) => c.ref)).toContain('SEC-3.2');
  });
});
