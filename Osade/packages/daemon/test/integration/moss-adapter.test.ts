import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../../src/db/index.js';
import {
  MossAdapter,
  toMossFilter,
  type MossClientLike,
  type MossDoc,
  type MossQueryResult,
  type MossSessionLike,
} from '../../src/retrieval/moss-adapter.js';
import { RetrievalService } from '../../src/retrieval/service.js';

/**
 * OSADE-MOSS §M.1.2, §M.1.3 — the Moss adapter, against a stand-in session.
 *
 * The stand-in implements the surface the real `SessionIndex` exposes (`addDocs`, `deleteDocs`,
 * `query`, `saveToDisk`, `loadFromDisk`, `docCount`), so these tests pin the *contract* the
 * adapter relies on. They deliberately do not talk to Moss: a test that needs a project key is
 * a test that stops running.
 */

const NOW = 1_756_000_000_000;

class FakeSession implements MossSessionLike {
  readonly docs = new Map<string, MossDoc>();
  saved: string | null = null;
  loadedFrom: string | null = null;
  pushed = 0;
  lastQuery: Record<string, unknown> | null = null;
  /** Set to make loadFromDisk reject, standing in for a corrupt cache (§M.1.3). */
  loadFails = false;

  constructor(readonly name: string) {}

  get docCount(): number {
    return this.docs.size;
  }

  async addDocs(docs: MossDoc[]): Promise<void> {
    for (const doc of docs) this.docs.set(doc.id, doc);
  }

  async deleteDocs(ids: string[]): Promise<void> {
    for (const id of ids) this.docs.delete(id);
  }

  async query(text: string, options: Record<string, unknown>): Promise<MossQueryResult> {
    this.lastQuery = options;
    return {
      docs: [...this.docs.values()].map((doc, i) => ({
        id: doc.id,
        score: 1 - i * 0.1,
        text: doc.text,
        metadata: doc.metadata,
      })),
    };
  }

  async saveToDisk(path: string): Promise<void> {
    this.saved = path;
  }

  async loadFromDisk(path: string): Promise<void> {
    if (this.loadFails) throw new Error('corrupt cache');
    this.loadedFrom = path;
  }

  async pushIndex(): Promise<void> {
    this.pushed += 1;
  }
}

class FakeClient implements MossClientLike {
  readonly sessions: FakeSession[] = [];
  /** Applied to every session as it is created, so a whole-client failure mode is one line. */
  onCreate: ((session: FakeSession) => void) | null = null;

  async session(name: string): Promise<MossSessionLike> {
    const session = new FakeSession(name);
    this.onCreate?.(session);
    this.sessions.push(session);
    return session;
  }

  /**
   * The *live* session for a namespace.
   *
   * A rebuild drops and reopens each session under a new generation suffix (§M.1.4), so the
   * first session with a given namespace is not the one the adapter is writing to afterwards.
   * Reaching for `sessions[0]` is how this test first went wrong.
   */
  live(ns: string): FakeSession | undefined {
    return [...this.sessions].reverse().find((s) => s.name.split('.')[2] === ns);
  }
}

let db: Db;
let home: string;

