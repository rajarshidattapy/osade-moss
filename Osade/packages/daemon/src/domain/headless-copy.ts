import { readFileSync } from 'node:fs';

import { extractJson } from '../knowledge/model.js';
import type { HeadlessRuns } from './headless-run.js';
import type { VerifyStep } from './verify-plan.js';

export async function agentTitle(
  runs: HeadlessRuns,
  repoId: string,
  prompt: string,
): Promise<string | null> {
  try {
    const { text } = await runs.run({
      repoId,
      prompt: `Reply with only a short chat title (max 8 words, no quotes) for this work:\n${prompt.slice(0, 2000)}`,
      timeoutSec: 30,
    });
    const title = text.trim().split('\n')[0]?.replace(/^["']|["']$/g, '').trim() ?? '';
    if (title.length < 4 || title.length > 80) return null;
    return title;
  } catch {
    return null;
  }
}

export async function agentSlug(
  runs: HeadlessRuns,
  repoId: string,
  title: string,
  fallback: string,
): Promise<string> {
  try {
    const { text } = await runs.run({
      repoId,
      prompt: `Reply with only a git branch slug: lowercase, hyphens, max 40 characters, no prefix, for: ${title}`,
      timeoutSec: 20,
    });
    const slug = (text.trim().split(/\s+/)[0] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return slug.length > 0 ? slug : fallback;
  } catch {
    return fallback;
  }
}

export async function agentPrCopy(
  runs: HeadlessRuns,
  repoId: string,
  title: string,
): Promise<{ title: string; body: string }> {
  try {
    const { text } = await runs.run({
      repoId,
      prompt: `Write a GitHub pull request as JSON {"title":"...","body":"..."} for this work. Title only, body markdown. Work: ${title}`,
      timeoutSec: 45,
    });
    const json = extractJson(text);
    if (!json) return { title, body: '' };
    const parsed = JSON.parse(json) as { title?: unknown; body?: unknown };
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : title,
      body: typeof parsed.body === 'string' ? parsed.body : '',
    };
  } catch {
    return { title, body: '' };
  }
}

export function stepsFromAgentText(raw: string): VerifyStep[] {
  const json = extractJson(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { steps?: unknown }).steps)
    ? (parsed as { steps: unknown[] }).steps
    : [];
  const steps: VerifyStep[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as { name?: unknown; cmd?: unknown; cwd?: unknown; timeoutSec?: unknown };
    if (typeof rec.cmd !== 'string' || rec.cmd.trim().length === 0) continue;
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : rec.cmd.trim();
    steps.push({
      name,
      cmd: rec.cmd.trim(),
      cwd: typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd.trim() : '.',
      timeoutSec: typeof rec.timeoutSec === 'number' && rec.timeoutSec > 0 ? rec.timeoutSec : 600,
      required: true,
      source: 'agent',
      evidence: 'guessed by the repo agent; no CI or manifest match',
    });
  }
  return steps;
}

export function tailFile(path: string, lines = 40): string {
  try {
    const text = readFileSync(path, 'utf8');
    const parts = text.split(/\r?\n/);
    return parts.slice(-lines).join('\n');
  } catch {
    return '';
  }
}
