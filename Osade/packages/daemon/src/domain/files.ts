import { mkdirSync, readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { git } from './git.js';

/**
 * On-demand file tree for a chat's cwd — attached checkout or isolated worktree.
 *
 * The renderer has no filesystem access (§18.1). Paths are always relative to the task cwd
 * and rejected if they climb out of it.
 */

const SKIP = new Set(['.git', 'node_modules', 'dist', '.next', 'target', '__pycache__', '.osade']);
const MAX_READ = 256 * 1024;

export type FileFlag = 'M' | 'A' | 'D' | '?';

export interface FileChange {
  flag: FileFlag;
  insertions: number;
  deletions: number;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  flag: FileFlag | null;
  insertions: number;
  deletions: number;
}

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

export function safeResolve(cwd: string, relativePath: string): string {
  const cleaned = toPosix(relativePath).replace(/^\/+/u, '');
  if (cleaned.split('/').includes('..')) {
    throw new Error('path escapes the chat folder');
  }
  const root = resolve(cwd);
  const resolved = cleaned.length === 0 ? root : resolve(root, cleaned.split('/').join(sep));
  const rel = toPosix(relative(root, resolved));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path escapes the chat folder');
  }
  return resolved;
}

export function parsePorcelain(text: string): Map<string, FileFlag> {
  const out = new Map<string, FileFlag>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    if (xy.includes('R') || xy.includes('C')) {
      const sepAt = rest.lastIndexOf(' -> ');
      if (sepAt >= 0) rest = rest.slice(sepAt + 4);
    }
    if (rest.startsWith('"') && rest.endsWith('"')) {
      rest = rest.slice(1, -1).replace(/\\n/gu, '\n').replace(/\\"/gu, '"');
    }
    out.set(toPosix(rest), flagFromXy(xy));
  }
  return out;
}

export function parseNumstat(text: string): Map<string, { insertions: number; deletions: number }> {
  const out = new Map<string, { insertions: number; deletions: number }>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const insertions = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    out.set(toPosix(parts.slice(2).join('\t')), { insertions, deletions });
  }
  return out;
}

export function mergeChanges(
  porcelain: Map<string, FileFlag>,
  numstat: Map<string, { insertions: number; deletions: number }>,
): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  const paths = new Set([...porcelain.keys(), ...numstat.keys()]);
  for (const path of paths) {
    const stats = numstat.get(path) ?? { insertions: 0, deletions: 0 };
    const flag = porcelain.get(path) ?? 'M';
    out.set(path, { flag, insertions: stats.insertions, deletions: stats.deletions });
  }
  return out;
}

export async function fileChanges(cwd: string, baseSha: string): Promise<Map<string, FileChange>> {
  const [porcelain, numstat] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).catch(() => ''),
    git(cwd, ['diff', '--numstat', baseSha]).catch(() => ''),
  ]);
  return mergeChanges(parsePorcelain(porcelain), parseNumstat(numstat));
}

