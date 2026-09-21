import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Db } from '../db/index.js';
import { getTask } from '../db/task-repo.js';
import { git } from './git.js';

/**
 * What a lane learns when verification settles — OSADE-MOSS §M.5.5, §M.5.8.
 *
 * Two opposite lessons, both drawn from the same moment:
 *
 *   - **A pass produces `fix_pattern` rows.** Each diff hunk touching a known call site is
 *     normalised and hashed, so a sibling lane can be told "this exact shape of change passed
 *     here" rather than "lane 3 is green". This is the only evidence in the system strong
 *     enough for §M.2.2 to rank above a convention.
 *   - **A failure produces `discovery_miss` rows.** A TypeScript diagnostic at a `file:line`
 *     that discovery never proposed is a recall failure, recorded with its surrounding pattern.
 *     §M.5.8's point is that recall improves from *real* misses rather than guessed test cases.
 *
 * Neither is allowed to fail a verification. A learner that threw would turn "your tests
 * passed" into "your tests passed but Osade crashed", which is a strictly worse outcome than
 * learning nothing from the run.
 */

export interface LearnOptions {
  readonly now?: () => number;
  readonly onWarning?: (message: string) => void;
}

export interface FinishedRun {
  readonly runId: string;
  readonly taskId: string;
  readonly exitCode: number | null;
  readonly required: boolean;
  readonly headSha: string;
  readonly logPath: string;
}

export class FixPatterns {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #onWarning: (message: string) => void;

  constructor(db: Db, options: LearnOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning ?? (() => {});
  }

  /** Called once per finished run. Never throws — see the file comment. */
  async learn(run: FinishedRun): Promise<void> {
    try {
      if (run.exitCode === 0 && run.required) await this.#recordFixes(run);
      else if (run.exitCode != null && run.exitCode !== 0) await this.#recordMisses(run);
    } catch (err) {
      this.#onWarning(
        `learning from verify run ${run.runId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * §M.5.5 — every hunk that touches a call site becomes a hashed pattern.
   *
   * Scoped to hunks touching known call sites rather than the whole diff: a lane that also
   * reformatted a file would otherwise publish "reformatting passed verification" as evidence
   * to every sibling, and the digest budget is small enough that noise crowds out signal.
   */
  async #recordFixes(run: FinishedRun): Promise<void> {
    const task = getTask(this.#db, run.taskId);
    if (!task) return;
    const cwd = task.worktree_path;
    // An attached lane shares the repository checkout, where a diff against the base is not
    // this lane's work alone. Only isolated lanes produce attributable patterns.
    if (!cwd) return;

    const target = this.#db
      .prepare('SELECT migration_id FROM migration_target WHERE task_id = ?')
      .get(run.taskId) as { migration_id: string } | undefined;

    const sites = this.#callSites(target?.migration_id ?? null, task.repo_id);
    if (sites.size === 0) return;

    const diff = await git(cwd, ['diff', '--unified=3', task.base_sha]).catch(() => '');
    const insert = this.#db.prepare(
      `INSERT INTO fix_pattern (id, task_id, repo_id, migration_id, verify_run_id, head_sha,
                                file, line, pattern_hash, hunk, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, head_sha, file, line) DO NOTHING`,
    );

    const at = this.#now();
    this.#db.transaction(() => {
      for (const hunk of parseHunks(diff)) {
        const touched = sites.get(hunk.file);
        if (!touched) continue;
        const hit = touched.find((line) => line >= hunk.startLine && line <= hunk.endLine);
        if (hit == null) continue;
        insert.run(
          `fp_${randomUUID().slice(0, 8)}`,
          run.taskId,
          task.repo_id,
          target?.migration_id ?? null,
          run.runId,
          run.headSha,
          hunk.file,
          hit,
          patternHash(hunk.body),
          hunk.body.slice(0, 1_200),
          at,
        );
      }
    })();
  }

  /**
   * §M.5.8 — a diagnostic where discovery proposed nothing is a recorded miss.
   *
   * Only for lanes in a migration: outside one there is no discovery run to have missed
   * anything, and every ordinary compile error would be logged as a recall failure.
   */
  async #recordMisses(run: FinishedRun): Promise<void> {
    const target = this.#db
      .prepare('SELECT migration_id, repo_id FROM migration_target WHERE task_id = ?')
      .get(run.taskId) as { migration_id: string; repo_id: string } | undefined;
    if (!target) return;

    const log = await readFile(run.logPath, 'utf8').catch(() => '');
    const diagnostics = parseTsDiagnostics(log);
    if (diagnostics.length === 0) return;

    const known = this.#callSites(target.migration_id, target.repo_id);
    const insert = this.#db.prepare(
      `INSERT INTO discovery_miss (id, migration_id, repo_id, file, line, pattern, verify_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.#db.transaction(() => {
      for (const diagnostic of diagnostics) {
        const lines = known.get(diagnostic.file);
        // Within three lines counts as "discovery found this" — a diagnostic often points at
        // the line after the call it is complaining about.
        if (lines?.some((line) => Math.abs(line - diagnostic.line) <= 3)) continue;
        const already = this.#db
          .prepare(
            'SELECT 1 FROM discovery_miss WHERE migration_id = ? AND repo_id = ? AND file = ? AND line = ?',
          )
          .get(target.migration_id, target.repo_id, diagnostic.file, diagnostic.line);
        if (already) continue;
        insert.run(
          `dm_${randomUUID().slice(0, 8)}`,
          target.migration_id,
          target.repo_id,
          diagnostic.file,
          diagnostic.line,
          diagnostic.message,
          run.runId,
        );
      }
    })();
  }