beforeEach(() => {
  db = openDb(':memory:');
  home = mkdtempSync(join(tmpdir(), 'osade-moss-'));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('§M.1.3 — one session per namespace', () => {
  it('opens all five up front, so bad credentials fail at boot not on a turn', async () => {
    const client = new FakeClient();
    await MossAdapter.open({
      projectId: 'p',
      projectKey: 'k',
      installId: 'abc',
      loadClient: async () => client,
    });
    expect(client.sessions.map((s) => s.name)).toEqual([
      'osade.abc.turns',
      'osade.abc.conventions',
      'osade.abc.policies',
      'osade.abc.code',
      'osade.abc.prs',
    ]);
  });

  it('never pushes to the cloud unless cloudSync is on — transcripts stay local', async () => {
    const client = new FakeClient();
    const adapter = await MossAdapter.open({
      projectId: 'p',
      projectKey: 'k',
      installId: 'abc',
      loadClient: async () => client,
    });
    await adapter.close();
    expect(client.sessions.every((s) => s.pushed === 0)).toBe(true);

    const syncing = new FakeClient();
    const withSync = await MossAdapter.open({
      projectId: 'p',
      projectKey: 'k',
      installId: 'abc',
      cloudSync: true,
      loadClient: async () => syncing,
    });
    await withSync.close();
    expect(syncing.sessions.every((s) => s.pushed === 1)).toBe(true);
  });
});

describe('§M.1.6 — per-namespace query settings reach the SDK', () => {
  it('sends the namespace alpha when the caller does not override it', async () => {
    const client = new FakeClient();
    const adapter = await MossAdapter.open({
      projectId: 'p',
      projectKey: 'k',
      installId: 'abc',
      loadClient: async () => client,
    });

    await adapter.query('conventions', 'imports', { topK: 8 });
    expect(client.live('conventions')?.lastQuery).toMatchObject({ topK: 8, alpha: 0.8 });

    // Code is the one namespace tuned toward keyword matching: identifiers carry half the
    // signal, and pure semantic loses exact symbol matches.
    await adapter.query('code', 'MossClient#search', { topK: 50 });
    expect(client.live('code')?.lastQuery).toMatchObject({ alpha: 0.5 });
  });
});

describe('§M.1.2 — filter translation', () => {
  it('passes a single condition bare, as the SDK documents', () => {
    expect(toMossFilter([{ field: 'repo_id', condition: { $eq: 'r1' } }])).toEqual({
      field: 'repo_id',
      condition: { $eq: 'r1' },
    });
  });

  it('wraps a conjunction in $and', () => {
    expect(
      toMossFilter([
        { field: 'chat_id', condition: { $eq: 'c1' } },
        { field: 'verified', condition: { $eq: '1' } },
      ]),
    ).toEqual({
      $and: [
        { field: 'chat_id', condition: { $eq: 'c1' } },
        { field: 'verified', condition: { $eq: '1' } },
      ],
    });
  });

  it('sends no filter at all when there is nothing to filter on', () => {
    expect(toMossFilter([])).toBeNull();
  });
});

describe('§M.1.3 — warm boot', () => {
  function seedTurn(): void {
    db.prepare('INSERT INTO org (id, name, created_at) VALUES (?, ?, ?)').run('o1', 'acme', NOW);
    db.prepare(
      'INSERT INTO repo (id, org_id, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('r1', 'o1', '/repo', 'main', NOW);
    db.prepare(
      `INSERT INTO task (id, repo_id, title, intent, origin_kind, chat_id, base_ref, base_sha,
                         branch, worktree_path, agent_id, created_at)
       VALUES ('t1', 'r1', 'x', 'x', 'manual', 'chat1', 'main', 'base000', 'osade/t1', '/wt', 'claude', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES ('ct_1', 't1', 1, 'user', 'human', 'rename search to query', 'accepted', ?)`,
    ).run(NOW);
  }

  const env = (root: string) => ({
    OSADE_HOME: root,
    MOSS_PROJECT_ID: 'p',
    MOSS_PROJECT_KEY: 'k',
  });

  it('rebuilds from SQLite on a cold boot, because there is no snapshot yet', async () => {
    seedTurn();
    const client = new FakeClient();
    const service = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => client,
      onWarning: () => {},
    });

    expect(service.backend).toBe('moss');
    // The turn reached the index without the indexer's timer ever running.
    expect(client.live('turns')?.docs.has('turns:chat_turn:ct_1')).toBe(true);
  });

  it('snapshots on close and restores on the next boot', async () => {
    seedTurn();
    const first = new FakeClient();
    const service = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => first,
      onWarning: () => {},
    });
    await service.indexer.drain();
    await service.close();

    expect(first.live('turns')?.saved).toBe(join(home, 'moss', 'turns'));

    const second = new FakeClient();
    const reopened = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => second,
      onWarning: () => {},
    });

    // Restored rather than rebuilt: the sessions were loaded from disk and the projector
    // never ran again.
    expect(second.live('turns')?.loadedFrom).toBe(join(home, 'moss', 'turns'));
    expect(second.live('turns')?.docs.size).toBe(0);
    await reopened.close();
  });

  it('a corrupt cache is never an error — it rebuilds', async () => {
    seedTurn();
    const first = new FakeClient();
    const service = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => first,
      onWarning: () => {},
    });
    await service.indexer.drain();
    await service.close();

    const second = new FakeClient();
    const reopened = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => {
        // Every session refuses to load, as a corrupt snapshot directory would.
        second.onCreate = (session) => {
          session.loadFails = true;
        };
        return second;
      },
      onWarning: () => {},
    });

    expect(reopened.backend).toBe('moss');
    // Rebuilt from SQLite, so the document is present despite the failed restore.
    expect(second.live('turns')?.docs.has('turns:chat_turn:ct_1')).toBe(true);
    await reopened.close();
  });

  it('refuses a snapshot whose cursor does not match, and rebuilds instead', async () => {
    seedTurn();
    const first = new FakeClient();
    const service = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => first,
      onWarning: () => {},
    });
    await service.indexer.drain();
    await service.close();

    // A row arrives while the daemon is down: the snapshot on disk is now behind the cursor
    // it was stamped at, and the rows in between are already pruned from retrieval_log.
    db.prepare(
      `INSERT INTO chat_turn (id, task_id, seq, role, origin, text, delivery, created_at)
       VALUES ('ct_2', 't1', 2, 'user', 'human', 'and update the wrapper', 'accepted', ?)`,
    ).run(NOW + 1);
    db.prepare("UPDATE retrieval_cursor SET last_seq = last_seq + 50 WHERE consumer = 'indexer'").run();

    const second = new FakeClient();
    const reopened = await RetrievalService.open(db, {
      env: env(home),
      loadMossClient: async () => second,
      onWarning: () => {},
    });

    expect(second.live('turns')?.loadedFrom).toBeNull();
    // Rebuilt, so both turns are present — nothing was silently lost.
    expect(second.live('turns')?.docs.has('turns:chat_turn:ct_1')).toBe(true);
    expect(second.live('turns')?.docs.has('turns:chat_turn:ct_2')).toBe(true);
    await reopened.close();
  });
});

describe('§M.1.4 R3 — an SDK that will not load is not a boot failure', () => {
  it('falls back to FTS5 and says why', async () => {
    const service = await RetrievalService.open(db, {
      env: { OSADE_HOME: home, MOSS_PROJECT_ID: 'p', MOSS_PROJECT_KEY: 'k' },
      loadMossClient: async () => {
        throw new Error('native addon missing');
      },
      onWarning: () => {},
    });

    const stats = await service.stats();
    expect(stats.backend).toBe('fts5');
    expect(stats.mossConfigured).toBe(true);
    expect(stats.degradedReason).toContain('native addon missing');
  });
});
