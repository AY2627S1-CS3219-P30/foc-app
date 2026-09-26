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
    }>(
      `SELECT s.id, s.family_id, s.user_id,
              s.expires_at <= now() AS expired,
              s.rotated_at IS NOT NULL AS rotated,
              s.revoked_at IS NOT NULL AS revoked,
              u.status
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

  /** For the access-token guard: is this session still usable, and what state is its account in? */
  async liveness(
    q: Queryable,
    sessionId: string,
    userId: string,
  ): Promise<{ live: boolean; status: AccountStatus } | null> {
    const { rows } = await q.query<{ live: boolean; status: AccountStatus }>(
      `SELECT (s.revoked_at IS NULL AND s.expires_at > now()) AS live, u.status
       FROM refresh_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [sessionId, userId],
    );
    return rows[0] ?? null;
  },
};
