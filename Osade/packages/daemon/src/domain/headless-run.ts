import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_CATALOG,
  agentEntry,
  binaryOnPath,
  hasCapability,
  resolveBinaryOnPath,
  type AgentCatalogEntry,
} from './agent-catalog.js';

/**
 * Headless generation through an agent the user already installed — docs/agent_handler.md §2.
 *
 * Empty temp cwd, no task worktree. The agent must not touch the repo.
 */

export class NoHeadlessAgentError extends Error {
  constructor() {
    super(
      'no installed agent can run headless. Install Claude Code or Codex, or pick one in repo settings.',
    );
    this.name = 'NoHeadlessAgentError';
  }
}

export interface HeadlessRunInput {
  repoId: string;
  agentId?: string;
  prompt: string;
  timeoutSec?: number;
}

export type HeadlessExec = (opts: {
  command: string;
  args: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
}) => Promise<string>;

export function pickHeadlessAgent(opts: {
  agentId?: string;
  repoDefault?: string | null;
  onPath?: (binary: string) => boolean;
}): AgentCatalogEntry {
  const onPath = opts.onPath ?? binaryOnPath;
  const eligible = (id: string): AgentCatalogEntry | null => {
    const entry = agentEntry(id);
    if (!entry) return null;
    if (!hasCapability(entry, 'headless-run')) return null;
    if (entry.headlessArgs.length === 0) return null;
    if (!onPath(entry.binary)) return null;
    return entry;
  };

  if (opts.agentId) {
    const picked = eligible(opts.agentId);
    if (picked) return picked;
    throw new NoHeadlessAgentError();
  }
  if (opts.repoDefault) {
    const picked = eligible(opts.repoDefault);
    if (picked) return picked;
  }
  for (const entry of AGENT_CATALOG) {
    const picked = eligible(entry.id);
    if (picked) return picked;
  }
  throw new NoHeadlessAgentError();
}

export async function defaultHeadlessExec(opts: {
  command: string;
  args: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = resolveBinaryOnPath(opts.command) ?? opts.command;
    const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, [...opts.args], {
      cwd: opts.cwd,
      env: process.env,
      windowsHide: true,
      shell: windowsScript,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`headless run timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      if (code !== 0 && out.trim().length === 0) {
        finish(() => reject(new Error(err.trim() || `headless agent exited ${code ?? 'null'}`)));
        return;
      }
      finish(() => resolve(out.trim() || err.trim()));
    });
    try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

export class HeadlessRuns {
  readonly #repoDefault: (repoId: string) => string | null;
  readonly #exec: HeadlessExec;
  readonly #onPath: (binary: string) => boolean;

  constructor(
    repoDefault: (repoId: string) => string | null,
    exec: HeadlessExec = defaultHeadlessExec,
    onPath: (binary: string) => boolean = binaryOnPath,
  ) {
    this.#repoDefault = repoDefault;
    this.#exec = exec;
    this.#onPath = onPath;
  }

  available(repoId: string, agentId?: string): boolean {
    try {
      pickHeadlessAgent({
        agentId,
        repoDefault: this.#repoDefault(repoId),
        onPath: this.#onPath,
      });
      return true;
    } catch {
      return false;
    }
  }

  async run(input: HeadlessRunInput): Promise<{ text: string; agentId: string }> {
    const entry = pickHeadlessAgent({
      agentId: input.agentId,
      repoDefault: this.#repoDefault(input.repoId),
      onPath: this.#onPath,
    });
    const cwd = mkdtempSync(join(tmpdir(), 'osade-headless-'));
    try {
      const text = await this.#exec({
        command: entry.binary,
        args: entry.headlessArgs,
        cwd,
        prompt: input.prompt,
        timeoutMs: (input.timeoutSec ?? 120) * 1000,
      });
      return { text, agentId: entry.id };
    } finally {
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
      } catch {
        // temp sweeper
      }
    }
  }
}
