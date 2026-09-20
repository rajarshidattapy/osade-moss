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

  const verify =
    input.verifySteps.length === 0
      ? []
      : [
          '## Verification you must pass before this is reviewable',
          ...input.verifySteps.map((s) => `- ${s.name}: \`${s.cmd}\``),
          '',
        ];

  // Everything except the rules is non-negotiable, so the rules get whatever budget is left.
  const fixed = [...header, ...verify, ...footer].join('\n');
  const budget = MAX_INJECTED_TOKENS - estimateTokens(fixed);

  const pasted = input.rulesText?.trim() ?? '';
  if (pasted.length > 0) {
    const rules = ['## Rules this project enforces', '', pasted, ''];
    const body = [...header, ...rules, ...verify, ...footer].join('\n');
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

  const body = [...header, ...rules, ...verify, ...footer].join('\n');

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
