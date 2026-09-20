import { describe, expect, it } from 'vitest';

import type { ConventionWithEvidence } from '../../src/knowledge/conventions.js';
import { MAX_INJECTED_RULES, MAX_INJECTED_TOKENS } from '../../src/knowledge/conventions.js';
import { renderContextFile } from '../../src/knowledge/context-file.js';
import { estimateTokens } from '../../src/knowledge/model.js';

const NOW = 1_756_000_000_000;

function rule(overrides: Partial<ConventionWithEvidence> = {}): ConventionWithEvidence {
  return {
    id: 'cv_1',
    repoId: 'r1',
    category: 'scope_limits',
    ruleText: 'Keep each pull request to one concern.',
    rationale: null,
    confidence: 0.9,
    lifecycle: 'active',
    minedAt: NOW,
    lastConfirmedAt: NOW,
    retiredReason: null,
    evidence: [
      {
        kind: 'rejected_pr',
        url: 'https://github.com/acme/widget/pull/1234',
        excerpt: 'too many things at once',
        observedAt: NOW,
      },
      {
        kind: 'review_comment',
        url: 'https://github.com/acme/widget/pull/1290#discussion_r7',
        excerpt: 'split this',
        observedAt: NOW,
      },
    ],
    ...overrides,
  };
}

function render(conventions: ConventionWithEvidence[], overflow = 0) {
  return renderContextFile({
    repoSlug: 'acme/widget',
    intent: 'Fix the flaky retry test.',
    baseRef: 'main',
    baseSha: 'abc1234',
    conventions,
    verifySteps: [
      { name: 'typecheck', cmd: 'pnpm typecheck' },
      { name: 'test', cmd: 'pnpm test' },
    ],
    overflow,
  });
}

describe('§13.5 CONTEXT.md', () => {
  it('renders the rule with its evidence, in the shape the spec gives', () => {
    const { body } = render([rule()]);

    expect(body).toContain('# Contributing to acme/widget');
    expect(body).toContain('## Rules this project enforces');
    expect(body).toContain('- Keep each pull request to one concern.');
    expect(body).toContain('<sub>evidence: PR #1234 (rejected), PR #1290 (changes requested)</sub>');
  });

  it('always states the task and the base, even with no conventions', () => {
    const { body, included } = render([]);

    expect(included).toBe(0);
    expect(body).not.toContain('## Rules this project enforces');
    expect(body).toContain('- Fix the flaky retry test.');
    expect(body).toContain('- base: abc1234 on main');
  });

  it('pastes .osade/rules.md verbatim when present', () => {
    const { body, included } = renderContextFile({
      repoSlug: 'acme/widget',
      intent: 'Fix the flaky retry test.',
      baseRef: 'main',
      baseSha: 'abc1234',
      conventions: [rule()],
      rulesText: '- Keep PRs to one concern.\n- Tests go with the change.',
      verifySteps: [],
    });
    expect(included).toBe(1);
    expect(body).toContain('## Rules this project enforces');
    expect(body).toContain('- Keep PRs to one concern.');
    expect(body).toContain('- Tests go with the change.');
    expect(body).not.toContain('Keep each pull request to one concern.');
  });

  it('names the verification the agent will be held to', () => {
    const { body } = render([rule()]);
    expect(body).toContain('## Verification you must pass before this is reviewable');
    expect(body).toContain('- test: `pnpm test`');
  });

  it('keeps the gate boundaries whatever else is dropped', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      rule({ id: `cv_${i}`, ruleText: `Rule ${i}: ${'x'.repeat(300)}` }),
    );
    const { body } = render(many);
    expect(body).toContain('Do not push, open a pull request, or comment on GitHub.');
  });
});

describe('§13.5 — the cap is the feature', () => {
  it('stays within the token budget when far more rules are active', () => {
    const many = Array.from({ length: MAX_INJECTED_RULES }, (_, i) =>
      rule({ id: `cv_${i}`, ruleText: `Rule number ${i}: ${'word '.repeat(60)}` }),
    );

    const { body, included, estimatedTokens } = render(many);
    expect(estimatedTokens).toBeLessThanOrEqual(MAX_INJECTED_TOKENS);
    expect(included).toBeLessThan(MAX_INJECTED_RULES);
    expect(estimateTokens(body)).toBe(estimatedTokens);
  });

  it('reports what it left out rather than dropping it silently', () => {
    const many = Array.from({ length: MAX_INJECTED_RULES }, (_, i) =>
      rule({ id: `cv_${i}`, ruleText: `Rule number ${i}: ${'word '.repeat(60)}` }),
    );

    const { included, omitted } = render(many, 12);
    // Everything that did not fit, plus what the rank cap already excluded upstream.
    expect(omitted).toBe(MAX_INJECTED_RULES - included + 12);
  });

  it('drops from the weak end — the caller ranks, this truncates', () => {
    // Sized so exactly one fits the budget: the order they arrive in is the order they matter.
    const strong = rule({ id: 'strong', ruleText: `Strongest rule. ${'a '.repeat(3400)}` });
    const weak = rule({ id: 'weak', ruleText: `Weakest rule. ${'b '.repeat(3400)}` });

    const { body } = render([strong, weak]);
    expect(body).toContain('Strongest rule.');
    expect(body).not.toContain('Weakest rule.');
  });
});

describe('citations', () => {
  it('cites CI config by file rather than as a pull request', () => {
    const { body } = render([
      rule({
        category: 'ci_gates',
        ruleText: 'The test job must pass.',
        evidence: [
          {
            kind: 'ci_config',
            url: 'https://github.com/acme/widget/blob/main/.github/workflows/ci.yml',
            excerpt: 'run: pnpm test',
            observedAt: NOW,
          },
        ],
      }),
    ]);

    expect(body).toContain('<sub>evidence: CI config (ci.yml)</sub>');
  });

  it('does not invent a PR number when the URL has none', () => {
    const { body } = render([
      rule({
        evidence: [
          {
            kind: 'rejected_pr',
            url: 'https://example.invalid/thing',
            excerpt: null,
            observedAt: NOW,
          },
        ],
      }),
    ]);

    expect(body).toContain('a rejected pull request');
    expect(body).not.toMatch(/PR #\d/);
  });

  it('shows at most four citations per rule', () => {
    const { body } = render([
      rule({
        evidence: Array.from({ length: 9 }, (_, i) => ({
          kind: 'rejected_pr' as const,
          url: `https://github.com/acme/widget/pull/${i}`,
          excerpt: null,
          observedAt: NOW,
        })),
      }),
    ]);

    const line = body.split('\n').find((l) => l.includes('evidence:')) ?? '';
    expect(line.split(', ')).toHaveLength(4);
  });
});
