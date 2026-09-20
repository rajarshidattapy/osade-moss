import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The agent catalog — OSADE.md §8.1.
 *
 * INVARIANT: capabilities, not identity checks. Branch on
 * `entry.capabilities.includes('plan-mode')`, never on `id === 'claude'`.
 *
 * `binary` is **advisory**. the substrate resolves the executable itself from `kind`
 * (`backend/src/detect/mod.rs:149-181`), so this field exists only to probe whether the agent
 * is installed and to produce a useful error. It is never sent to the substrate.
 */

export type AgentCapability =
  | 'plan-mode'
  | 'resume'
  | 'system-prompt-injection'
  | 'hook-reporting'
  | 'structured-review-output'
  | 'headless-run'
  | 'reports-final-message';

export interface AgentCatalogEntry {
  /** The `kind` substrate accepts on `agent.start`, verbatim from the pinned set. */
  readonly id: string;
  /** Advisory: what to probe on PATH. substrate picks the real executable. */
  readonly binary: string;
  readonly autonomousArgs: readonly string[];
  readonly planArgs: readonly string[];
  readonly resumeArgs: readonly string[];
  /** How conventions get injected (§13.5). Null when the agent has no flag for it. */
  readonly systemPromptFlag: string | null;
  readonly capabilities: readonly AgentCapability[];
  /** Non-interactive print mode. Prompt is written to stdin. */
  readonly headlessArgs: readonly string[];
  /** How long a new lane may sit without an idle composer before the send fails. */
  readonly readyTimeoutMs?: number;
  /** Regex sources stripped from a pane-delta reply (banner, prompt chrome, status footer). */
  readonly transcriptTrim?: readonly string[];
}

/**
 * `hook-reporting` is set only where the substrate's bundled asset actually calls `pane.report_agent`
 * (§7.1). For claude and codex the hook posts a session id and nothing else, so their status
 * comes entirely from the substrate's screen-detection manifests — which carries the full lifecycle
 * correctly, verified live. What they lose is `tool_name` and `final_message`, not status.
 */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: 'claude',
    binary: 'claude',
    autonomousArgs: ['--permission-mode', 'acceptEdits'],
    planArgs: ['--permission-mode', 'plan'],
    resumeArgs: ['--continue'],
    systemPromptFlag: '--append-system-prompt',
    capabilities: ['plan-mode', 'resume', 'system-prompt-injection', 'headless-run'],
    headlessArgs: ['-p', '--output-format', 'text'],
    transcriptTrim: ['^❯', '^claude(?:\\s+code)?$', 'esc to interrupt', '^╰', '^╭'],
  },
  {
    id: 'codex',
    binary: 'codex',
    autonomousArgs: [],
    planArgs: [],
    resumeArgs: ['resume', '--last'],
    systemPromptFlag: null,
    capabilities: ['resume', 'headless-run'],
    headlessArgs: ['exec', '--skip-git-repo-check', '--ephemeral'],
    transcriptTrim: ['^›', '^codex$', 'press enter to continue', '^token usage'],
  },
  {
    id: 'opencode',
    binary: 'opencode',
    autonomousArgs: [],
    planArgs: [],
    resumeArgs: [],
    systemPromptFlag: null,
    capabilities: ['hook-reporting'],
    headlessArgs: [],
  },
  {
    id: 'pi',
    binary: 'pi',
    autonomousArgs: [],
    planArgs: [],
    resumeArgs: [],
    systemPromptFlag: null,
    capabilities: ['hook-reporting'],
    headlessArgs: [],
  },
];

export function agentEntry(id: string): AgentCatalogEntry | null {
  return AGENT_CATALOG.find((e) => e.id === id) ?? null;
}

export function hasCapability(entry: AgentCatalogEntry, capability: AgentCapability): boolean {
  return entry.capabilities.includes(capability);
}

export const DEFAULT_READY_TIMEOUT_MS = 45_000;

export function readyTimeoutMs(id: string): number {
  return agentEntry(id)?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
}

export const DAEMON_DEFAULT_AGENT = 'claude';

const DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function agentDisplayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id;
}

export class UnknownAgentError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`unknown agent ${agentId}`);
    this.name = 'UnknownAgentError';
    this.agentId = agentId;
  }
}

export function requireAgent(id: string): AgentCatalogEntry {
  const entry = agentEntry(id);
  if (!entry) throw new UnknownAgentError(id);
  return entry;
}

/**
 * Direct PATH lookup — OSADE.md §8.1. Never `which`/`where` and never a login shell.
 *
 * On Windows, PATHEXT wins over an extensionless shim. npm puts both `claude` (a bash script)
 * and `claude.cmd` on PATH; Node's spawn without a shell cannot run the script, which is how
 * a live mine reported "available" and then died with `spawn claude ENOENT`.
 */
export function resolveBinaryOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (binary.includes('/') || binary.includes('\\')) {
    return existsSync(binary) ? binary : null;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const suffix = ext.startsWith('.') ? ext : `.${ext}`;
      const withExt = join(dir, binary + suffix);
      if (existsSync(withExt)) return withExt;
      const lower = join(dir, binary + suffix.toLowerCase());
      if (existsSync(lower)) return lower;
    }
    const bare = join(dir, binary);
    if (existsSync(bare)) return bare;
  }
  return null;
}

export function binaryOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveBinaryOnPath(binary, env) != null;
}
