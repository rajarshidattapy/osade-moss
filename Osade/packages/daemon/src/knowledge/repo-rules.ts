import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES_DIR = '.osade';
export const RULES_FILE = 'rules.md';

export function repoRulesPath(repoPath: string): string {
  return join(repoPath, RULES_DIR, RULES_FILE);
}

/** Creates `<repo>/.osade/rules.md` if missing. Does not overwrite. */
export function ensureRepoRules(repoPath: string): string {
  const dir = join(repoPath, RULES_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, RULES_FILE);
  if (!existsSync(path)) writeFileSync(path, '', 'utf8');
  return path;
}

export function readRepoRules(repoPath: string): string {
  const path = ensureRepoRules(repoPath);
  return readFileSync(path, 'utf8');
}

export function writeRepoRules(repoPath: string, text: string): void {
  const path = ensureRepoRules(repoPath);
  writeFileSync(path, text, 'utf8');
}
