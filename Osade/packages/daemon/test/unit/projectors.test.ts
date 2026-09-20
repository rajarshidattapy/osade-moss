import { describe, expect, it } from 'vitest';

import { RETRIEVAL_TABLES } from '../../src/db/migrations.js';
import { docId, paddedSeq, PROJECTORS } from '../../src/retrieval/projectors.js';

/**
 * OSADE-MOSS §M.1.4 — "every projector is pure and deterministic".
 *
 * This is the test the rebuild guarantee rests on. If projecting the same row twice can give
 * different documents, then `osade index rebuild` is not equivalent to incremental indexing,
 * and R1's "drop it and rebuild" stops being a safe answer to anything.
 */

const TURN_ROW = {
  id: 'ct_1',
  task_id: 't1',
  chat_id: 'chat1',
  repo_id: 'r1',
  seq: 7,
  role: 'user',
  origin: 'human',
  text: 'Rename search() to query() across the SDK wrapper.',
  delivery: 'accepted',
  created_at: 1_756_000_000_000,
  agent_id: 'claude',
  base_sha: 'abc123def456',
};

const VERIFY_ROW = {
  id: 'vr_1',
  task_id: 't1',
  chat_id: 'chat1',
  repo_id: 'r1',
  step_name: 'test',
  cmd: 'pnpm test',
  exit_code: 0,
  required: 1,
  head_sha: 'deadbeefcafe',
  finished_at: 1_756_000_000_000,
};

const CONVENTION_ROW = {
  id: 'cv_1',
  repo_id: 'r1',
  category: 'commit_style',
  rule_text: 'Imports from the SDK go through src/lib/moss.ts.',
  rationale: 'one seam',
  confidence: 0.9,
  lifecycle: 'active',
  evidence_url: 'https://github.com/acme/web/pull/88',
  evidence_count: 3,
};

describe('§M.1.4 — projectors are pure and deterministic', () => {
  it('projecting the same row twice gives identical documents', () => {
    for (const [table, row] of [
      ['chat_turn', TURN_ROW],
      ['verify_run', VERIFY_ROW],
      ['convention', CONVENTION_ROW],
    ] as const) {
      const first = PROJECTORS[table].project(row);
      const second = PROJECTORS[table].project(row);
      expect(second, `${table} is not deterministic`).toEqual(first);
    }
  });

  it('does not mutate the row it is given', () => {
    const row = { ...TURN_ROW };
    PROJECTORS.chat_turn.project(row);
    expect(row).toEqual(TURN_ROW);
  });
});

describe('§M.1.4 R2 — nothing enters the index without provenance', () => {
  it('every projected document carries src_table, src_id and a locator', () => {
    const docs = [
      ...PROJECTORS.chat_turn.project(TURN_ROW),
      ...PROJECTORS.verify_run.project(VERIFY_ROW),
      ...PROJECTORS.convention.project(CONVENTION_ROW),
      ...PROJECTORS.gate_request.project({
        id: 'g_1',
        task_id: 't1',
        chat_id: 'chat1',
        repo_id: 'r1',
        gate: 'gate.pr_open',
        decision: 'approve',
        decided_by: 'github:priya',
        decided_at: 1_756_000_000_000,
        execution_error: null,
      }),
    ];
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      const meta = doc.meta as Record<string, string | undefined>;
      expect(meta.src_table, doc.id).toBeTruthy();
      expect(meta.src_id, doc.id).toBeTruthy();
      const locators = [meta.url, meta.head_sha, meta.run_id, meta.gate_id].filter(Boolean);
      expect(locators.length, `${doc.id} has no locator`).toBeGreaterThan(0);
    }
  });
});

describe('§M.1.5 — document ids', () => {
  it('are deterministic and namespaced', () => {
    expect(docId('turns', 'chat_turn', 'ct_1')).toBe('turns:chat_turn:ct_1');
    expect(docId('code', 'code_chunk', 'cc_1', 3)).toBe('code:code_chunk:cc_1:3');
  });

  it('zero-pads seq so a lexical comparison equals numeric order (§M.12 Q3)', () => {
    // The whole point: without padding, '9' > '10' lexically and a catch-up window silently
    // skips everything between turn 10 and turn 99.
    expect(paddedSeq(9) < paddedSeq(10)).toBe(true);
    expect(paddedSeq(99) < paddedSeq(100)).toBe(true);
    expect(paddedSeq(7)).toBe('000000000007');
  });
});

describe('what the projectors deliberately refuse to index', () => {
  it('a turn that was never delivered', () => {
    expect(PROJECTORS.chat_turn.project({ ...TURN_ROW, delivery: 'failed' })).toEqual([]);
    expect(PROJECTORS.chat_turn.project({ ...TURN_ROW, delivery: 'sending' })).toEqual([]);
  });

  it('a convention that is not active — §13 never injects an unconfirmed rule', () => {
    expect(PROJECTORS.convention.project({ ...CONVENTION_ROW, lifecycle: 'candidate' })).toEqual([]);
    expect(PROJECTORS.convention.project({ ...CONVENTION_ROW, lifecycle: 'rejected' })).toEqual([]);
  });

  it('a convention with no evidence — §13.1, and it could not satisfy R2 either', () => {
    expect(PROJECTORS.convention.project({ ...CONVENTION_ROW, evidence_url: null })).toEqual([]);
  });

  it('a verify run that has not finished', () => {
    expect(PROJECTORS.verify_run.project({ ...VERIFY_ROW, finished_at: null })).toEqual([]);
  });

  it('agent activity text — §M.1.4 keeps 1 Hz churn out of the turns namespace', () => {
    const base = {
      task_id: 't1',
      chat_id: 'chat1',
      repo_id: 'r1',
      agent_id: 'claude',
      substrate_state: 'working',
      final_message: null,
      terminated: 0,
      external_block: null,
      base_sha: 'abc123',
    };
    expect(PROJECTORS.agent_fact.project({ ...base, last_event: 'activity' })).toEqual([]);
    expect(PROJECTORS.agent_fact.project({ ...base, last_event: 'to_review' })).toHaveLength(1);
  });
});

describe('§M.1.5 — the verified flag means one thing', () => {
  it('is set only by a passing required run', () => {
    const verified = (row: typeof VERIFY_ROW) =>
      (PROJECTORS.verify_run.project(row)[0]?.meta as Record<string, string | undefined>).verified;

    expect(verified(VERIFY_ROW)).toBe('1');
    expect(verified({ ...VERIFY_ROW, exit_code: 1 })).toBeUndefined();
    // An optional step passing is not evidence a sibling lane should act on.
    expect(verified({ ...VERIFY_ROW, required: 0 })).toBeUndefined();
  });
});

describe('the registry', () => {
  it('covers every table the retrieval triggers write for', () => {
    for (const table of RETRIEVAL_TABLES) {
      expect(PROJECTORS[table], `${table} has no projector`).toBeDefined();
    }
  });
});
