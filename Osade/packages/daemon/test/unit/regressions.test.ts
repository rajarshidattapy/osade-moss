import { describe, expect, it } from 'vitest';

import { SubstratePaneId, SubstrateTabId, SubstrateWorkspaceId } from '@osade/contract';

import { paddedAt, paddedSeq } from '../../src/retrieval/projectors.js';
import { appliesToPath } from '../../src/knowledge/policies.js';
import { splitIdentifiers } from '../../src/domain/gate-clauses.js';

/**
 * Regressions for bugs that shipped, or nearly did.
 *
 * Each block below is a mistake that was *made* in this codebase, not a hypothetical. They are
 * unit tests rather than integration ones on purpose: every one of these was a wrong assumption
 * about a **format or a unit**, and the cheapest place to pin an assumption is next to it. The
 * behaviours they protect are covered elsewhere; what is covered here is the specific confusion
 * that produced the bug.
 */

describe('substrate ids are base-32, not decimal', () => {
  /**
   * The bug: `SubstrateWorkspaceId` was `/^w\d+$/`.
   *
   * The substrate encodes public numbers in a 32-character Crockford-style alphabet
   * (`backend/src/workspace.rs:105`), so the tenth workspace is `wA` and the thirty-third is
   * `w11`. A decimal pattern accepts the first nine and rejects everything after — invisible
   * until someone opens a tenth workspace, at which point every launch fails validation.
   */
  it('accepts the ids the substrate actually mints', () => {
    // encode_public_number: 1 → "1", 9 → "9", 10 → "A", 31 → "Z", 32 → "0", 33 → "11".
    for (const id of ['w1', 'w9', 'wA', 'wZ', 'w0', 'w11', 'wAB']) {
      expect(SubstrateWorkspaceId.safeParse(id).success, id).toBe(true);
    }
    expect(SubstratePaneId.safeParse('wA:p2').success).toBe(true);
    expect(SubstrateTabId.safeParse('w11:tA').success).toBe(true);
  });

  it('still rejects what is not an id', () => {
    for (const id of ['3', 'w', 'workspace1', 'w-1', 'w 1', '']) {
      expect(SubstrateWorkspaceId.safeParse(id).success, id).toBe(false);
    }
    // A pane id is not a workspace id, and the two are not interchangeable (§5.2).
    expect(SubstrateWorkspaceId.safeParse('w1:p2').success).toBe(false);
    expect(SubstratePaneId.safeParse('w1').success).toBe(false);
  });

  it('excludes the letters the alphabet omits', () => {
    // I, L, O and U are left out to stop transcription errors. Accepting them would let a
    // typo validate as an id that can never exist.
    for (const id of ['wI', 'wL', 'wO', 'wU']) {
      expect(SubstrateWorkspaceId.safeParse(id).success, id).toBe(false);
    }
  });
});

describe('sortable keys are padded, and the units are not interchangeable', () => {
  /**
   * The bug: catch-up stored its cursor as a *timestamp* and filtered the ranked half on a
   * turn *sequence number*. Both are integers, so nothing complained — the window was simply
   * wrong, silently, in whichever direction the numbers happened to fall.
   *
   * `paddedAt` exists to give the `turns` namespace one clock: a catch-up window spans turns,
   * gate decisions and verify runs, and those share no sequence number.
   */
  it('paddedAt takes milliseconds and paddedSeq takes a count', () => {
    const ms = 1_756_000_000_000;
    // Seconds, not milliseconds — so the value stays inside twelve digits and lexical order
    // keeps matching numeric order.
    expect(paddedAt(ms)).toBe(paddedSeq(Math.floor(ms / 1000)));
    expect(paddedAt(ms)).toHaveLength(12);
  });

  it('a timestamp and a sequence number never collide in the padded space', () => {
    // This is the assertion that would have failed the original code: a turn's `seq` of 5 and
    // a cursor at a real timestamp are wildly different magnitudes, so comparing them filters
    // either everything or nothing.
    expect(paddedSeq(5) < paddedAt(1_756_000_000_000)).toBe(true);
    expect(paddedSeq(5)).not.toBe(paddedAt(5));
  });

  it('pads so lexical order is numeric order', () => {
    expect(paddedSeq(9) < paddedSeq(10)).toBe(true);
    expect(paddedSeq(99) < paddedSeq(100)).toBe(true);
    expect(paddedAt(1_000_000) < paddedAt(2_000_000)).toBe(true);
  });

  it('never produces a negative or fractional key', () => {
    expect(paddedSeq(-5)).toBe(paddedSeq(0));
    expect(paddedAt(1_500)).toBe(paddedSeq(1));
  });
});

