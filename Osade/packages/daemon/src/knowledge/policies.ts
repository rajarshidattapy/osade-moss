import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Db } from '../db/index.js';
import { osadePaths } from '../paths.js';

/**
 * Policy files — OSADE-MOSS §M.8.1.
 *
 * Markdown, because the format has to be plain enough to paste an internal policy, a SOC 2
 * control list or a licence rule into without rewriting it. A heading with an id prefix is a
 * clause:
 *
 * ```markdown
 * ---
 * title: Security policy
 * ---
 *
 * ## SEC-3.2 Secrets in code
 * requires_ack: true
 * applies_to: src/**, config/**
 *
 * No credential, token or private key may be committed to the repository.
 * ```
 *
 * **INVARIANT C1: a compliance flag without a cited clause is not a flag.** Everything the gate
 * card can show comes from a heading in a file at a known content hash. There is no path by
 * which a model's opinion becomes a clause — the loader only reads files, and the indexer only
 * reads this table.
 */

export type PolicyScope = 'repo' | 'global';

export interface LoadedClause {
  readonly clauseRef: string;
  readonly title: string;
  readonly text: string;
  readonly requiresAck: boolean;
  /** Path globs, already split. Empty means the clause applies everywhere in scope. */
  readonly appliesTo: readonly string[];
}

export interface LoadedPolicy {
  readonly path: string;
  readonly fileSha: string;
  readonly title: string;
  readonly clauses: readonly LoadedClause[];
}

