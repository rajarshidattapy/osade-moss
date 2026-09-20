import { z } from 'zod';

import { CONVENTION_CATEGORIES } from './conventions.js';
import { callPass, clip, type ModelPort } from './model.js';
import type {
  CandidateRule,
  Corpus,
  Observation,
  PullRequestRecord,
  RepoDocRecord,
  SourceKind,
  Verdict,
} from './types.js';

/**
 * The three passes — OSADE.md §13.4.
 *
 * Each is a separate model call with a narrow job, and they live in one file so it stays
 * obvious that they are three and not one. The spec is explicit: *do not build one mega-prompt*.
 * The reason is not aesthetic. A single call that extracts, generalizes and validates has no
 * point at which the code can check the work, and every threshold in §13.4 — three observations,
 * two distinct PRs, a held-out sample — exists precisely to be checked between the passes.
 *
 * A rule the passes obey throughout: **the model may only cite URLs that were in its input.**
 * A fabricated permalink would satisfy §13.1's letter and destroy its purpose, so cited URLs are
 * matched against the input and unmatched ones are dropped here rather than trusted.
 */

/** Character budgets. Bounded input is what makes these passes cheap enough to run per PR. */
const MAX_PR_BODY_CHARS = 1_500;
const MAX_COMMENT_CHARS = 1_200;
const MAX_DOC_CHARS = 6_000;
const MAX_QUOTE_CHARS = 300;

const categoryEnum = z.enum(CONVENTION_CATEGORIES);

// ── pass 1: extract ─────────────────────────────────────────────────────────

const extractSchema = z.object({
  observations: z
    .array(
      z.object({
        url: z.string().min(1),
        quote: z.string().min(1),
        category: categoryEnum,
        note: z.string().min(1),
      }),
    )
    .max(20),
});

const EXTRACT_SYSTEM = `You read one pull request from an open-source repository and report what
actually happened in it. You do not generalize.

Report an observation only when a maintainer expressed a requirement, objection, or correction
about *how contributions are made* — process, scope, commits, tests, ownership, communication, or
CI. Ignore discussion of the change's subject matter: "this loop is O(n^2)" is about the code,
"split this into two PRs" is about the project.

Rules:
- Every observation must quote the text it came from, verbatim, and cite the exact URL that text
  appeared at. Use only URLs given to you. Never invent one.
- One observation per distinct point. A comment making two demands is two observations.
- The note is one present-tense sentence about this instance, not about the project. Write
  "the reviewer asked for the refactor to be split out", not "this project forbids refactors".
- If nothing in the pull request is about process, return an empty list. That is a normal result.

Categories:
  review_process    when to open a draft, when an issue or RFC is required first
  scope_limits      one concern per PR, no drive-by refactors
  commit_style      conventional commits, sign-off, message format
  test_requirements what must have a test, where tests live
  file_ownership    areas needing a specific reviewer, or effectively frozen
  communication     comment on the issue before implementing, how to ask
  ci_gates          what must be green

Reply with JSON only: {"observations":[{"url","quote","category","note"}]}`;

export async function extractFromPullRequest(
  model: ModelPort,
  pr: PullRequestRecord,
): Promise<Observation[]> {
  const urls = new Set<string>([pr.url, ...pr.comments.map((c) => c.url)]);

  const result = await callPass(
    model,
    {
      pass: 'extract',
      system: EXTRACT_SYSTEM,
      user: renderPullRequest(pr),
      maxOutputTokens: 1_500,
    },
    extractSchema,
  );

  return result.observations
    .filter((o) => urls.has(o.url))
    .map((o, i) => ({
      id: `pr${pr.number}-${i}`,
      sourceKind: sourceKindFor(pr, o.url),
      prNumber: pr.number,
      url: o.url,
      quote: clip(o.quote, MAX_QUOTE_CHARS),
      category: o.category,
      note: o.note,
      observedAt: pr.closedAt,
    }));
}

/**
 * §13.2 — the same sentence is worth more when it appears on a rejected PR.
 *
 * A rejection carries the whole weight of the outcome, so a comment on a closed-unmerged PR is
 * cited as `rejected_pr` regardless of its review state; on a merged PR, only an explicit
 * `changes_requested` gets the top weight.
 */
function sourceKindFor(pr: PullRequestRecord, url: string): SourceKind {
  if (pr.outcome === 'closed_unmerged') return 'rejected_pr';
  const comment = pr.comments.find((c) => c.url === url);
  return comment?.state === 'changes_requested' ? 'changes_requested' : 'merged_pr_comment';
}

function renderPullRequest(pr: PullRequestRecord): string {
  const lines = [
    `Pull request #${pr.number}: ${pr.title}`,
    `URL: ${pr.url}`,
    `Outcome: ${pr.outcome === 'merged' ? 'merged' : 'closed without merging'}`,
    '',
    'Description:',
    clip(pr.body ?? '(none)', MAX_PR_BODY_CHARS),
    '',
    'Review comments:',
  ];

  if (pr.comments.length === 0) lines.push('(none)');
  for (const c of pr.comments) {
    lines.push(
      '',
      `--- ${c.state} by ${c.author ?? 'unknown'}`,
      `URL: ${c.url}`,
      clip(c.body, MAX_COMMENT_CHARS),
    );
  }

  if (pr.pathsChangedAfterReview?.length) {
    lines.push(
      '',
      'Files the maintainers changed after review, before merging:',
      pr.pathsChangedAfterReview.slice(0, 40).join('\n'),
    );
  }

  return lines.join('\n');
}

