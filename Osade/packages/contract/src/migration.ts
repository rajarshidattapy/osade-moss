import { z } from 'zod';

import { RepoId, TaskId, Timestamp } from './primitives.js';

/**
 * F1 — self-maintaining APIs, as it crosses the boundary (OSADE-MOSS §M.5).
 *
 * The shape here encodes the feature's central claim: **discovery is a proposal, not an
 * answer.** A `CallSite` carries who found it, how confident retrieval was, and whether anyone
 * has confirmed it — never a bare list of "the sites". Recall and precision are split across
 * stages on purpose (§M.5.5), and a type that flattened them would let the UI present a guess
 * as a finding.
 */

export const MigrationChangeKind = z.enum(['rename', 'signature', 'removal', 'behavior']);
export type MigrationChangeKind = z.infer<typeof MigrationChangeKind>;

/**
 * Where a change came from.
 *
 * `changelog` and `sdk_diff` are model-extracted and must cite their input verbatim (§M.5.3);
 * `user` is hand-entered and needs no citation because a human is the evidence.
 */
export const MigrationChangeSource = z.enum(['changelog', 'sdk_diff', 'user']);
export type MigrationChangeSource = z.infer<typeof MigrationChangeSource>;

export const MigrationChange = z.object({
  id: z.string(),
  migration_id: z.string(),
  kind: MigrationChangeKind,
  old_symbol: z.string().nullable(),
  new_symbol: z.string().nullable(),
  description: z.string(),
  source: MigrationChangeSource,
  /** The changelog line or diff hunk this was taken from, verbatim. */
  evidence: z.string(),
});
export type MigrationChange = z.infer<typeof MigrationChange>;

/** §M.5.7 — fixed at assignment and never recomputed, or the experiment means nothing. */
export const MigrationArm = z.enum(['digest_on', 'digest_off']);
export type MigrationArm = z.infer<typeof MigrationArm>;

/** How a call site was reached from the migrated package. The Moss-only win lives here. */
export const CallSiteVia = z.enum(['direct', 'alias', 'wrapper']);
export type CallSiteVia = z.infer<typeof CallSiteVia>;

export const FoundBy = z.enum(['moss', 'grep', 'both']);
export type FoundBy = z.infer<typeof FoundBy>;

export const CallSite = z.object({
  id: z.string(),
  migration_id: z.string(),
  change_id: z.string(),
  repo_id: RepoId,
  chunk_id: z.string().nullable(),
  file: z.string(),
  line: z.number().int(),
  via: CallSiteVia,
  score: z.number().nullable(),
  found_by: FoundBy,
  /**
   * Three states, not two. Null is "nobody has looked yet" — a candidate discovery proposed
   * and neither the agent nor verification has ruled on (§M.5.5).
   */
  confirmed: z.boolean().nullable(),
  confirmed_by: z.enum(['agent', 'verify']).nullable(),
});
export type CallSite = z.infer<typeof CallSite>;

export const CodeChunkKind = z.enum(['function', 'import', 'call', 'derived_wrapper']);
export type CodeChunkKind = z.infer<typeof CodeChunkKind>;

/** §M.5.5 — the comparison the demo turns on, per repo. */
export const DiscoveryComparison = z.object({
  repo_id: RepoId,
  repo_slug: z.string(),
  /** Found by both — the uncontroversial middle. */
  both: z.number().int(),
  /** Found only by retrieval: the aliased imports and wrappers grep cannot see. */
  moss_only: z.number().int(),
  /** Found only by grep. Recorded, not hidden — these are retrieval's misses. */
  grep_only: z.number().int(),
  /** Files tree-sitter could not parse. Grep still covered them (§M.10). */
  unparsed: z.number().int(),
  chunks: z.number().int(),
  /** Retrieval wall time for this repo's queries, summed across changes. */
  query_ms: z.number(),
});
export type DiscoveryComparison = z.infer<typeof DiscoveryComparison>;

export const MigrationTargetView = z.object({
  repo_id: RepoId,
  repo_slug: z.string(),
  wave: z.number().int(),
  arm: MigrationArm,
  stratum: z.string(),
  task_id: TaskId.nullable(),
  sites: z.number().int(),
});
export type MigrationTargetView = z.infer<typeof MigrationTargetView>;

export const MigrationView = z.object({
  id: z.string(),
  provider: z.string(),
  package: z.string(),
  from_version: z.string().nullable(),
  to_version: z.string().nullable(),
  created_by: z.string(),
  created_at: Timestamp,
  /** §M.5.3 — null until a human confirmed the extracted changes. Nothing runs before that. */
  changes_confirmed_at: Timestamp.nullable(),
  changes_confirmed_by: z.string().nullable(),
  changes: z.array(MigrationChange),
  targets: z.array(MigrationTargetView),
  discovery: z.array(DiscoveryComparison),
  /**
   * §M.5.6 — wave 1+ is gated on evidence, not a timer: at least one canary must have a
   * passing verify run at its head before the next wave can launch.
   */
  canaryGreen: z.boolean(),
  nextWave: z.number().int().nullable(),
  /** §M.5.6 — live lanes across this daemon, against the cap. */
  liveLanes: z.number().int(),
  maxLiveLanes: z.number().int(),
});
export type MigrationView = z.infer<typeof MigrationView>;

/**
 * §M.5.7 — the digest A/B readout.
 *
 * **Every number here is derived by query; none is stored as a conclusion.** That is the
 * PRD's rule and it matters: a stored "digest_on wins" would survive the data that justified
 * it. `n` travels with each arm because at 4–8 demo repos this is a demonstration of the
 * methodology, not a statistically meaningful result, and the UI has to be able to say so.
 */
export const ArmMetrics = z.object({
  arm: MigrationArm,
  /** Lanes in this arm that have been launched. The `n` behind every other number. */
  n: z.number().int(),
  /** Lanes whose *first* required run passed — the headline number (§M.5.7). */
  firstAttemptPass: z.number().int(),
  /** Mean chat turns until the first all-green run, over lanes that got there. */
  turnsToGreen: z.number().nullable(),
  /** Gate rows that were rejected or edited before approval. */
  humanEditsAtGate: z.number().int(),
  /** Sum of `context_pack.tokens_used` across the arm's lanes. */
  contextTokens: z.number().int(),
});
export type ArmMetrics = z.infer<typeof ArmMetrics>;

export const MigrationMetrics = z.object({
  migration_id: z.string(),
  arms: z.array(ArmMetrics),
  /** §M.1.7 — retrieval p50/p95 over the lanes of this migration. */
  retrievalP50Ms: z.number().nullable(),
  retrievalP95Ms: z.number().nullable(),
});
export type MigrationMetrics = z.infer<typeof MigrationMetrics>;

/** §M.5.8 — a site verification found that discovery did not. */
export const DiscoveryMiss = z.object({
  id: z.string(),
  repo_id: RepoId,
  file: z.string(),
  line: z.number().int(),
  pattern: z.string(),
  verify_run_id: z.string(),
  fixture_path: z.string().nullable(),
});
export type DiscoveryMiss = z.infer<typeof DiscoveryMiss>;