/** `## SEC-3.2 Secrets in code` — the id prefix is what makes a heading a clause. */
const CLAUSE_HEADING = /^(#{2,3})\s+([A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)+)\s+(.*)$/;

/**
 * Parses one policy file.
 *
 * A heading without an id prefix is prose, not a clause, and is skipped. That is deliberate:
 * a policy document has section headings a human wrote for readability, and turning those into
 * citable clauses would produce references like "Introduction" on an approval card.
 */
export function parsePolicy(path: string, source: string): LoadedPolicy {
  const fileSha = createHash('sha256').update(source).digest('hex');
  const { frontmatter, body } = splitFrontmatter(source);
  const title = frontmatter.title ?? lastSegment(path);

  const clauses: LoadedClause[] = [];
  let current: { ref: string; title: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const { attributes, text } = splitAttributes(current.lines.join('\n'));
    if (text.trim().length > 0) {
      clauses.push({
        clauseRef: current.ref,
        title: current.title.trim(),
        text: text.trim(),
        // Default false at every level: a clause that blocks the approve button is a
        // deliberate decision by whoever wrote the policy, never something inherited.
        requiresAck: truthy(attributes.requires_ack ?? frontmatter.requires_ack),
        appliesTo: globs(attributes.applies_to ?? frontmatter.applies_to),
      });
    }
    current = null;
  };

  for (const line of body.split('\n')) {
    const heading = CLAUSE_HEADING.exec(line);
    if (heading) {
      flush();
      current = { ref: heading[2]!, title: heading[3] ?? '', lines: [] };
      continue;
    }
    // A plain heading ends the previous clause without starting a new one, so prose after a
    // clause does not get silently attributed to it.
    if (/^#{1,3}\s/.test(line)) {
      flush();
      continue;
    }
    current?.lines.push(line);
  }
  flush();

  return { path, fileSha, title, clauses };
}

export interface PolicySource {
  readonly scope: PolicyScope;
  readonly repoId: string | null;
  readonly dir: string;
}

/** §M.8.1 — repo policies at `<repo>/.osade/policies/`, global at `~/.osade/policies/`. */
export function policySources(
  repos: readonly { id: string; path: string }[],
  env: NodeJS.ProcessEnv = process.env,
): PolicySource[] {
  const sources: PolicySource[] = [
    { scope: 'global', repoId: null, dir: join(osadePaths(env).root, 'policies') },
  ];
  for (const repo of repos) {
    sources.push({ scope: 'repo', repoId: repo.id, dir: join(repo.path, '.osade', 'policies') });
  }
  return sources;
}

export interface ReloadResult {
  readonly policies: number;
  readonly clauses: number;
  readonly removed: number;
}

/**
 * Re-reads every policy file and replaces the rows whose content changed.
 *
 * Replacement is keyed on `file_sha`: a file that has not changed keeps its clause ids, so a
 * gate approved against those clauses still hashes the same. A file that *has* changed gets new
 * clause ids, which changes any pending gate's `clauses_hash` and makes the old approval
 * unexecutable — §M.8.2's stated behaviour, and the reason the hash is part of the payload.
 */
export function reloadPolicies(
  db: Db,
  options: { env?: NodeJS.ProcessEnv; onWarning?: (message: string) => void } = {},
): ReloadResult {
  const onWarning = options.onWarning ?? (() => {});
  const repos = db.prepare('SELECT id, path FROM repo').all() as { id: string; path: string }[];
  const now = Date.now();

  let policies = 0;
  let clauses = 0;
  const seen = new Set<string>();

  for (const source of policySources(repos, options.env)) {
    for (const file of markdownFiles(source.dir)) {
      let parsed: LoadedPolicy;
      try {
        parsed = parsePolicy(file, readFileSync(file, 'utf8'));
      } catch (err) {
        onWarning(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (parsed.clauses.length === 0) continue;

      const existing = db
        .prepare(
          'SELECT id, file_sha FROM policy WHERE scope = ? AND repo_id IS ? AND path = ?',
        )
        .get(source.scope, source.repoId, parsed.path) as
        | { id: string; file_sha: string }
        | undefined;

      seen.add(`${source.scope}\u0000${source.repoId ?? ''}\u0000${parsed.path}`);

      if (existing?.file_sha === parsed.fileSha) {
        policies += 1;
        continue;
      }

      const policyId = existing?.id ?? `pol_${randomUUID().slice(0, 8)}`;
      db.transaction(() => {
        if (existing) {
          // Cascades the old clauses away, which is what makes an approval bound to them fail
          // its re-hash rather than silently pointing at rewritten text.
          db.prepare('DELETE FROM policy WHERE id = ?').run(existing.id);
        }
        db.prepare(
          `INSERT INTO policy (id, scope, repo_id, path, file_sha, title, loaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(policyId, source.scope, source.repoId, parsed.path, parsed.fileSha, parsed.title, now);

        const insert = db.prepare(
          `INSERT INTO policy_clause (id, policy_id, clause_ref, title, text, requires_ack, applies_to)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const clause of parsed.clauses) {
          insert.run(
            `pc_${randomUUID().slice(0, 8)}`,
            policyId,
            clause.clauseRef,
            clause.title,
            clause.text,
            clause.requiresAck ? 1 : 0,
            clause.appliesTo.length > 0 ? clause.appliesTo.join('\n') : null,
          );
          clauses += 1;
        }
      })();
      policies += 1;
    }
  }

  // A policy file that was deleted stops applying. Leaving its clauses behind would show a
  // rule on an approval card that no longer exists in the repository.
  const all = db.prepare('SELECT id, scope, repo_id, path FROM policy').all() as {
    id: string;
    scope: string;
    repo_id: string | null;
    path: string;
  }[];
  let removed = 0;
  for (const row of all) {
    if (seen.has(`${row.scope}\u0000${row.repo_id ?? ''}\u0000${row.path}`)) continue;
    db.prepare('DELETE FROM policy WHERE id = ?').run(row.id);
    removed += 1;
  }

  return { policies, clauses, removed };
}

/**
 * §M.8.2 — `applies_to` globs, checked in code after retrieval.
 *
 * A deliberately small glob dialect: `*` within a segment, `**` across segments. Anything more
 * would need a dependency, and the whole point of the format is that a compliance officer can
 * write it without learning one.
 */
export function appliesToPath(globsList: readonly string[], path: string): boolean {
  if (globsList.length === 0) return true;
  const target = path.replace(/\\/g, '/');
  return globsList.some((glob) => globToRegExp(glob).test(target));
}

function globToRegExp(glob: string): RegExp {
  // Placeholders, so the `**` forms survive the single-`*` pass without being rewritten by it.
  const ANY_DIRS = '\u0001';
  const ANY = '\u0002';
  const escaped = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**/` may match nothing, so `**/x.ts` also matches a bare `x.ts`. A trailing `**`
    // matches any depth — which is what `src/**` plainly means, and what the first version of
    // this got wrong by requiring the path to end where the `**` did.
    .replace(/\*\*\//g, ANY_DIRS)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(ANY_DIRS, 'g'), '(?:.*/)?')
    .replace(new RegExp(ANY, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    // No policies directory is the normal case, not an error.
    return [];
  }
}

function splitFrontmatter(source: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { frontmatter: {}, body: source };
  return {
    frontmatter: parseAttributes(match[1]!),
    body: source.slice(match[0].length),
  };
}

/** Leading `key: value` lines under a clause heading are its attributes; the rest is its text. */
function splitAttributes(block: string): { attributes: Record<string, string>; text: string } {
  const lines = block.split('\n');
  const attributeLines: string[] = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      if (attributeLines.length === 0) continue;
      index += 1;
      break;
    }
    if (!/^\s*(requires_ack|applies_to)\s*:/i.test(line)) break;
    attributeLines.push(line);
  }
  return {
    attributes: parseAttributes(attributeLines.join('\n')),
    text: lines.slice(index).join('\n'),
  };
}

function parseAttributes(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]!.toLowerCase()] = match[2]!.trim();
  }
  return out;
}

function truthy(value: string | undefined): boolean {
  return value != null && /^(true|yes|1)$/i.test(value.trim());
}

function globs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((glob) => glob.trim().replace(/^["']|["']$/g, ''))
    .filter((glob) => glob.length > 0);
}

function lastSegment(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}
