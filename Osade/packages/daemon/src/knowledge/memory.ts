import type { Db } from '../db/index.js';

/**
 * Memory retrieval via FTS5 — docs/agent_handler.md §3.
 *
 * OSADE.md §15 assumed a vector store. That needs an embedding model and a key; FTS5 uses
 * what SQLite already ships. `memory_vec` is not created.
 */

export interface MemoryHit {
  id: string;
  scope: string;
  scopeId: string | null;
  kind: string;
  text: string;
  confidence: number;
}

export function searchMemory(
  db: Db,
  query: string,
  filters: { scope?: string; scopeId?: string | null } = {},
  limit = 8,
): MemoryHit[] {
  const q = ftsQuery(query);
  if (q == null) return [];
  const where: string[] = ['memory_fts MATCH ?'];
  const params: unknown[] = [q];
  if (filters.scope) {
    where.push('memory.scope = ?');
    params.push(filters.scope);
  }
  if (filters.scopeId !== undefined) {
    if (filters.scopeId == null) where.push('memory.scope_id IS NULL');
    else {
      where.push('memory.scope_id = ?');
      params.push(filters.scopeId);
    }
  }
  params.push(limit);
  return (
    db
      .prepare(
        `SELECT memory.id, memory.scope, memory.scope_id AS scopeId, memory.kind, memory.text, memory.confidence
           FROM memory
           JOIN memory_fts ON memory.rowid = memory_fts.rowid
          WHERE ${where.join(' AND ')}
          LIMIT ?`,
      )
      .all(...params) as MemoryHit[]
  );
}

/** Quote tokens so FTS5 operators in user text cannot change the query. */
function ftsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["*]/g, ''))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' AND ');
}