  #callSites(migrationId: string | null, repoId: string): Map<string, number[]> {
    const rows = migrationId
      ? (this.#db
          .prepare('SELECT file, line FROM call_site WHERE migration_id = ? AND repo_id = ?')
          .all(migrationId, repoId) as { file: string; line: number }[])
      : [];
    const byFile = new Map<string, number[]>();
    for (const row of rows) {
      const list = byFile.get(row.file) ?? [];
      list.push(row.line);
      byFile.set(row.file, list);
    }
    return byFile;
  }
}

export interface Hunk {
  file: string;
  startLine: number;
  endLine: number;
  body: string;
}

/** Splits a unified diff into per-hunk records, keyed by the *new* file's line numbers. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file: string | null = null;
  let current: Hunk | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match || !file) {
        current = null;
        continue;
      }
      const start = Number.parseInt(match[1]!, 10);
      const span = match[2] ? Number.parseInt(match[2], 10) : 1;
      current = { file, startLine: start, endLine: start + Math.max(0, span - 1), body: '' };
      continue;
    }
    if (current && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      current.body += `${line}\n`;
    }
  }
  if (current) hunks.push(current);
  return hunks.filter((hunk) => hunk.body.trim().length > 0);
}

/**
 * §M.5.5 — identifiers α-renamed, whitespace stripped, then hashed.
 *
 * The renaming is what makes the hash a *pattern* rather than a fingerprint of one file: two
 * lanes that both changed `client.search(q)` to `client.query(q, {})` produce the same hash
 * even though their variables are named differently. Keywords and the property names being
 * migrated are left alone — renaming those would collapse genuinely different changes together
 * and the dedupe would start hiding things.
 */
export function patternHash(hunk: string): string {
  return createHash('sha256').update(normaliseHunk(hunk)).digest('hex').slice(0, 32);
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'new', 'await',
  'async', 'import', 'export', 'from', 'class', 'extends', 'this', 'null', 'undefined', 'true',
  'false', 'type', 'interface', 'as', 'of', 'in', 'try', 'catch', 'finally', 'throw', 'typeof',
]);

export function normaliseHunk(hunk: string): string {
  const names = new Map<string, string>();
  let next = 0;

  const alphaRenamed = hunk.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (word, offset: number, whole: string) => {
    if (KEYWORDS.has(word)) return word;
    // A property access is part of the API surface being changed, so it survives verbatim —
    // `.search` becoming `.query` is the whole point of the pattern.
    if (offset > 0 && whole[offset - 1] === '.') return word;
    const existing = names.get(word);
    if (existing) return existing;
    const alias = `v${next++}`;
    names.set(word, alias);
    return alias;
  });

  return alphaRenamed.replace(/\s+/g, '');
}

export interface TsDiagnostic {
  file: string;
  line: number;
  message: string;
}

/**
 * Pulls `path(line,col): error TSxxxx: message` out of a log.
 *
 * Both `tsc`'s default format and the bracketed one some runners emit. Anything it cannot
 * parse is simply not a recorded miss — a heuristic that over-reports would fill
 * `discovery_miss` with noise and make the fixture export worthless.
 */
export function parseTsDiagnostics(log: string): TsDiagnostic[] {
  const out: TsDiagnostic[] = [];
  const seen = new Set<string>();
  const pattern = /^(?:\s*)([^\s(][^(]*?)[:(](\d+)[,:](\d+)\)?:?\s+-?\s*error\s+(TS\d+):\s*(.+)$/gm;

  for (const match of log.matchAll(pattern)) {
    const file = match[1]!.trim().replace(/\\/g, '/');
    const line = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(line)) continue;
    const key = `${file}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The code travels with the message. A fixture that says only "Expected 2 arguments"
    // loses which failure class it is, and TS2554 vs TS2339 is the difference between a
    // signature change and a rename.
    out.push({ file, line, message: `${match[4]!}: ${match[5]!.trim()}` });
  }
  return out;
}
