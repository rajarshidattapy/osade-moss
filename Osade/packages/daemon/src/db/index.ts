import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Opens the Osade database and applies pending migrations.
 *
 * OSADE.md §2.2 — INVARIANT: everything Osade writes lives under `~/.osade/`. The caller
 * passes the path; nothing here reaches for a platform default.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const nativeBinding = sqliteAddon();
  const db = nativeBinding ? new Database(path, { nativeBinding }) : new Database(path);

  // WAL so the CDC poller can read while writers commit.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Wait out a checkpoint or a briefly overlapping writer. Still SQLITE_BUSY after this
  // means another process is holding osade.db — callers must not treat that as fatal.
  db.pragma('busy_timeout = 10000');

  migrate(db);
  return db;
}

/**
 * Where better-sqlite3's native addon is, when it cannot find it itself.
 *
 * Left alone, better-sqlite3 resolves through the `bindings` package, which walks upward looking
 * for a `node_modules/better-sqlite3/build`. That works in a checkout running from source and
 * fails for a *bundle*, which is one file with no such layout above it — packaged beside its
 * addon, or built to `dist/` beside the package's own node_modules.
 *
 * Checked in order, and null when none exists, because letting `bindings` try is the right
 * answer for the unbundled case rather than an error.
 */
function sqliteAddon(): string | undefined {
  const explicit = process.env.OSADE_SQLITE_BINDING;
  if (explicit && existsSync(explicit)) return explicit;

  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }

  const candidates = [
    // Packaged: the addon ships beside the bundle.
    join(here, 'better_sqlite3.node'),
    // Built to dist/: the package's own node_modules is one level up.
    join(here, '..', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migration')
      .all()
      .map((r) => (r as { id: number }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    // Forward-only and atomic: a half-applied migration is worse than a failed boot.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        Date.now(),
      );
    });
    run();
  }
}

/** Current high-water mark in `change_log`. A fresh database is 0. */
export function currentWatermark(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log').get() as {
    seq: number;
  };
  return row.seq;
}

/**
 * §5.4 — retain the last 50k rows; prune on a timer.
 *
 * Returns the oldest surviving seq so the broadcaster can tell a client its watermark was
 * pruned and it needs a fresh snapshot, rather than silently skipping changes.
 */
export function pruneChangeLog(db: Db, retain = 50_000): number {
  db.prepare(
    `DELETE FROM change_log
      WHERE seq <= (SELECT COALESCE(MAX(seq), 0) - ? FROM change_log)`,
  ).run(retain);
  const row = db.prepare('SELECT COALESCE(MIN(seq), 0) AS seq FROM change_log').get() as {
    seq: number;
  };
  return row.seq;
}

export { MIGRATIONS, CDC_TABLES } from './migrations.js';
export type { Migration, CdcTable } from './migrations.js';