const DOC_SYSTEM = `You read one project document — CONTRIBUTING, AGENTS.md, CODEOWNERS, a pull
request template, or a CI workflow — and list the rules it states about how contributions are
made.

Rules:
- Quote the line the rule comes from, verbatim.
- Cite the URL you were given, exactly, for every observation.
- State each rule as one imperative sentence in the note.
- A CI workflow states rules by what it runs and what it requires. A required job is a rule.
- Skip prose that is encouragement rather than requirement.

Categories: review_process, scope_limits, commit_style, test_requirements, file_ownership,
communication, ci_gates.

Reply with JSON only: {"observations":[{"url","quote","category","note"}]}`;

export async function extractFromDoc(
  model: ModelPort,
  doc: RepoDocRecord,
  observedAt: number,
): Promise<Observation[]> {
  const result = await callPass(
    model,
    {
      pass: 'extract',
      system: DOC_SYSTEM,
      user: [`Document: ${doc.path}`, `URL: ${doc.url}`, '', clip(doc.content, MAX_DOC_CHARS)].join(
        '\n',
      ),
      maxOutputTokens: 1_500,
    },
    extractSchema,
  );

  const kind: SourceKind = doc.kind === 'ci_config' ? 'ci_config' : 'stated_doc';

  return result.observations
    .filter((o) => o.url === doc.url)
    .map((o, i) => ({
      id: `doc-${slug(doc.path)}-${i}`,
      sourceKind: kind,
      prNumber: null,
      url: doc.url,
      quote: clip(o.quote, MAX_QUOTE_CHARS),
      category: o.category,
      note: o.note,
      observedAt,
    }));
}

function slug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── pass 2: cluster ─────────────────────────────────────────────────────────

const clusterSchema = z.object({
  rules: z
    .array(
      z.object({
        category: categoryEnum,
        rule_text: z.string().min(1),
        rationale: z.string().nullish(),
        observation_ids: z.array(z.string()).min(1),
      }),
    )
    .max(60),
});

const CLUSTER_SYSTEM = `You are given observations extracted from one repository's pull requests
and documents. Group them into candidate rules.

Rules:
- Group observations that state the same requirement, even in different words. Do not group
  observations that merely share a category.
- Each rule is one imperative sentence addressed to a contributor: "Open a draft pull request
  before writing code." Not "contributors should generally consider…".
- Cite every observation id you grouped. Use only ids you were given.
- An observation that supports no group is dropped. Do not invent a rule to house it.
- Prefer fewer, sharper rules. Two rules that would always be satisfied together are one rule.
- The rationale is one sentence on why the project appears to want this, or null.

Reply with JSON only: {"rules":[{"category","rule_text","rationale","observation_ids"}]}`;

export async function clusterObservations(
  model: ModelPort,
  observations: readonly Observation[],
): Promise<CandidateRule[]> {
  if (observations.length === 0) return [];

  const known = new Map(observations.map((o) => [o.id, o]));
  const result = await callPass(
    model,
    {
      pass: 'cluster',
      system: CLUSTER_SYSTEM,
      user: observations
        .map((o) => `${o.id} [${o.category}] ${o.note}\n  "${o.quote}"`)
        .join('\n\n'),
      maxOutputTokens: 4_000,
    },
    clusterSchema,
  );

  return result.rules
    .map((r) => ({
      category: r.category,
      ruleText: r.rule_text,
      rationale: r.rationale ?? null,
      observationIds: [...new Set(r.observation_ids)].filter((id) => known.has(id)),
    }))
    .filter((r) => r.observationIds.length > 0);
}

// ── pass 3: verify ──────────────────────────────────────────────────────────

const verifySchema = z.object({
  supported: z.number().int().min(0),
  violated: z.number().int().min(0),
  unknown: z.number().int().min(0),
  notes: z.string().nullish(),
});

const VERIFY_SYSTEM = `You are testing whether a proposed rule actually describes how a project
behaves. You are given the rule and a sample of pull requests that were merged — that is, work
the project accepted.

For each pull request decide one of:
  supported  it visibly follows the rule, or was corrected until it did
  violated   it plainly ignores the rule and was merged anyway
  unknown    the pull request gives you no way to tell

Be strict about "violated": it means the project merged work that breaks the rule, which is
evidence the rule is not real. Be strict about "supported" too — absence of a violation is
"unknown", not support.

Reply with JSON only: {"supported":N,"violated":N,"unknown":N,"notes":"one sentence or null"}`;

export async function verifyCandidate(
  model: ModelPort,
  candidate: CandidateRule,
  heldOut: readonly PullRequestRecord[],
): Promise<Verdict> {
  if (heldOut.length === 0) {
    return { supported: 0, violated: 0, unknown: 0, notes: 'no held-out sample' };
  }

  const sample = heldOut
    .map((pr) =>
      [
        `#${pr.number}: ${pr.title}`,
        clip(pr.body ?? '(no description)', 400),
        pr.comments
          .slice(0, 4)
          .map((c) => `  ${c.state}: ${clip(c.body, 300)}`)
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n---\n\n');

  const result = await callPass(
    model,
    {
      pass: 'verify',
      system: VERIFY_SYSTEM,
      user: [
        `Rule: ${candidate.ruleText}`,
        `Category: ${candidate.category}`,
        '',
        `Merged pull requests (${heldOut.length}):`,
        '',
        sample,
      ].join('\n'),
      maxOutputTokens: 500,
    },
    verifySchema,
  );

  return {
    supported: result.supported,
    violated: result.violated,
    unknown: result.unknown,
    notes: result.notes ?? null,
  };
}

/** Exported for the miner's held-out split; keeps the corpus shape in one place. */
export function mergedPullRequests(corpus: Corpus): PullRequestRecord[] {
  return corpus.pullRequests.filter((pr) => pr.outcome === 'merged');
}
