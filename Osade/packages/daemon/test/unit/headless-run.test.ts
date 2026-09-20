import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { stepsFromAgentText } from '../../src/domain/headless-copy.js';
import {
  HeadlessRuns,
  NoHeadlessAgentError,
  pickHeadlessAgent,
} from '../../src/domain/headless-run.js';
import { searchMemory } from '../../src/knowledge/memory.js';

const present = (): boolean => true;
const missing = (): boolean => false;

describe('pickHeadlessAgent', () => {
  it('throws a typed error when nothing with headless-run is on PATH', () => {
    expect(() => pickHeadlessAgent({ onPath: missing })).toThrow(NoHeadlessAgentError);
  });

  it('does not silently fall through when the explicit agent cannot run headless', () => {
    expect(() => pickHeadlessAgent({ agentId: 'opencode', onPath: present })).toThrow(
      NoHeadlessAgentError,
    );
  });

  it('prefers an explicit agent that can run headless', () => {
    expect(pickHeadlessAgent({ agentId: 'codex', onPath: (binary) => binary === 'codex' }).id).toBe(
      'codex',
    );
  });
});

describe('HeadlessRuns', () => {
  it('runs in a temp workspace and returns text', async () => {
    const runs = new HeadlessRuns(
      () => null,
      async ({ cwd, prompt }) => {
        expect(existsSync(cwd)).toBe(true);
        return `echo:${prompt}`;
      },
      present,
    );
    const result = await runs.run({ repoId: 'r1', prompt: 'hello', timeoutSec: 5 });
    expect(result.text).toBe('echo:hello');
    expect(result.agentId).toBe('claude');
  });

  it('cleans the workspace even when exec throws', async () => {
    let cwd = '';
    const runs = new HeadlessRuns(
      () => null,
      async (opts) => {
        cwd = opts.cwd;
        throw new Error('boom');
      },
      present,
    );
    await expect(runs.run({ repoId: 'r1', prompt: 'x', timeoutSec: 1 })).rejects.toThrow('boom');
    expect(existsSync(cwd)).toBe(false);
  });
});

describe('stepsFromAgentText', () => {
  it('parses JSON and marks source agent', () => {
    const steps = stepsFromAgentText('```json\n{"steps":[{"name":"test","cmd":"pnpm test"}]}\n```');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ cmd: 'pnpm test', source: 'agent' });
  });

  it('returns nothing when the model rambles', () => {
    expect(stepsFromAgentText('I cannot help with that')).toEqual([]);
  });
});

describe('memory FTS5', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('retrieves by text with the same scope filter, without a vector table', () => {
    db = openDb(':memory:');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vec'").get(),
    ).toBeUndefined();
    db.prepare(
      `INSERT INTO memory (id, scope, scope_id, kind, text, confidence, created_at)
       VALUES ('m1', 'repo', 'r1', 'fact', 'prefer early return in handlers', 0.9, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO memory (id, scope, scope_id, kind, text, confidence, created_at)
       VALUES ('m2', 'repo', 'r2', 'fact', 'prefer early return in handlers', 0.9, 1)`,
    ).run();
    const hits = searchMemory(db, 'early return', { scope: 'repo', scopeId: 'r1' });
    expect(hits.map((h) => h.id)).toEqual(['m1']);
  });
});