export function listDir(cwd: string, dir: string, changes: Map<string, FileChange>): FsEntry[] {
  const abs = safeResolve(cwd, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  const prefix = dir.length === 0 ? '' : `${toPosix(dir).replace(/\/$/u, '')}/`;
  const names = readdirSync(abs, { withFileTypes: true }).filter((entry) => !SKIP.has(entry.name));
  const entries = names.map((entry): FsEntry => {
    const path = `${prefix}${entry.name}`;
    const kind = entry.isDirectory() ? 'dir' : 'file';
    const overlay = overlayFor(path, kind, changes);
    return { name: entry.name, path, kind, ...overlay };
  });
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export function readFile(cwd: string, relativePath: string): {
  path: string;
  text: string | null;
  binary: boolean;
  truncated: boolean;
} {
  const abs = safeResolve(cwd, relativePath);
  const info = statSync(abs);
  if (info.isDirectory()) throw new Error('that path is a folder');
  const buf = readFileSync(abs);
  const truncated = buf.length > MAX_READ;
  const slice = truncated ? buf.subarray(0, MAX_READ) : buf;
  if (slice.includes(0)) {
    return { path: toPosix(relativePath), text: null, binary: true, truncated };
  }
  return {
    path: toPosix(relativePath),
    text: slice.toString('utf8'),
    binary: false,
    truncated,
  };
}

export function writeFile(
  cwd: string,
  relativePath: string,
  text: string,
): { path: string; bytes: number } {
  if (Buffer.byteLength(text) > MAX_READ) throw new Error('file is too large to save here');
  const abs = safeResolve(cwd, relativePath);
  if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error('that path is a folder');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  return { path: toPosix(relativePath), bytes: Buffer.byteLength(text) };
}

export interface WorkingChange {
  path: string;
  flag: FileFlag;
  insertions: number;
  deletions: number;
}

export interface OutgoingCommit {
  sha: string;
  subject: string;
}

export async function listWorkingChanges(
  cwd: string,
  baseSha: string,
): Promise<{
  files: WorkingChange[];
  outgoing: { ahead: number; commits: OutgoingCommit[]; files: WorkingChange[] } | null;
}> {
  const changes = await fileChanges(cwd, baseSha);
  const files = [...changes.entries()]
    .map(([path, hit]) => ({ path, flag: hit.flag, insertions: hit.insertions, deletions: hit.deletions }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const range = await outgoingRange(cwd, baseSha);
  if (range == null) return { files, outgoing: null };

  try {
    const ahead = Number((await git(cwd, ['rev-list', '--count', range.revList])).trim()) || 0;
    const log = ahead > 0 ? await git(cwd, ['log', '--format=%h\t%s', range.revList]) : '';
    const commits = log
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() };
      });
    const outgoingFiles =
      ahead > 0
        ? parseNameStatus(
            await git(cwd, ['diff', '--name-status', range.diff]),
            parseNumstat(await git(cwd, ['diff', '--numstat', range.diff])),
          )
        : [];
    return { files, outgoing: { ahead, commits, files: outgoingFiles } };
  } catch {
    return { files, outgoing: null };
  }
}

async function outgoingRange(
  cwd: string,
  baseSha: string,
): Promise<{ revList: string; diff: string } | null> {
  try {
    await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}']);
    return { revList: '@{u}..HEAD', diff: '@{u}...HEAD' };
  } catch {
    try {
      await git(cwd, ['rev-parse', '--verify', baseSha]);
      return { revList: `${baseSha}..HEAD`, diff: `${baseSha}...HEAD` };
    } catch {
      return null;
    }
  }
}

export function parseNameStatus(
  text: string,
  stats: Map<string, { insertions: number; deletions: number }>,
): WorkingChange[] {
  const files: WorkingChange[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const path = toPosix(parts.length >= 3 ? (parts[parts.length - 1] ?? '') : (parts[1] ?? ''));
    if (!path) continue;
    const flag: FileFlag = code.startsWith('D') ? 'D' : code.startsWith('A') ? 'A' : 'M';
    const hit = stats.get(path) ?? { insertions: 0, deletions: 0 };
    files.push({ path, flag, insertions: hit.insertions, deletions: hit.deletions });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readChangeDiff(
  cwd: string,
  relativePath: string,
  vs: 'working' | 'outgoing',
  baseSha: string,
): Promise<{ path: string; flag: FileFlag | null; diff: string }> {
  const path = toPosix(relativePath);
  if (vs === 'outgoing') {
    const range = await outgoingRange(cwd, baseSha);
    const spec = range?.diff ?? `${baseSha}...HEAD`;
    const diff = await git(cwd, ['diff', spec, '--', path]).catch(() => '');
    return { path, flag: 'M', diff };
  }
  const changes = await fileChanges(cwd, baseSha);
  const flag = changes.get(path)?.flag ?? null;
  if (flag === '?') {
    const body = readFile(cwd, path);
    const lines = (body.text ?? '').split('\n');
    const diff = [
      `--- /dev/null`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n');
    return { path, flag, diff };
  }
  const diff = await git(cwd, ['diff', baseSha, '--', path]).catch(() => '');
  return { path, flag, diff };
}

function overlayFor(
  path: string,
  kind: 'dir' | 'file',
  changes: Map<string, FileChange>,
): { flag: FileFlag | null; insertions: number; deletions: number } {
  if (kind === 'file') {
    const hit = changes.get(path);
    return hit
      ? { flag: hit.flag, insertions: hit.insertions, deletions: hit.deletions }
      : { flag: null, insertions: 0, deletions: 0 };
  }
  const prefix = `${path}/`;
  let insertions = 0;
  let deletions = 0;
  let flag: FileFlag | null = null;
  for (const [changed, hit] of changes) {
    if (changed !== path && !changed.startsWith(prefix)) continue;
    insertions += hit.insertions;
    deletions += hit.deletions;
    flag = strongerFlag(flag, hit.flag);
  }
  return { flag, insertions, deletions };
}

function flagFromXy(xy: string): FileFlag {
  if (xy === '??') return '?';
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  return 'M';
}

function strongerFlag(current: FileFlag | null, next: FileFlag): FileFlag {
  if (current === 'D' || next === 'D') return 'D';
  if (current === 'A' || next === 'A' || current === '?' || next === '?') {
    return current === 'A' || next === 'A' ? 'A' : '?';
  }
  return 'M';
}
