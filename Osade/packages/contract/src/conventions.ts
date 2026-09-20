import { z } from 'zod';

import { Timestamp } from './primitives.js';

/**
 * Repository conventions, as they cross the boundary — OSADE.md §13.
 *
 * The evidence travels with the rule. §13.4 says the UI shows the evidence next to the toggle,
 * and §13.1 makes an unciteable rule invalid, so a shape that lets a rule reach the renderer
 * without its citations would be a shape that invites the one thing this feature must not do:
 * present a model's opinion as a project's rule.
 */

export const ConventionCategory = z.enum([
  'review_process',
  'scope_limits',
  'commit_style',
  'test_requirements',
  'file_ownership',
  'communication',
  'ci_gates',
]);
export type ConventionCategory = z.infer<typeof ConventionCategory>;

/**
 * §5.3 calls this field `status`. It is `lifecycle` everywhere in Osade so §20.1's "no column
 * named status, anywhere" stays a blanket rule — a rule with one carve-out is a rule someone
 * widens later. PRD-DELTA #16.
 */
export const ConventionLifecycle = z.enum(['candidate', 'active', 'retired', 'rejected']);
export type ConventionLifecycle = z.infer<typeof ConventionLifecycle>;

export const EvidenceKind = z.enum([
  'merged_pr',
  'rejected_pr',
  'review_comment',
  'doc',
  'ci_config',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const ConventionEvidence = z.object({
  kind: EvidenceKind,
  url: z.string(),
  excerpt: z.string().nullable(),
  observedAt: Timestamp,
});
export type ConventionEvidence = z.infer<typeof ConventionEvidence>;

export const ConventionView = z.object({
  id: z.string(),
  repoId: z.string(),
  category: ConventionCategory,
  ruleText: z.string(),
  rationale: z.string().nullable(),
  confidence: z.number(),
  lifecycle: ConventionLifecycle,
  minedAt: Timestamp,
  lastConfirmedAt: Timestamp.nullable(),
  retiredReason: z.string().nullable(),
  /** §13.1 — never empty for a stored rule. */
  evidence: z.array(ConventionEvidence).min(1),
});
export type ConventionView = z.infer<typeof ConventionView>;

/**
 * Which pass a run is in. `interrupted` is what an unfinished run looks like once the daemon
 * running it went away — distinguishable from a run still working, which is the point.
 */
export const MinePhase = z.enum([
  'fetching',
  'extracting',
  'clustering',
  'verifying',
  'interrupted',
]);
export type MinePhase = z.infer<typeof MinePhase>;

export const MineRunView = z.object({
  id: z.string(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  highWaterPr: z.number().int().nullable(),
  observations: z.number().int(),
  candidates: z.number().int(),
  error: z.string().nullable(),
  phase: MinePhase.nullable(),
  progressDone: z.number().int(),
  progressTotal: z.number().int(),
});
export type MineRunView = z.infer<typeof MineRunView>;

export const MineStatus = z.object({
  available: z.boolean(),
  /** Why mining is unavailable, in words the user can act on. */
  reason: z.string().nullable(),
  running: z.boolean(),
  lastRun: MineRunView.nullable(),
  activeRules: z.number().int(),
  candidateRules: z.number().int(),
  /** §13.4's weekly re-mine, offered rather than performed — mining spends real money. */
  dueForRemine: z.boolean(),
});
export type MineStatus = z.infer<typeof MineStatus>;

export const MineResultView = z.object({
  runId: z.string(),
  observations: z.number().int(),
  candidates: z.number().int(),
  written: z.number().int(),
  rejected: z.number().int(),
  reconfirmed: z.number().int(),
  belowThreshold: z.number().int(),
  error: z.string().nullable(),
});
export type MineResultView = z.infer<typeof MineResultView>;

/** §13.6 — one arm of the comparison. */
export const ImpactArm = z.object({
  n: z.number().int(),
  meanReviewRounds: z.number().nullable(),
  medianReviewRounds: z.number().nullable(),
  firstRoundAcceptance: z.number().nullable(),
});
export type ImpactArm = z.infer<typeof ImpactArm>;

/**
 * §13.6 — the one number this feature exists to move, measured rather than asserted.
 * `verdict` is plain words, and is allowed to say the feature did not work.
 */
export const ConventionImpact = z.object({
  repoId: z.string(),
  withConventions: ImpactArm,
  withoutConventions: ImpactArm,
  /** Negative means conventions reduced review rounds. */
  difference: z.number().nullable(),
  unreadable: z.number().int(),
  verdict: z.string(),
});
export type ConventionImpact = z.infer<typeof ConventionImpact>;
