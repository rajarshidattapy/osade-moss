import { describe, expect, it } from 'vitest';

import { appRouter } from '../../src/server/router.js';
import {
  EXECUTES_ARBITRARY_CODE,
  requiredRole,
  ROLE_MATRIX,
} from '../../src/server/roles.js';
import { atLeast } from '../../src/server/members.js';

/**
 * OSADE-MOSS §M.6.6 / §M.9.3 — every router procedure declares a role.
 *
 * The test §M.6.6 specifies: iterate every procedure in the router and assert its declared
 * role. **A new procedure without a declaration fails this test**, which is the point — the
 * failure mode being prevented is someone adding a procedure, forgetting the matrix entry, and
 * a viewer quietly gaining the ability to use it.
 *
 * INVARIANT M3 gets its own assertion below, and it is deliberately phrased in terms of what is
 * being handed out rather than in terms of a string: if one of those procedures is ever
 * loosened, the failure message says "this gives a teammate code execution on the host".
 */

function procedureNames(): string[] {
  // tRPC exposes the built procedures as a record on `_def`. Reading it rather than
  // maintaining a parallel list is what makes this test able to catch a *new* procedure.
  const defs = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  return Object.keys(defs).sort();
}

describe('§M.6.6 — every procedure declares a role', () => {
  it('finds the router procedures at all', () => {
    // If tRPC's internals move, this test would silently pass over an empty list and stop
    // guarding anything. Assert it found a plausible number first.
    expect(procedureNames().length).toBeGreaterThan(30);
  });

  it('has a declared role for every procedure', () => {
    const undeclared = procedureNames().filter((name) => requiredRole(name) === undefined);
    expect(
      undeclared,
      `these procedures have no entry in ROLE_MATRIX, so they are denied at runtime: ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('has no stale entries for procedures that no longer exist', () => {
    const live = new Set(procedureNames());
    const stale = Object.keys(ROLE_MATRIX).filter((name) => !live.has(name));
    expect(stale, `ROLE_MATRIX names procedures the router does not have: ${stale.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('INVARIANT M3 — nothing that runs code on the host reaches a non-owner', () => {
  it('keeps every arbitrary-code procedure at owner', () => {
    for (const name of EXECUTES_ARBITRARY_CODE) {
      const role = requiredRole(name);
      expect(
        role,
        `${name} gives the caller code execution on the owner's machine (§M.6.6). It must be owner-only.`,
      ).toBe('owner');
    }
  });

  it('a maintainer cannot reach any of them', () => {
    for (const name of EXECUTES_ARBITRARY_CODE) {
      const role = requiredRole(name);
      // Undeclared would also mean unreachable, but the assertion above already rules that
      // out — here the question is specifically whether a maintainer clears the bar.
      expect(role != null && atLeast('maintainer', role)).toBe(false);
    }
  });

  it('covers the three kinds §M.6.6 calls out', () => {
    // The lane shell, verification-plan edits, and spawning an agent process. Listed
    // explicitly so deleting one from EXECUTES_ARBITRARY_CODE does not quietly shrink the
    // assertion above into a test of an empty list.
    for (const name of ['taskShellOpen', 'verifyPlanConfirm', 'runHeadless']) {
      expect(EXECUTES_ARBITRARY_CODE).toContain(name);
    }
  });
});

describe('the shape of the matrix', () => {
  it('leaves only the door unauthenticated', () => {
    const open = Object.entries(ROLE_MATRIX)
      .filter(([, role]) => role === null)
      .map(([name]) => name)
      .sort();
    // `health` so a client can tell the daemon is up, `authExchange` because it *is* the
    // authentication. Anything else being open would need an argument.
    expect(open).toEqual(['authExchange', 'health']);
  });

  it('keeps every write at maintainer or above', () => {
    const writesAtViewer = Object.entries(ROLE_MATRIX)
      .filter(([name, role]) => role === 'viewer' && WRITE_SHAPED.test(name))
      .map(([name]) => name);
    // Two deliberate exceptions. `presenceBeat`, so presence is not limited to the people who
    // can change things; `authLogout`, because ending your own session is not a privilege.
    expect(writesAtViewer).toEqual(['authLogout', 'presenceBeat']);
  });

  it('puts membership changes at owner', () => {
    for (const name of ['memberInvite', 'memberRemove', 'memberSetRole']) {
      expect(requiredRole(name)).toBe('owner');
    }
  });
});

/** Names that read as mutations. Crude on purpose: it should over-match and be argued with. */
const WRITE_SHAPED = /(Create|Write|Send|Set|Decide|Launch|Run|Invite|Remove|Reload|Confirm|Reject|Ack|Claim|Release|Beat|Undo|Stop|Archive|Rebuild|Export|Open|Exchange|Logout)$/;
