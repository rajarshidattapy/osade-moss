import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { Attestations } from '../../src/attest/service.js';
import {
  keyIdFor,
  loadOrCreateKey,
  parseAttestorFile,
  renderAttestorFile,
  sign,
  verify,
  type KeyPair,
} from '../../src/attest/keys.js';
import { canonicalise, parseBlock, withBlock } from '../../src/attest/statement.js';
import { Gates } from '../../src/domain/gates.js';

/**
 * F3 — human-approval attestation (OSADE-MOSS §M.7).
 *
 * §M.7.6 criterion 2 is the shape of this file: an opened PR carries the block, `attest verify`
 * passes, and it fails after one byte of the statement is edited. Criterion 3 — staleness once
 * a commit lands after approval — is the last describe block.
 *
 * The claim being tested is narrow and worth restating: *this install attests that the GitHub
 * user it authenticated approved this exact commit after these checks passed.* Not that the
 * approver signed anything themselves; that is tier 2.
 */

const NOW = 1_756_000_000_000;
const HEAD = 'a1c0ffee1234567890abcdef';

let dir: string;
let db: Db;
let key: KeyPair;
let attest: Attestations;
let gates: Gates;

function seed(): void {
  db.prepare(
    'INSERT INTO repo (id, org_id, path, gh_owner, gh_name, default_branch, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
  ).run('r1', '/repo', 'acme', 'web', 'main', NOW);
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                       branch, worktree_path, agent_id, created_at)
     VALUES ('t1', 'r1', 'x', 'x', 'manual', 'c1', 'main', 'base000', 'osade/x', '/wt', 'claude', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                             required, head_sha, log_path)
     VALUES ('vr1', 't1', 'test', 'pnpm test', ?, ?, 0, 1, ?, '/logs/vr1')`,
  ).run(NOW, NOW + 10, HEAD);
}

/** An approved `gate.pr_open` pinned to HEAD. */
function approvedGate(by = 'github:priya'): string {
  const id = gates.request({
    taskId: 't1',
    gate: 'gate.pr_open',
    payload: { title: 'Migrate the SDK', body: 'body', head_sha: HEAD },
  });
  gates.decide(id, 'approve', by);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osade-f3-'));
  db = openDb(':memory:');
  seed();
  key = loadOrCreateKey({ OSADE_HOME: dir });
  attest = new Attestations(db, { now: () => NOW, key, build: 'test-build' });
  gates = new Gates(db, { now: () => NOW });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§M.7.2 — the install key', () => {
  it('generates once and is stable across loads', () => {
    const again = loadOrCreateKey({ OSADE_HOME: dir });
    expect(again.keyId).toBe(key.keyId);
    expect(again.publicPem).toBe(key.publicPem);
  });

  it('derives the key id from the key, so a file cannot claim someone else’s', () => {
    expect(keyIdFor(key.publicPem)).toBe(key.keyId);
    const other = loadOrCreateKey({ OSADE_HOME: mkdtempSync(join(tmpdir(), 'osade-f3b-')) });
    expect(other.keyId).not.toBe(key.keyId);
  });

  it('round-trips through the published attestor file', () => {
    const parsed = parseAttestorFile(renderAttestorFile(key, 'laptop'));
    expect(parsed?.attestors[0]).toMatchObject({ key_id: key.keyId });
    expect(keyIdFor(parsed!.attestors[0]!.public_key)).toBe(key.keyId);
  });

  it('verify() returns false rather than throwing on rubbish', () => {
    // A verifier that throws turns "not valid" into a crash, and the caller cannot tell the
    // difference between the two.
    expect(verify('msg', 'not-base64!!', key.publicPem)).toBe(false);
    expect(verify('msg', sign('msg', key.privatePem), 'not a pem')).toBe(false);
  });
});

describe('§M.7.2 — the statement', () => {
  it('is canonical: v first, then sorted keys, no whitespace', () => {
    const issued = attest.issue(approvedGate())!;
    const canonical = canonicalise(issued.statement);
    expect(canonical.startsWith('{"v":1,')).toBe(true);
    // No *structural* whitespace. Values legitimately contain spaces ("pnpm test"); what has to
    // be identical across machines is the separators, because the signature covers these bytes.
    expect(canonical).not.toContain('": ');
    expect(canonical).not.toContain(', "');
    expect(canonical).not.toContain('\n');

    // Re-canonicalising a parsed statement must reproduce the exact bytes, or the signature
    // would not verify on another machine.
    expect(canonicalise(JSON.parse(canonical))).toBe(canonical);
  });

  it('names the commit, the approver and the checks that passed', () => {
    const issued = attest.issue(approvedGate('github:priya'))!;
    expect(issued.statement).toMatchObject({
      v: 1,
      tier: 1,
      repo: 'acme/web',
      head_sha: HEAD,
      approved_by: 'github:priya',
      agent: 'claude',
    });
    expect(issued.statement.verification).toEqual([
      { step: 'test', cmd: 'pnpm test', exit: 0, head_sha: HEAD },
    ]);
  });

  it('cites only runs for the commit being approved', () => {
    // A run at an earlier commit says nothing about this one; §6 makes it stale the moment the
    // head moves, and a statement that cited it would be claiming checks that never ran here.
    db.prepare(
      `INSERT INTO verify_run (id, task_id, step_name, cmd, started_at, finished_at, exit_code,
                               required, head_sha, log_path)
       VALUES ('vr_old', 't1', 'test', 'pnpm test', ?, ?, 0, 1, 'oldhead', '/logs/old')`,
    ).run(NOW - 100, NOW - 90);

    const issued = attest.issue(approvedGate())!;
    expect(issued.statement.verification.map((v) => v.head_sha)).toEqual([HEAD]);
  });

  it('refuses to attest an undecided or denied gate', () => {
    const undecided = gates.request({
      taskId: 't1',
      gate: 'gate.pr_open',
      payload: { title: 'x', body: 'y', head_sha: HEAD },
    });
    expect(attest.issue(undecided)).toBeNull();

    gates.decide(undecided, 'deny');
    expect(attest.issue(undecided)).toBeNull();
  });
});

describe('§M.7.3 — the PR body block', () => {
  it('carries a human line and the machine-readable statement', () => {
    const issued = attest.issue(approvedGate('github:priya'))!;
    expect(issued.block).toContain('Approved by @priya for commit a1c0ffe');
    expect(issued.block).toContain('pnpm test');
    expect(issued.block).toContain('<!-- osade-attestation v1 -->');
    // §M.7.2 — the tier-1 limit is stated where the maintainer reads it, not buried in docs.
    expect(issued.block).toContain('this Osade install vouches for the approver');
    expect(issued.block).toContain('does not prove the approver signed anything themselves');
  });

  it('round-trips out of a rendered body', () => {
    const issued = attest.issue(approvedGate())!;
    const body = withBlock('Some PR description.', issued.block);
    const parsed = parseBlock(body)!;

    expect(parsed.keyId).toBe(key.keyId);
    expect(JSON.parse(parsed.statement)).toMatchObject({ head_sha: HEAD });
    expect(body).toContain('Some PR description.');
  });

  it('replaces rather than stacks when a PR is re-attested', () => {
    const first = attest.issue(approvedGate())!;
    const body = withBlock('Description.', first.block);
    const second = attest.issue(approvedGate())!;
    const updated = withBlock(body, second.block);

    // One attestation, not a pile of superseded ones inviting a reader to check the wrong one.
    expect(updated.split('<!-- osade-attestation v1 -->')).toHaveLength(2);
  });
});

describe('§M.7.6 criterion 2 — verification', () => {
  const published = (): { key_id: string; public_key: string }[] => [
    { key_id: key.keyId, public_key: key.publicPem },
  ];

  it('passes for an untouched block at the PR’s current head', () => {
    const issued = attest.issue(approvedGate())!;
    const body = withBlock('x', issued.block);
    expect(attest.verifyBody(body, HEAD, published())).toMatchObject({ state: 'valid' });
  });

  it('fails after one byte of the statement is edited', () => {
    const issued = attest.issue(approvedGate('github:priya'))!;
    const canonical = canonicalise(issued.statement);
    // Promote the approver. The signature covers these bytes, so it must not verify.
    const tampered = canonical.replace('github:priya', 'github:priyb');
    expect(tampered).not.toBe(canonical);

    const body = withBlock(
      'x',
      issued.block.replace(
        Buffer.from(canonical, 'utf8').toString('base64'),
        Buffer.from(tampered, 'utf8').toString('base64'),
      ),
    );

    const result = attest.verifyBody(body, HEAD, published());
    expect(result).toMatchObject({ state: 'invalid' });
    expect(result.state === 'invalid' && result.reason).toContain('signature');
  });

  it('fails when the published key does not match its own key_id', () => {
    const issued = attest.issue(approvedGate())!;
    const body = withBlock('x', issued.block);
    const other = loadOrCreateKey({ OSADE_HOME: mkdtempSync(join(tmpdir(), 'osade-f3c-')) });

    // Someone publishes a key they control under the id of a key they do not.
    const result = attest.verifyBody(body, HEAD, [
      { key_id: key.keyId, public_key: other.publicPem },
    ]);
    expect(result).toMatchObject({ state: 'invalid' });
    expect(result.state === 'invalid' && result.reason).toContain('does not match its own key_id');
  });

  it('reports an unknown key rather than guessing', () => {
    const issued = attest.issue(approvedGate())!;
    const body = withBlock('x', issued.block);
    expect(attest.verifyBody(body, HEAD, [])).toMatchObject({ state: 'invalid' });
  });

  it('reports absent for a PR that carries no block at all', () => {
    expect(attest.verifyBody('Just a PR.', HEAD, published())).toEqual({ state: 'absent' });
  });
});

describe('§M.7.6 criterion 3 — staleness is not invalidity', () => {
  it('a commit landing after approval makes the attestation stale, not invalid', () => {
    const issued = attest.issue(approvedGate())!;
    const body = withBlock('x', issued.block);

    const result = attest.verifyBody(body, 'deadbeefcafe0987654321', [
      { key_id: key.keyId, public_key: key.publicPem },
    ]);

    // A named human really did approve that commit. There is simply newer code now — and
    // conflating the two would teach maintainers to ignore both.
    expect(result.state).toBe('stale');
    expect(result.state === 'stale' && result.approvedHead).toBe(HEAD);
  });

  it('records the attestation against the head it was for', () => {
    attest.issue(approvedGate());
    const latest = attest.latestFor('t1')!;
    expect(latest.head_sha).toBe(HEAD);
    expect(latest.statement.head_sha).toBe(HEAD);
  });
});

describe('§M.7.2 — the attestation reaches the ledger', () => {
  it('is a CDC table, so an issued attestation fans out like any other fact', () => {
    attest.issue(approvedGate());
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'attestation'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
