import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';

/**
 * A real PTY in the lane's cwd — PowerShell on Windows, $SHELL elsewhere.
 *
 * Pipes are not a TTY: backspace, cls, and CLIs like Claude all fail. This is not the agent's
 * substrate pane. Killing the shell does not touch the agent.
 */

const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');

export function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { command: process.env.SHELL || '/bin/bash', args: ['-i'] };
}

function shellEnv(): { [key: string]: string | undefined } {
  const extra: string[] = [];
  if (process.platform === 'win32') {
    const npm = join(homedir(), 'AppData', 'Roaming', 'npm');
    if (existsSync(npm)) extra.push(npm);
  }
  const pathKey = extra.length > 0 ? (process.env.Path != null ? 'Path' : 'PATH') : null;
  const current = process.env.Path ?? process.env.PATH ?? '';
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...(pathKey ? { [pathKey]: extra.join(delimiter) + delimiter + current } : {}),
  };
}

export interface PtySize {
  cols: number;
  rows: number;
}

interface Session {
  cwd: string;
  child: IPty;
  buf: string;
  alive: boolean;
}

export class TaskShells {
  readonly #sessions = new Map<string, Session>();

  /** Start (or reuse) the shell for this task. Returns the cwd it is running in. */
  open(taskId: string, cwd: string, size?: PtySize): string {
    const existing = this.#sessions.get(taskId);
    if (existing?.alive) {
      if (size) existing.child.resize(size.cols, size.rows);
      return existing.cwd;
    }
    if (existing) this.close(taskId);

    const { command, args } = defaultShell();
    const cols = size?.cols ?? 80;
    const rows = size?.rows ?? 24;
    const child = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: shellEnv(),
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    });
    const session: Session = { cwd, child, buf: '', alive: true };
    child.onData((chunk) => {
      session.buf += chunk;
      if (session.buf.length > 200_000) session.buf = session.buf.slice(-100_000);
    });
    child.onExit(() => {
      session.alive = false;
      if (this.#sessions.get(taskId)?.child === child) this.#sessions.delete(taskId);
    });
    this.#sessions.set(taskId, session);
    return cwd;
  }

  resize(taskId: string, size: PtySize): void {
    const session = this.#sessions.get(taskId);
    if (!session?.alive) return;
    session.child.resize(size.cols, size.rows);
  }

  write(taskId: string, data: string): void {
    const session = this.#sessions.get(taskId);
    if (!session?.alive) {
      throw new Error('no shell is open for this lane');
    }
    session.child.write(data);
  }

  read(taskId: string): string {
    const session = this.#sessions.get(taskId);
    if (!session) return '';
    const out = session.buf;
    session.buf = '';
    return out;
  }

  close(taskId: string): void {
    const session = this.#sessions.get(taskId);
    if (!session) return;
    this.#sessions.delete(taskId);
    session.alive = false;
    try {
      session.child.write('exit\r');
    } catch {
      // already gone
    }
    try {
      process.kill(session.child.pid);
    } catch {
      // already gone
    }
  }

  closeAll(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
  }
}
