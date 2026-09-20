import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { DIFF_BEARING, GateError, Gates, type GateName } from '../../src/domain/gates.js';

/**
 * INVARIANT A1 — every diff-bearing gate pins the commit it approves (OSADE-MOSS §M.7.1).
 *
 * This is the hole the architecture review found: a `gate.push` payload did not name a commit,
 * so an agent could add work between approval and execution and the approval would still run —
 * against code no human had seen. §M.7.6 criterion 1 is the test below that makes that abort.
 *
 * It matters beyond tidiness: F3's whole claim is "a named human approved *this commit*". An
 * attestation over a payload that does not pin one would be signing a statement that is not
 * checkable.
 */

const NOW = 1_756_000_000_000;
const APPROVED_HEAD = 'a1c0ffee1234567890abcdef';

let db: Db;
let clock: number;
let head: string | null;

function gates(): Gates {
  return new Gates(db, {
    now: () => clock,
    resolveHead: async () => head,
  });
}

beforeEach(() => {
  clock = NOW;
  head = APPROVED_HEAD;
  db = openDb(':memory:');
  db.prepare('INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, NULL, ?, ?, ?)').run(
    'r1',
    '/repo',
    'main',
    NOW,
  );
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                       branch, worktree_path, created_at)
     VALUES ('t1', 'r1', 'x', 'x', 'manual', 'c1', 'main', 'base', 'osade/x', '/wt', ?)`,
  ).run(NOW);
});

afterEach(() => {
  db.close();
});

describe('A1 — the payload must pin a commit', () => {
  it('refuses a diff-bearing gate whose payload has no head_sha', () => {
    for (const gate of DIFF_BEARING) {
      expect(() => gates().request({ taskId: 't1', gate, payload: { m: 'x' } })).toThrow(
        /must pin the commit/,
      );
    }
  });

  it('refuses an empty head_sha, not just a missing one', () => {
    expect(() =>
      gates().request({ taskId: 't1', gate: 'gate.push', payload: { head_sha: '' } }),
    ).toThrow(GateError);
  });

  it('leaves gates that are not about a diff alone', () => {
    // A comment approval is about *text*, and demanding a commit for it would be cargo cult.
    for (const gate of ['gate.pr_comment', 'gate.issue_comment', 'gate.branch_delete'] as GateName[]) {
      expect(() => gates().request({ taskId: 't1', gate, payload: { body: 'hi' } })).not.toThrow();
    }
  });
});

describe('§M.7.6 criterion 1 — the branch moving after approval aborts execution', () => {
  async function approvedPush(): Promise<{ g: Gates; id: string; payload: unknown }> {
    const g = gates();
    const payload = { remote: 'origin', branch: 'osade/x', force: false, head_sha: APPROVED_HEAD };
    const id = g.request({ taskId: 't1', gate: 'gate.push', payload });
    g.decide(id, 'approve', 'github:priya');
    return { g, id, payload };
  }

  it('executes while the branch is where it was approved', async () => {
    const { g, id, payload } = await approvedPush();
    await expect(g.assertExecutableNow(id, payload)).resolves.toBeUndefined();
  });

  it('aborts once the agent has added a commit', async () => {
    const { g, id, payload } = await approvedPush();

    // The agent keeps working after the human approved.
    head = 'deadbeef0987654321fedcba';

    await expect(g.assertExecutableNow(id, payload)).rejects.toThrow(/branch moved after approval/);
    await expect(g.assertExecutableNow(id, payload)).rejects.toThrow(/re-approve/);
  });

  it('names both commits, so the abort is actionable', async () => {
    const { g, id, payload } = await approvedPush();
    head = 'deadbeef0987654321fedcba';
    await expect(g.assertExecutableNow(id, payload)).rejects.toThrow(/a1c0ffee.*deadbeef/s);
  });
});

describe('A1 cannot be side-stepped', () => {
  it('the synchronous path refuses a diff-bearing gate outright', () => {
    const g = gates();
    const payload = { remote: 'origin', branch: 'osade/x', force: false, head_sha: APPROVED_HEAD };
    const id = g.request({ taskId: 't1', gate: 'gate.push', payload });
    g.decide(id, 'approve');

    // Picking the convenient method must not be a way to skip the re-read. This is the
    // difference between an invariant and a convention.
    expect(() => g.assertExecutable(id, payload)).toThrow(/use assertExecutableNow/);
  });

  it('the synchronous path still serves gates that are not about a diff', () => {
    const g = gates();
    const payload = { body: 'thanks!' };
    const id = g.request({ taskId: 't1', gate: 'gate.pr_comment', payload });
    g.decide(id, 'approve');
    expect(() => g.assertExecutable(id, payload)).not.toThrow();
  });

  it('a changed payload still fails the hash check, pin or no pin', async () => {
    const g = gates();
    const payload = { remote: 'origin', branch: 'osade/x', force: false, head_sha: APPROVED_HEAD };
    const id = g.request({ taskId: 't1', gate: 'gate.push', payload });
    g.decide(id, 'approve');

    await expect(
      g.assertExecutableNow(id, { ...payload, branch: 'main' }),
    ).rejects.toThrow(/payload changed after approval/);
  });
});

describe('A1 when the head cannot be read', () => {
  it('does not invent a mismatch', async () => {
    // An unborn branch, a worktree that has gone away. The pin is still checked by the hash;
    // failing closed here would make every such gate permanently unexecutable for no gain.
    head = null;
    const g = gates();
    const payload = { remote: 'origin', branch: 'osade/x', force: false, head_sha: APPROVED_HEAD };
    const id = g.request({ taskId: 't1', gate: 'gate.push', payload });
    g.decide(id, 'approve');

    await expect(g.assertExecutableNow(id, payload)).resolves.toBeUndefined();
  });
});
