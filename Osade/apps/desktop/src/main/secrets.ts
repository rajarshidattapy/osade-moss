import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { safeStorage } from 'electron';

/**
 * GitHub token storage — OSADE.md §2.1 / §18.1.
 *
 * The daemon never holds a token in its config file. Electron `safeStorage` encrypts it; the
 * ciphertext lives under `~/.osade/secrets/`. At spawn the plaintext is passed to the daemon
 * over the env handshake and held in memory only.
 *
 * `OSADE_GITHUB_TOKEN` in the process environment wins, so a developer (or M2/M3 acceptance)
 * can still inject a token without going through the UI.
 */

let sessionToken: string | null = null;

function osadeRoot(): string {
  return process.env.OSADE_HOME ?? join(homedir(), '.osade');
}

function secretFile(): string {
  return join(osadeRoot(), 'secrets', 'github');
}

export function githubToken(): string | null {
  const fromEnv = process.env.OSADE_GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (sessionToken) return sessionToken;
  if (!existsSync(secretFile())) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(secretFile()));
  } catch {
    return null;
  }
}

export function setGithubToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) throw new Error('the GitHub token was empty');
  sessionToken = trimmed;
  if (!safeStorage.isEncryptionAvailable()) return;
  const dir = join(osadeRoot(), 'secrets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(secretFile(), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

export function clearGithubToken(): void {
  sessionToken = null;
  rmSync(secretFile(), { force: true });
}
