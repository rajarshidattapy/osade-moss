import type { ConventionWithEvidence, Evidence } from './conventions.js';
import { MAX_INJECTED_RULES, MAX_INJECTED_TOKENS } from './conventions.js';
import { estimateTokens } from './model.js';

/**
 * `<worktree>/.osade/CONTEXT.md` — OSADE.md §13.5.
 *
 * **Keep it short.** The cap is the feature. A 200-rule context file is worse than none: every
 * rule competes with the actual task for the agent's attention, so the budget is enforced here
 * rather than left to whoever calls this, and rules that do not fit are *reported* to the caller
 * so the UI can show the overflow instead of the prompt swallowing it.
 *
 * Evidence is rendered next to each rule. That is not decoration — an agent that can see a rule
 * came from two rejected PRs treats it differently from one that reads as boilerplate, and a
 * human reading the file can check the rule rather than take it on faith (§13.1).
 */

export interface ContextFileInput {
  repoSlug: string;
  intent: string;
  baseRef: string;
  baseSha: string;
  /** Already ranked and capped by `Conventions.forInjection`. */
  conventions: readonly ConventionWithEvidence[];
  /** Pasted `<repo>/.osade/rules.md`. When set, this is the rules section. */
  rulesText?: string;
  /** Rendered verbatim under "Verification you must pass". */
  verifySteps: readonly { name: string; cmd: string }[];
  /** Rules that were active but did not fit the cap, so the UI can surface them. */
  overflow?: number;
  /** OSADE-MOSS §M.5.6 — present only on a migration lane. */
  migration?: MigrationBrief;
}

/**
 * The two sections §M.5.6 adds to a migration lane's context file.
 *
 * `sites` is deliberately labelled as *candidates* in the rendered text. Discovery maximises
 * recall and is explicitly not an answer (§M.5.5), so a context file that presented the list as
 * "the call sites" would undo the one guarantee the two-stage design provides — the agent has
 * to confirm or reject each one, and verification is the arbiter.
 */
export interface MigrationBrief {
  packageName: string;
  toVersion: string;
  changes: readonly { kind: string; description: string; evidence: string; oldSymbol: string | null; newSymbol: string | null }[];
  sites: readonly { file: string; line: number; via: string; score: number | null }[];
}

export interface RenderedContext {
  body: string;
  /** How many rules actually made it into the file. */
  included: number;
  /** Active rules left out, by rank cap or token budget. */
  omitted: number;
  estimatedTokens: number;
}

export function renderContextFile(input: ContextFileInput): RenderedContext {
  const header = [
    `# Contributing to ${input.repoSlug}`,
    '',
    '## What you are working on',
    `- ${input.intent}`,
    `- base: ${input.baseSha} on ${input.baseRef}`,
    '',
  ];

  const footer = [
    '',
    '## Boundaries',
    '- Work only inside this worktree.',
    '- Do not push, open a pull request, or comment on GitHub. Those actions are gated and',
    '  performed by Osade after human approval.',
    '',
  ];

  const migration = input.migration ? renderMigration(input.migration) : [];

  const verify =
    input.verifySteps.length === 0
      ? []
      : [
          '## Verification you must pass before this is reviewable',
          ...input.verifySteps.map((s) => `- ${s.name}: \`${s.cmd}\``),
          '',
        ];

  // Everything except the rules is non-negotiable, so the rules get whatever budget is left.
  // The migration brief counts as fixed: §M.5.6's changes and candidate sites are the task, not
  // advice about it, and squeezing them out to fit more conventions would invert the priority.
  const fixed = [...header, ...migration, ...verify, ...footer].join('\n');
  const budget = MAX_INJECTED_TOKENS - estimateTokens(fixed);

  const pasted = input.rulesText?.trim() ?? '';
  if (pasted.length > 0) {
    const rules = ['## Rules this project enforces', '', pasted, ''];
    const body = [...header, ...migration, ...rules, ...verify, ...footer].join('\n');
    return {
      body,
      included: 1,
      omitted: 0,
      estimatedTokens: estimateTokens(body),
    };
  }

  const capped = input.conventions.slice(0, MAX_INJECTED_RULES);
  const rendered: string[] = [];
  let used = 0;
  let included = 0;

  for (const convention of capped) {
    const block = renderRule(convention);
    const cost = estimateTokens(block);
    // Ranked by confidence × recency upstream, so stopping at the budget drops the weakest
    // rules rather than an arbitrary tail.
    if (used + cost > budget) break;
    rendered.push(block);
    used += cost;
    included += 1;
  }

  const rules =
    included === 0
      ? []
      : ['## Rules this project enforces', '', ...rendered, ''];

  const body = [...header, ...migration, ...rules, ...verify, ...footer].join('\n');

  return {
    body,
    included,
    omitted: input.conventions.length - included + (input.overflow ?? 0),
    estimatedTokens: estimateTokens(body),
  };
}

function renderRule(convention: ConventionWithEvidence): string {
  const cites = convention.evidence.slice(0, 4).map(citation).filter(Boolean);
  const line = `- ${convention.ruleText}`;
  if (cites.length === 0) return line;
  return `${line}\n  <sub>evidence: ${cites.join(', ')}</sub>`;
}

/** "PR #1234 (rejected)" — the shape §13.5 specifies. */
function citation(e: Evidence): string {
  const pr = /\/pull\/(\d+)/.exec(e.url)?.[1];
  switch (e.kind) {
    case 'rejected_pr':
      return pr ? `PR #${pr} (rejected)` : 'a rejected pull request';
    case 'merged_pr':
      return pr ? `PR #${pr} (merged)` : 'a merged pull request';
    case 'review_comment':
      return pr ? `PR #${pr} (changes requested)` : 'a review comment';
    case 'ci_config':
      return `CI config (${fileName(e.url)})`;
    case 'doc':
      return fileName(e.url);
  }
}

function fileName(url: string): string {
  const last = url.split('?')[0]?.split('#')[0]?.split('/').pop();
  return last && last.length > 0 ? last : url;
}

/** §M.5.6 — the changes with their evidence, and the candidate sites with their caveat. */
function renderMigration(brief: MigrationBrief): string[] {
  const lines = [`## Migrating ${brief.packageName} to ${brief.toVersion}`, ''];

  lines.push('### Changes to apply');
  for (const change of brief.changes) {
    const rename =
      change.oldSymbol != null
        ? ` (\`${change.oldSymbol}\` → \`${change.newSymbol ?? 'removed'}\`)`
        : '';
    lines.push(`- **${change.kind}**: ${change.description}${rename}`);
    // The changelog line it came from, so the agent can check the instruction rather than
    // take it on faith — the same reason conventions travel with their evidence (§13.1).
    lines.push(`  <sub>changelog: ${collapse(change.evidence)}</sub>`);
  }

  if (brief.sites.length > 0) {
    lines.push('', '### Candidate call sites');
    lines.push(
      'These were found by search and **may be wrong or incomplete**. Confirm or reject each',
      'one against the code. Do not assume the list is exhaustive.',
      '',
    );
    for (const site of brief.sites) {
      const score = site.score == null ? '' : ` score ${site.score.toFixed(2)}`;
      lines.push(`- \`${site.file}:${site.line}\` (via ${site.via}${score})`);
    }
  }

  lines.push('');
  return lines;
}

function collapse(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 159)}…` : one;
}
