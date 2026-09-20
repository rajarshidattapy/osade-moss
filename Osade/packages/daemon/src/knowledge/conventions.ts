import { randomUUID } from 'node:crypto';

import type { Db } from '../db/index.js';

/**
 * Repository conventions — OSADE.md §13.
 *
 * The thesis (§13.1): what gets a PR merged is not code correctness, it is conformance to a
 * project's tacit rules. Those rules exist in the record — in review comments, in what got
 * rejected, in the difference between what was submitted and what was merged.
 *
 * **INVARIANT (§13.1): a rule without evidence is not a rule.** Every convention must carry at
 * least one `convention_evidence` row pointing at a real URL, and unciteable rules are rejected
 * **at write time** rather than filtered later. This is what makes the output auditable rather
 * than another pile of model-generated guidance, and it is the difference between this feature
 * being worth shipping and being actively harmful.
 */

/** §13.3 — the categories a convention can fall into. */
export const CONVENTION_CATEGORIES = [
  'review_process',
  'scope_limits',
  'commit_style',
  'test_requirements',
  'file_ownership',
  'communication',
  'ci_gates',
] as const;

export type ConventionCategory = (typeof CONVENTION_CATEGORIES)[number];

/**
 * A convention's lifecycle.
 *
 * §5.3 calls this column `status`; it is `lifecycle` here so §20.1's "no column named status"
 * rule stays blanket-enforceable (PRD-DELTA #16). The values are the spec's.
 */
export type ConventionLifecycle = 'candidate' | 'active' | 'retired' | 'rejected';

export type EvidenceKind = 'merged_pr' | 'rejected_pr' | 'review_comment' | 'doc' | 'ci_config';

export interface Evidence {
  kind: EvidenceKind;
  url: string;
  /** ≤200 chars, for the UI. The quote that justifies the rule. */
  excerpt?: string | null;
  observedAt: number;
}

/** What comes back out. A stored excerpt is present or explicitly null, never absent. */
export interface StoredEvidence extends Evidence {
  excerpt: string | null;
}

export interface Convention {
  id: string;
  repoId: string;
  category: ConventionCategory;
  /** Imperative, one sentence. §13.5 injects this verbatim. */
  ruleText: string;
  rationale: string | null;
  confidence: number;
  lifecycle: ConventionLifecycle;
  minedAt: number;
  lastConfirmedAt: number | null;
  retiredReason: string | null;
}

export interface ConventionWithEvidence extends Convention {
  evidence: StoredEvidence[];
}

/** §13.4 — promotion to `active` requires this, or a human clicking confirm. */
export const AUTO_PROMOTE_CONFIDENCE = 0.8;

/** §13.4 — an `active` rule not re-confirmed in 180 days drops back to `candidate`. */
export const DECAY_MS = 180 * 24 * 60 * 60 * 1000;

/** §13.5 — a 200-rule context file is worse than none. */
export const MAX_INJECTED_RULES = 40;
export const MAX_INJECTED_TOKENS = 2000;

export class UnciteableRuleError extends Error {
  constructor(ruleText: string) {
    super(
      `refusing to write a convention with no evidence: "${ruleText}". ` +
        `§13.1 — a rule without evidence is not a rule.`,
    );
    this.name = 'UnciteableRuleError';
  }
}

export interface ConventionsOptions {
  now?: () => number;
}

