import type { Queryable } from '../db/db.js';
import type { AccountStatus } from '../users/users.repository.js';

export interface LockedSession {
  id: string;
  familyId: string;
  userId: string;
  expired: boolean;
  rotated: boolean;
  revoked: boolean;
  userStatus: AccountStatus;
  mustChangePassword: boolean;
}

/** All SQL for refresh sessions. Every function takes a {@link Queryable} so callers control the transaction. */
export const sessionsRepository = {
  async insert(
    q: Queryable,
    s: { id: string; familyId: string; userId: string; tokenHash: string; ttlDays: number },
  ): Promise<void> {
    await q.query(
      `INSERT INTO refresh_sessions (id, family_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [s.id, s.familyId, s.userId, s.tokenHash, s.ttlDays],
    );
  },

  /**
   * Starts a login's session only if the account is still what the caller verified: the same
   * password hash, `ACTIVE`, and not flagged. Returns false otherwise. `FOR SHARE` waits out a
   * password change or suspension in flight and then re-reads the row, so a login that verified the
   * old password cannot add a session after that change revoked the account's others.
   */
  async insertIfLoginable(
    q: Queryable,
    s: { id: string; familyId: string; userId: string; tokenHash: string; ttlDays: number },
    verifiedPasswordHash: string,
  ): Promise<boolean> {
    const { rows } = await q.query(
      `INSERT INTO refresh_sessions (id, family_id, user_id, token_hash, expires_at)
       SELECT $1, $2, $3, $4, now() + make_interval(days => $5)
       WHERE EXISTS (
         SELECT 1 FROM users
         WHERE id = $3 AND password_hash = $6 AND status = 'ACTIVE' AND NOT must_change_password
         FOR SHARE
       )
       RETURNING id`,
      [s.id, s.familyId, s.userId, s.tokenHash, s.ttlDays, verifiedPasswordHash],
    );
    return rows.length > 0;
  },

  /**
   * Reads a session by token hash and locks its row for the transaction, so two
   * simultaneous refreshes with the same token are serialised: the second sees
   * the first's rotation and is treated as reuse.
   */
  async lockByHash(q: Queryable, tokenHash: string): Promise<LockedSession | null> {
    const { rows } = await q.query<{
      id: string;
      family_id: string;
      user_id: string;
      expired: boolean;
      rotated: boolean;
      revoked: boolean;
      status: AccountStatus;
      must_change_password: boolean;
    }>(
      `SELECT s.id, s.family_id, s.user_id,
              s.expires_at <= now() AS expired,
              s.rotated_at IS NOT NULL AS rotated,
              s.revoked_at IS NOT NULL AS revoked,
              u.status, u.must_change_password
       FROM refresh_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
       FOR UPDATE OF s`,
      [tokenHash],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          familyId: r.family_id,
          userId: r.user_id,
          expired: r.expired,
          rotated: r.rotated,
          revoked: r.revoked,
          userStatus: r.status,
          mustChangePassword: r.must_change_password,
        }
      : null;
  },

  async markRotated(q: Queryable, id: string): Promise<void> {
    await q.query(`UPDATE refresh_sessions SET rotated_at = now() WHERE id = $1`, [id]);
  },

  async revokeFamily(q: Queryable, familyId: string): Promise<void> {
    await q.query(
      `UPDATE refresh_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
  },

  /** Revokes the whole family the given token belongs to. Idempotent; unknown tokens do nothing. */
  async revokeFamilyByTokenHash(q: Queryable, tokenHash: string): Promise<void> {
    await q.query(
      `UPDATE refresh_sessions SET revoked_at = now()
       WHERE revoked_at IS NULL
         AND family_id = (SELECT family_id FROM refresh_sessions WHERE token_hash = $1)`,
      [tokenHash],
    );
  },

  /** Used when an account is suspended: every session it owns dies at once. */
  async revokeAllForUser(q: Queryable, userId: string): Promise<void> {
    await q.query(
      `UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  },

  /**
   * For the access-token guard and introspection: is this session still usable, and what state is
   * its account in? An account that must replace a bootstrap password has no live session: login
   * never starts one, so any it has predates migration 004 or came from an instance on older code.
   */
  async liveness(
    q: Queryable,
    sessionId: string,
    userId: string,
  ): Promise<{ live: boolean; status: AccountStatus } | null> {
    const { rows } = await q.query<{ live: boolean; status: AccountStatus }>(
      `SELECT (s.revoked_at IS NULL AND s.expires_at > now() AND NOT u.must_change_password) AS live,
              u.status
       FROM refresh_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [sessionId, userId],
    );
    return rows[0] ?? null;
  },
};
