import type { ConventionCategory, EvidenceKind } from './conventions.js';

/**
 * The mining corpus — OSADE.md §13.2.
 *
 * These records are deliberately SCM-neutral. GitHub routes live in `scm/corpus.ts`; everything
 * under `knowledge/` works on this shape, so the miner is testable against fixtures rather than
 * against a recorded API, and the pipeline never learns what a "pull request node id" is.
 */

export type PrOutcome = 'merged' | 'closed_unmerged';

export interface ReviewComment {
  /** Permalink. Without it the observation cannot become evidence (§13.1). */
  url: string;
  author: string | null;
  body: string;
  /** `changes_requested` is the strongest thread signal there is (§13.2). */
  state: 'changes_requested' | 'commented' | 'approved' | 'dismissed';
  at: number;
}

export interface PullRequestRecord {
  number: number;
  url: string;
  title: string;
  body: string | null;
  outcome: PrOutcome;
  author: string | null;
  closedAt: number;
  comments: ReviewComment[];
  /**
   * §13.2 row 3 — what maintainers silently fixed between the submitted head and the merge.
   * Paths only: the miner reasons about *which* files changed after review, not their contents,
   * because a diff body would blow the extract pass's budget for no extra signal.
   */
  pathsChangedAfterReview?: string[];
}

/** `CONTRIBUTING.md`, `AGENTS.md`, `CODEOWNERS`, PR templates, and CI workflow files. */
export interface RepoDocRecord {
  kind: 'doc' | 'ci_config' | 'codeowners';
  path: string;
  url: string;
  content: string;
}

export interface Corpus {
  repoId: string;
  /** Human-readable, for prompts only: "acme/widget". */
  repoSlug: string;
  pullRequests: PullRequestRecord[];
  docs: RepoDocRecord[];
}

/**
 * §13.2 — the weights, as code.
 *
 * The table is a claim about which sources deserve belief, and it is the whole reason this
 * feature is not just "ask a model about the repo". Rejection and explicit `changes_requested`
 * outrank everything a project says about itself, because a stale CONTRIBUTING.md is common and
 * a rejected PR is never a rumour.
 */
export const SOURCE_WEIGHT = {
  /** Mechanically enforced, so it is definitionally true. */
  ci_config: 1.0,
  /** Rejection is the strongest human signal and everyone ignores it. */
  rejected_pr: 1.0,
  /** Explicit statements of what was wrong. */
  changes_requested: 1.0,
  /** What maintainers silently fixed. */
  post_review_fix: 0.75,
  /** Style nudges, conventions in passing. */
  merged_pr_comment: 0.5,
  /** Stated rules — often stale, so provenance is marked. */
  stated_doc: 0.5,
} as const;

export type SourceKind = keyof typeof SOURCE_WEIGHT;

/** How a source kind is cited once it becomes evidence. */
export const EVIDENCE_KIND_FOR: Record<SourceKind, EvidenceKind> = {
  ci_config: 'ci_config',
  rejected_pr: 'rejected_pr',
  changes_requested: 'review_comment',
  post_review_fix: 'merged_pr',
  merged_pr_comment: 'review_comment',
  stated_doc: 'doc',
};

/**
 * Pass 1's output — one thing that actually happened, with the quote that proves it.
 *
 * No generalization at this stage (§13.4). An observation says "this reviewer asked for this";
 * it does not say "this project requires that". Turning many observations into one rule is
 * pass 2's job, and keeping the two apart is what stops a single loud comment from becoming a
 * repository-wide law.
 */
export interface Observation {
  id: string;
  sourceKind: SourceKind;
  /** The PR this came from, so pass 2 can count *distinct* PRs. Null for docs and CI. */
  prNumber: number | null;
  url: string;
  quote: string;
  category: ConventionCategory;
  /** One sentence, present tense, about this one instance. */
  note: string;
  observedAt: number;
}

/** Pass 2's output — a rule proposal, still unverified and still unwritten. */
export interface CandidateRule {
  category: ConventionCategory;
  /** Imperative, one sentence. */
  ruleText: string;
  rationale: string | null;
  /** Ids into the observation set. The threshold check in `miner.ts` reads these. */
  observationIds: string[];
}

/** Pass 3's output — did the held-out sample behave as the rule predicts? */
export interface Verdict {
  /** Merged PRs conform to the rule. */
  supported: number;
  /** Merged PRs violate it — a rule the project does not actually enforce. */
  violated: number;
  /** The sample says nothing either way. */
  unknown: number;
  notes: string | null;
}