export class Conventions {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, options: ConventionsOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Writes a convention and its evidence, atomically.
   *
   * §13.1 — rejects at write time when there is no evidence. Deliberately *not* a filter on
   * read: an unciteable rule that reaches the database is one a later refactor can start
   * trusting, and the whole claim of this feature is that every rule can be traced to
   * something a maintainer actually did.
   */
  write(input: {
    repoId: string;
    category: ConventionCategory;
    ruleText: string;
    rationale?: string | null;
    confidence: number;
    evidence: readonly Evidence[];
  }): string {
    if (input.evidence.length === 0) throw new UnciteableRuleError(input.ruleText);
    for (const e of input.evidence) {
      if (!e.url || e.url.trim().length === 0) throw new UnciteableRuleError(input.ruleText);
    }

    const id = `cv_${randomUUID().slice(0, 8)}`;
    const now = this.#now();

    const insert = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO convention
             (id, repo_id, category, rule_text, rationale, confidence, lifecycle, mined_at)
           VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?)`,
        )
        .run(
          id,
          input.repoId,
          input.category,
          input.ruleText,
          input.rationale ?? null,
          input.confidence,
          now,
        );

      for (const e of input.evidence) {
        this.#db
          .prepare(
            `INSERT INTO convention_evidence (id, convention_id, kind, url, excerpt, observed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `ce_${randomUUID().slice(0, 8)}`,
            id,
            e.kind,
            e.url,
            e.excerpt?.slice(0, 200) ?? null,
            e.observedAt,
          );
      }
    });
    insert();

    return id;
  }

  get(id: string): ConventionWithEvidence | null {
    const row = this.#db.prepare('SELECT * FROM convention WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return { ...rowToConvention(row), evidence: this.evidenceFor(id) };
  }

  evidenceFor(conventionId: string): StoredEvidence[] {
    const rows = this.#db
      .prepare('SELECT * FROM convention_evidence WHERE convention_id = ? ORDER BY observed_at')
      .all(conventionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      kind: r.kind as EvidenceKind,
      url: r.url as string,
      excerpt: (r.excerpt as string | null) ?? null,
      observedAt: r.observed_at as number,
    }));
  }

  list(repoId: string, lifecycle?: ConventionLifecycle): ConventionWithEvidence[] {
    const rows = (
      lifecycle
        ? this.#db
            .prepare('SELECT * FROM convention WHERE repo_id = ? AND lifecycle = ?')
            .all(repoId, lifecycle)
        : this.#db.prepare('SELECT * FROM convention WHERE repo_id = ?').all(repoId)
    ) as Record<string, unknown>[];

    return rows
      .map((r) => rowToConvention(r))
      .map((c) => ({ ...c, evidence: this.evidenceFor(c.id) }));
  }

  /**
   * Finds a rule this repo already has that says the same thing.
   *
   * A weekly re-mine (§13.4) sees the same conventions again, phrased differently each time.
   * Without this every run would deposit another near-duplicate, the injection budget would fill
   * with paraphrases of one rule, and `last_confirmed_at` would never advance on the original —
   * so the decay would retire rules the project still enforces.
   *
   * Matching is a Jaccard overlap of content words within the same category. Deliberately dumb:
   * a model call here would be a fourth pass with no way to check its work, and the failure mode
   * of being too strict (a duplicate a human can merge) is much cheaper than being too loose (a
   * rule silently absorbed into an unrelated one).
   */
  findSimilar(
    repoId: string,
    category: ConventionCategory,
    ruleText: string,
  ): ConventionWithEvidence | null {
    const target = contentWords(ruleText);
    if (target.size === 0) return null;

    let best: { convention: ConventionWithEvidence; score: number } | null = null;
    for (const candidate of this.list(repoId)) {
      if (candidate.category !== category) continue;
      if (candidate.lifecycle === 'rejected') continue;
      const score = jaccard(target, contentWords(candidate.ruleText));
      if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
        best = { convention: candidate, score };
      }
    }
    return best?.convention ?? null;
  }

  /**
   * Re-confirms an existing rule from a later mining run.
   *
   * Adds any evidence not already cited and moves `last_confirmed_at`, which is what holds the
   * 180-day decay off. Confidence takes the higher of the two: a run that happened to sample a
   * quiet week should not erode a rule that an earlier, richer run established.
   */
  reconfirm(id: string, evidence: readonly Evidence[], confidence?: number): void {
    const existing = this.get(id);
    if (!existing) return;

    const known = new Set(existing.evidence.map((e) => e.url));
    const now = this.#now();

    const update = this.#db.transaction(() => {
      for (const e of evidence) {
        if (known.has(e.url)) continue;
        this.#db
          .prepare(
            `INSERT INTO convention_evidence (id, convention_id, kind, url, excerpt, observed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `ce_${randomUUID().slice(0, 8)}`,
            id,
            e.kind,
            e.url,
            e.excerpt?.slice(0, 200) ?? null,
            e.observedAt,
          );
      }

      const nextConfidence = Math.max(existing.confidence, confidence ?? 0);
      this.#db
        .prepare('UPDATE convention SET last_confirmed_at = ?, confidence = ? WHERE id = ?')
        .run(now, nextConfidence, id);

      // A rule that decayed back to candidate and is seen again is current once more.
      if (existing.lifecycle === 'candidate' && nextConfidence >= AUTO_PROMOTE_CONFIDENCE) {
        this.#db.prepare("UPDATE convention SET lifecycle = 'active' WHERE id = ?").run(id);
      }
    });
    update();
  }

  /**
   * §13.4 — promotion to `active`.
   *
   * Automatic above the confidence threshold, or by one human click. Both are recorded the
   * same way, because `last_confirmed_at` is what the 180-day decay reads.
   */
  promote(id: string, by: 'confidence' | 'human'): boolean {
    const convention = this.get(id);
    if (!convention) return false;
    if (by === 'confidence' && convention.confidence < AUTO_PROMOTE_CONFIDENCE) return false;
    if (convention.lifecycle === 'rejected') return false;

    this.#db
      .prepare("UPDATE convention SET lifecycle = 'active', last_confirmed_at = ? WHERE id = ?")
      .run(this.#now(), id);
    return true;
  }

  reject(id: string, reason: string): void {
    this.#db
      .prepare("UPDATE convention SET lifecycle = 'rejected', retired_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  retire(id: string, reason: string): void {
    this.#db
      .prepare("UPDATE convention SET lifecycle = 'retired', retired_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  /**
   * §13.4 — conventions decay.
   *
   * An `active` rule not re-confirmed in 180 days drops to `candidate`. It is **not** deleted:
   * a project's conventions change slowly, and an unconfirmed rule is stale rather than wrong.
   * Returns how many decayed.
   */
  decay(): number {
    const cutoff = this.#now() - DECAY_MS;
    const result = this.#db
      .prepare(
        `UPDATE convention
            SET lifecycle = 'candidate',
                retired_reason = 'not re-confirmed in 180 days'
          WHERE lifecycle = 'active'
            AND COALESCE(last_confirmed_at, mined_at) < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  /**
   * The rules that get injected — §13.5.
   *
   * Capped at 40 and ranked by **confidence × recency**, because attention is the scarce
   * resource: every rule in the file competes with the actual task, and a 200-rule context is
   * worse than none. The overflow is returned separately so the UI can show it rather than
   * silently dropping it.
   */
  forInjection(repoId: string): { injected: ConventionWithEvidence[]; overflow: number } {
    const active = this.list(repoId, 'active');
    const now = this.#now();

    const ranked = [...active].sort((a, b) => score(b, now) - score(a, now));
    return {
      injected: ranked.slice(0, MAX_INJECTED_RULES),
      overflow: Math.max(0, ranked.length - MAX_INJECTED_RULES),
    };
  }
}

/** Two rules count as the same rule above this overlap. Tuned by the tests, not by feel. */
const SIMILARITY_THRESHOLD = 0.6;

/** Words that carry no meaning for rule identity, so overlap is measured on the rest. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'do', 'each', 'for', 'from', 'in',
  'into', 'is', 'it', 'must', 'not', 'of', 'on', 'or', 'should', 'that', 'the', 'their', 'them',
  'they', 'this', 'to', 'when', 'with', 'you', 'your',
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * confidence × recency.
 *
 * Recency halves every 90 days, so a rule confirmed last week outranks an equally confident one
 * from a year ago without ever dropping to zero.
 */
function score(c: Convention, now: number): number {
  const ageMs = now - (c.lastConfirmedAt ?? c.minedAt);
  const halfLife = 90 * 24 * 60 * 60 * 1000;
  return c.confidence * Math.pow(0.5, Math.max(0, ageMs) / halfLife);
}

function rowToConvention(r: Record<string, unknown>): Convention {
  return {
    id: r.id as string,
    repoId: r.repo_id as string,
    category: r.category as ConventionCategory,
    ruleText: r.rule_text as string,
    rationale: (r.rationale as string | null) ?? null,
    confidence: r.confidence as number,
    lifecycle: r.lifecycle as ConventionLifecycle,
    minedAt: r.mined_at as number,
    lastConfirmedAt: (r.last_confirmed_at as number | null) ?? null,
    retiredReason: (r.retired_reason as string | null) ?? null,
  };
}
