import type { Namespace } from '@osade/contract';

/**
 * Per-namespace retrieval settings — OSADE-MOSS §M.1.6.
 *
 * `alpha` blends semantic and keyword scoring: 1.0 is pure semantic, 0.0 pure keyword. The
 * values below are the PRD's, and the reasoning is worth keeping next to them because it is
 * the one thing a reader will want to change: prose retrieves well semantically, code does
 * not. Identifiers carry half the signal in a call site, and a pure-semantic query loses exact
 * symbol matches — which is the entire point of F1's discovery stage.
 */
export interface NamespaceSettings {
  /** §M.12 Q4 — measure before trusting `moss-mediumlm` on code; the choice is config, not code. */
  readonly model: 'moss-minilm' | 'moss-mediumlm';
  readonly alpha: number;
  /**
   * Hits below this are dropped (§M.2.2 step 3). Calibrated during the sprint; deliberately
   * permissive for now, because a missing convention is invisible while a spurious one is
   * visible and cheap to ignore.
   */
  readonly minScore: number;
}

export const NAMESPACE_SETTINGS: Readonly<Record<Namespace, NamespaceSettings>> = {
  turns: { model: 'moss-minilm', alpha: 0.8, minScore: 0.1 },
  conventions: { model: 'moss-minilm', alpha: 0.8, minScore: 0.1 },
  policies: { model: 'moss-minilm', alpha: 0.7, minScore: 0.15 },
  code: { model: 'moss-mediumlm', alpha: 0.5, minScore: 0.15 },
  prs: { model: 'moss-minilm', alpha: 0.8, minScore: 0.2 },
};

/**
 * §M.2.2 step 4 — items are ordered by `score × source_weight`.
 *
 * A sibling lane's *verified* fix outranks a convention, because it is evidence that something
 * worked on this exact change rather than a general rule. A turn ranks below both: it is
 * context, not instruction.
 */
export const SOURCE_WEIGHT: Readonly<Record<Namespace, number>> = {
  turns: 0.8,
  conventions: 1.0,
  policies: 1.0,
  code: 1.0,
  prs: 0.8,
};

/** A verified sibling fix is a turn, but it is the one turn worth more than a convention. */
export const VERIFIED_SIBLING_WEIGHT = 1.3;