describe('glob semantics for ** and **/', () => {
  /**
   * The bug: `src/**` did not match `src/a/b/config.ts`.
   *
   * The first translation rewrote `**` to an optional directory group and then required the
   * path to *end* where the `**` did, so a policy scoped to `src/**` silently covered nothing
   * below the first level — which is the opposite of what anyone writing it means.
   */
  it('a trailing ** matches any depth', () => {
    expect(appliesToPath(['src/**'], 'src/config.ts')).toBe(true);
    expect(appliesToPath(['src/**'], 'src/a/config.ts')).toBe(true);
    expect(appliesToPath(['src/**'], 'src/a/b/c/config.ts')).toBe(true);
    expect(appliesToPath(['src/**'], 'test/config.ts')).toBe(false);
  });

  it('a leading **/ may match nothing at all', () => {
    expect(appliesToPath(['**/x.ts'], 'x.ts')).toBe(true);
    expect(appliesToPath(['**/x.ts'], 'a/x.ts')).toBe(true);
    expect(appliesToPath(['**/x.ts'], 'a/b/x.ts')).toBe(true);
    expect(appliesToPath(['**/x.ts'], 'a/y.ts')).toBe(false);
  });

  it('a single * stays inside one segment', () => {
    expect(appliesToPath(['src/*.ts'], 'src/config.ts')).toBe(true);
    expect(appliesToPath(['src/*.ts'], 'src/a/config.ts')).toBe(false);
  });

  it('no globs means the clause applies everywhere in its scope', () => {
    expect(appliesToPath([], 'anything/at/all.ts')).toBe(true);
  });

  it('treats a dot as a literal, not a wildcard', () => {
    expect(appliesToPath(['src/a.ts'], 'src/axts')).toBe(false);
  });
});

describe('code and policy prose do not share a vocabulary', () => {
  /**
   * The bug: a diff adding `apiKey` never matched a policy saying "API key".
   *
   * To a keyword index those are different tokens, so the clause was simply never found — not
   * a ranking problem the semantic half could paper over, but the query missing the words.
   */
  it('splits camelCase so a keyword index can hit prose', () => {
    const split = splitIdentifiers('const apiKey = "x";');
    expect(split).toContain('api');
    expect(split).toContain('Key');
  });

  it('splits snake_case and screaming case too', () => {
    expect(splitIdentifiers('private_key')).toContain('private');
    expect(splitIdentifiers('private_key')).toContain('key');
    expect(splitIdentifiers('const SKLive = 1')).toContain('Live');
  });

  it('leaves single words alone rather than emitting noise', () => {
    // A token that does not split adds nothing; repeating it would only skew the term counts.
    expect(splitIdentifiers('const region = 1')).toBe('');
  });

  it('is stable — the same input gives the same words', () => {
    const once = splitIdentifiers('apiKey privateKey apiKey');
    expect(splitIdentifiers('apiKey privateKey apiKey')).toBe(once);
    // Deduplicated: `apiKey` twice does not double the weight of "api".
    expect(once.split(' ').filter((word) => word === 'api')).toHaveLength(1);
  });
});
