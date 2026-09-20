import { createHash, randomBytes } from 'node:crypto';

import type { Db } from '../db/index.js';

/**
 * Identity, roles and sessions — OSADE-MOSS §M.6.2, §M.6.6.
 *
 * **GitHub login is the only identity.** No Osade accounts, no passwords: §M.6.3 needs
 * `decided_by` to mean something outside this machine, and it only does if GitHub says who the
 * approver is.
 *
 * **The session token is never stored.** Only its sha256 is. A teammate's *GitHub* token is
 * used once — to answer "who are you" — and discarded; it is never kept and never used for a
 * write. Every GitHub write still goes through the host's token, behind a gate.
 */

export type Role = 'owner' | 'maintainer' | 'viewer';

/** Higher is more. Comparisons are by rank so a new role slots in without touching call sites. */
const RANK: Record<Role, number> = { viewer: 0, maintainer: 1, owner: 2 };

export function atLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export interface Session {
  readonly login: string;
  readonly role: Role;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface MembersOptions {
  readonly now?: () => number;
  /** §M.9.2 `server.sessionTtlHours`. */
  readonly sessionTtlHours?: number;
  /**
   * Resolves a GitHub token to its login. Injected so the whole auth path is testable without
   * a network, and so this module never imports an SCM SDK (§11).
   */
  readonly identify?: (githubToken: string) => Promise<string | null>;
}

export class Members {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #identify: ((githubToken: string) => Promise<string | null>) | null;

  constructor(db: Db, options: MembersOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = (options.sessionTtlHours ?? 12) * 60 * 60 * 1000;
    this.#identify = options.identify ?? null;
  }

  /**
   * §M.6.2 — the host's own login becomes the owner, once.
   *
   * Idempotent, and it never demotes: re-running it on a daemon that already has an owner is a
   * no-op rather than a silent change of who is in charge.
   */
  ensureOwner(login: string): void {
    const existing = this.get(login);
    if (existing) return;
    this.#db
      .prepare(
        `INSERT INTO member (login, role, invited_by, invited_at) VALUES (?, 'owner', ?, ?)
         ON CONFLICT(login) DO NOTHING`,
      )
      .run(login, login, this.#now());
  }

  invite(login: string, role: Role, invitedBy: string): void {
    if (role === 'owner') {
      // There is exactly one owner: the person whose machine this is and whose GitHub token
      // does every write. "Invite someone as owner" would be handing over the shell (M3).
      throw new AuthError('the owner is the host of this daemon and cannot be invited');
    }
    this.#db
      .prepare(
        `INSERT INTO member (login, role, invited_by, invited_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET role = excluded.role, removed_at = NULL`,
      )
      .run(login, role, invitedBy, this.#now());
  }

  setRole(login: string, role: Role): void {
    const member = this.get(login);
    if (!member) throw new AuthError(`${login} is not a member`);
    if (member.role === 'owner' || role === 'owner') {
      throw new AuthError('the owner role is not transferable');
    }
    this.#db.prepare('UPDATE member SET role = ? WHERE login = ?').run(role, login);
  }

  /**
   * §M.10 — removing a teammate revokes their sessions immediately.
   *
   * In the same transaction as the removal, so there is no window in which someone is "not a
   * member" but still holds a working token.
   */
  remove(login: string): void {
    const member = this.get(login);
    if (member?.role === 'owner') throw new AuthError('the owner cannot be removed');
    const at = this.#now();
    this.#db.transaction(() => {
      this.#db.prepare('UPDATE member SET removed_at = ? WHERE login = ?').run(at, login);
      this.#db
        .prepare('UPDATE member_session SET revoked_at = ? WHERE login = ? AND revoked_at IS NULL')
        .run(at, login);
    })();
  }

  get(login: string): { login: string; role: Role } | null {
    const row = this.#db
      .prepare('SELECT login, role FROM member WHERE login = ? AND removed_at IS NULL')
      .get(login) as { login: string; role: Role } | undefined;
    return row ?? null;
  }

  list(): { login: string; role: Role; invited_by: string; invited_at: number }[] {
    return this.#db
      .prepare(
        'SELECT login, role, invited_by, invited_at FROM member WHERE removed_at IS NULL ORDER BY login',
      )
      .all() as { login: string; role: Role; invited_by: string; invited_at: number }[];
  }

  /**
   * §M.6.2 — exchanges a teammate's GitHub token for an Osade session token.
   *
   * Four steps, and the order matters: verify the token with GitHub, check the login is an
   * invited member, mint an opaque token, store only its hash. The GitHub token is not kept
   * past this function — it answered one question and has no further use.
   */
  async exchange(githubToken: string): Promise<{ token: string; login: string; role: Role }> {
    if (!this.#identify) throw new AuthError('this daemon cannot verify GitHub identities');

    const login = await this.#identify(githubToken);
    if (!login) throw new AuthError('that GitHub token does not identify anyone');

    const member = this.get(login);
    // Only invited logins get in. A valid GitHub token proves who you are, not that you were
    // asked to this session.
    if (!member) throw new AuthError(`${login} has not been invited to this session`);

    const token = randomBytes(32).toString('base64url');
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO member_session (token_hash, login, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(hashToken(token), login, now, now + this.#ttlMs);

    return { token, login, role: member.role };
  }

  /** Null for anything that is not a live session: unknown, expired, revoked, or removed. */
  resolve(token: string | null | undefined): Session | null {
    if (!token) return null;
    const row = this.#db
      .prepare(
        `SELECT s.login, m.role, s.expires_at, s.revoked_at
           FROM member_session s
           JOIN member m ON m.login = s.login
          WHERE s.token_hash = ? AND m.removed_at IS NULL`,
      )
      .get(hashToken(token)) as
      | { login: string; role: Role; expires_at: number; revoked_at: number | null }
      | undefined;

    if (!row || row.revoked_at != null || row.expires_at <= this.#now()) return null;
    return { login: row.login, role: row.role };
  }

  logout(token: string): void {
    this.#db
      .prepare('UPDATE member_session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.#now(), hashToken(token));
  }

  /** Housekeeping. An expired row is already unusable; this just stops the table growing. */
  pruneSessions(): number {
    return this.#db
      .prepare('DELETE FROM member_session WHERE expires_at < ?')
      .run(this.#now() - this.#ttlMs).changes;
  }

  // ── presence and claims (§M.6.7) ────────────────────────────────────────────

  beat(login: string, taskId: string): void {
    this.#db
      .prepare(
        `INSERT INTO presence (login, task_id, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(login, task_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(login, taskId, this.#now());
  }

  /** Who is looking at a lane, within the TTL. Derived from heartbeats, never stored as a flag. */
  presence(taskId: string, ttlMs = PRESENCE_TTL_MS): string[] {
    const rows = this.#db
      .prepare('SELECT login FROM presence WHERE task_id = ? AND last_seen > ? ORDER BY login')
      .all(taskId, this.#now() - ttlMs) as { login: string }[];
    return rows.map((row) => row.login);
  }

  /**
   * §M.6.7 — advisory. It records who is driving; it does not lock the lane.
   *
   * A maintainer can still send to a lane someone else has claimed: the composer warns, the
   * turn is authored, and the trail shows who redirected what. A hard lock would mean a
   * teammate who closed their laptop could block the work for five minutes.
   */
  claim(taskId: string, login: string): void {
    const at = this.#now();
    this.#db.transaction(() => {
      this.#db
        .prepare('UPDATE task_claim SET released_at = ? WHERE task_id = ? AND released_at IS NULL')
        .run(at, taskId);
      this.#db
        .prepare(
          `INSERT INTO task_claim (task_id, login, claimed_at) VALUES (?, ?, ?)
           ON CONFLICT(task_id, login) DO UPDATE SET claimed_at = excluded.claimed_at,
                                                     released_at = NULL`,
        )
        .run(taskId, login, at);
    })();
  }

  release(taskId: string, login: string): void {
    this.#db
      .prepare(
        'UPDATE task_claim SET released_at = ? WHERE task_id = ? AND login = ? AND released_at IS NULL',
      )
      .run(this.#now(), taskId, login);
  }

  /**
   * Who is driving a lane, or null.
   *
   * A claim whose owner stopped heartbeating more than the TTL ago is treated as released:
   * §M.6.7 expires a claim on presence, so a closed laptop does not leave a lane looking taken
   * forever.
   */
  claimedBy(taskId: string, ttlMs = PRESENCE_TTL_MS): string | null {
    const row = this.#db
      .prepare(
        `SELECT c.login FROM task_claim c
           LEFT JOIN presence p ON p.task_id = c.task_id AND p.login = c.login
          WHERE c.task_id = ? AND c.released_at IS NULL
            AND (p.last_seen IS NULL OR p.last_seen > ?)
          ORDER BY c.claimed_at DESC LIMIT 1`,
      )
      .get(taskId, this.#now() - ttlMs) as { login: string } | undefined;
    return row?.login ?? null;
  }
}

/** §M.6.7 — five minutes with no heartbeat clears a claim. */
export const PRESENCE_TTL_MS = 5 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
