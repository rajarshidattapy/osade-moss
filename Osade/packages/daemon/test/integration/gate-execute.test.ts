import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import { Gates } from '../../src/domain/gates.js';
import type { LaunchTask } from '../../src/domain/launch-task.js';
import type { Triage } from '../../src/domain/triage.js';
import type { VerifyRunner } from '../../src/domain/verify-run.js';
import type { ScmPoller } from '../../src/scm/poller.js';
import type { OpenPrPayload, ScmWrites } from '../../src/scm/writes.js';
import { startDaemonServer, type RunningDaemon } from '../../src/server/index.js';

/**
 * Approving a public-write gate has to perform the write. The recorded M2 suite already
 * proves `ScmWrites.openPr` itself; this is the live path the UI actually takes — `gateDecide`.
 */

const NOW = 1_756_000_000_000;

const payload: OpenPrPayload = {
  title: 'fix: handle an empty config',
  body: 'Closes #417.',
  head: 'osade/fix',
  base: 'main',
  draft: false,
};

let db: Db;
let daemon: RunningDaemon;
let home: string;
let gates: Gates;
const opened: { taskId: string; gateId: string; payload: OpenPrPayload }[] = [];
const commented: { taskId: string; gateId: string; payload: { body: string }; issueNumber: number }[] =
  [];

beforeEach(async () => {
  opened.length = 0;
  commented.length = 0;
  home = mkdtempSync(join(tmpdir(), 'osade-gate-exec-'));
  process.env.OSADE_HOME = home;
  db = openDb(':memory:');
  gates = new Gates(db, { now: () => NOW });

  db.prepare('INSERT INTO org (id, name, created_at) VALUES (?,?,?)').run('o1', 'acme', NOW);
  db.prepare(
    `INSERT INTO repo (id, org_id, path, gh_owner, gh_name, default_branch, created_at)
     VALUES ('r1','o1','/repo','acme','widget','main',?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO task (id, repo_id, title, intent, origin_kind, origin_ref, base_ref, base_sha,
                       branch, worktree_path, created_at)
     VALUES ('t1','r1','#417 crash','fix it','issue','https://github.com/acme/widget/issues/417',
             'main','headsha','osade/fix','/wt',?)`,
  ).run(NOW);

  const scmWrites = {
    openPr: async (taskId: string, gateId: string, next: OpenPrPayload) => {
      opened.push({ taskId, gateId, payload: next });
      return { number: 88, url: 'https://github.com/acme/widget/pull/88' };
    },
    comment: async (
      taskId: string,
      gateId: string,
      next: { body: string },
      target: { issueNumber: number },
    ) => {
      commented.push({ taskId, gateId, payload: next, issueNumber: target.issueNumber });
      return { url: 'https://github.com/acme/widget/issues/417#issuecomment-1' };
    },
  } as unknown as ScmWrites;

  daemon = await startDaemonServer({
    db,
    launcher: {} as LaunchTask,
    gates,
    verifier: {} as VerifyRunner,
    triage: {} as Triage,
    scmWrites,
    poller: {} as ScmPoller,
    now: () => NOW,
  });
});

afterEach(async () => {
  await daemon.close();
  db.close();
  delete process.env.OSADE_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function mutate(path: string, input: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result?.data;
}

describe('approving a public write executes it', () => {
  it('gateDecide on gate.pr_open opens the pull request', async () => {
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    expect(opened).toHaveLength(0);

    await mutate('gateDecide', { gateId, decision: 'approve' });

    expect(opened).toEqual([{ taskId: 't1', gateId, payload }]);
  });

  it('gateDecide on gate.issue_comment posts the comment to the originating issue', async () => {
    const body = { body: 'Reproduces on main.\n\n---\n_Produced by an agent through Osade, and reviewed by a human before posting._' };
    const gateId = gates.request({ taskId: 't1', gate: 'gate.issue_comment', payload: body });

    await mutate('gateDecide', { gateId, decision: 'approve' });

    expect(commented).toEqual([{ taskId: 't1', gateId, payload: body, issueNumber: 417 }]);
  });

  it('denying a gate writes nothing', async () => {
    const gateId = gates.request({ taskId: 't1', gate: 'gate.pr_open', payload });
    await mutate('gateDecide', { gateId, decision: 'deny' });
    expect(opened).toHaveLength(0);
  });
});
