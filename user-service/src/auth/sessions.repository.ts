import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/db.js';
import { refreshSessions, users } from '../db/schema.js';
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

/** All SQL for refresh sessions. Every function takes a {@link Database} so callers control the transaction. */
export const sessionsRepository = {
  async insert(
    db: Database,
    s: { id: string; familyId: string; userId: string; tokenHash: string; ttlDays: number },
  ): Promise<void> {
    await db.insert(refreshSessions).values({
      id: s.id,
      familyId: s.familyId,
      userId: s.userId,
      tokenHash: s.tokenHash,
      expiresAt: sql`now() + make_interval(days => ${s.ttlDays})`,
    });
  },

  /**
   * Starts a login's session only if the account is still what the caller verified: the same
   * password hash, `ACTIVE`, and not flagged. Returns false otherwise. `FOR SHARE` waits out a
   * password change or suspension in flight and then re-reads the row, so a login that verified the
   * old password cannot add a session after that change revoked the account's others.
   */
  async insertIfLoginable(
    db: Database,
    s: { id: string; familyId: string; userId: string; tokenHash: string; ttlDays: number },
    verifiedPasswordHash: string,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const loginable = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, s.userId),
            eq(users.passwordHash, verifiedPasswordHash),
            eq(users.status, 'ACTIVE'),
            eq(users.mustChangePassword, false),
          ),
        )
        .for('share');
      if (loginable.length === 0) return false;
      await sessionsRepository.insert(tx, s);
      return true;
    });
  },

  /**
   * Reads a session by token hash and locks its row for the transaction, so two
   * simultaneous refreshes with the same token are serialised: the second sees
   * the first's rotation and is treated as reuse.
   */
  async lockByHash(db: Database, tokenHash: string): Promise<LockedSession | null> {
    const rows = await db
      .select({
        id: refreshSessions.id,
        familyId: refreshSessions.familyId,
        userId: refreshSessions.userId,
        expired: sql<boolean>`${refreshSessions.expiresAt} <= now()`,
        rotated: sql<boolean>`${refreshSessions.rotatedAt} IS NOT NULL`,
        revoked: sql<boolean>`${refreshSessions.revokedAt} IS NOT NULL`,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
      })
      .from(refreshSessions)
      .innerJoin(users, eq(users.id, refreshSessions.userId))
      .where(eq(refreshSessions.tokenHash, tokenHash))
      .for('update', { of: refreshSessions });
    const r = rows[0];
    return r
      ? {
          id: r.id,
          familyId: r.familyId,
          userId: r.userId,
          expired: r.expired,
          rotated: r.rotated,
          revoked: r.revoked,
          userStatus: r.status,
          mustChangePassword: r.mustChangePassword,
        }
      : null;
  },

  async markRotated(db: Database, id: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ rotatedAt: sql`now()` })
      .where(eq(refreshSessions.id, id));
  },

  async revokeFamily(db: Database, familyId: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshSessions.familyId, familyId), isNull(refreshSessions.revokedAt)));
  },

  /** Revokes the whole family the given token belongs to. Idempotent; unknown tokens do nothing. */
  async revokeFamilyByTokenHash(db: Database, tokenHash: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          isNull(refreshSessions.revokedAt),
          eq(
            refreshSessions.familyId,
            sql`(SELECT family_id FROM refresh_sessions WHERE token_hash = ${tokenHash})`,
          ),
        ),
      );
  },

  /** Used when an account is suspended: every session it owns dies at once. */
  async revokeAllForUser(db: Database, userId: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
  },

  /**
   * For the access-token guard and introspection: is this session still usable, and what state is
   * its account in? An account that must replace a bootstrap password has no live session: login
   * never starts one, so any it has predates migration 004 or came from an instance on older code.
   */
  async liveness(
    db: Database,
    sessionId: string,
    userId: string,
  ): Promise<{ live: boolean; status: AccountStatus } | null> {
    const rows = await db
      .select({
        live: sql<boolean>`(${refreshSessions.revokedAt} IS NULL AND ${refreshSessions.expiresAt} > now() AND NOT ${users.mustChangePassword})`,
        status: users.status,
      })
      .from(refreshSessions)
      .innerJoin(users, eq(users.id, refreshSessions.userId))
      .where(and(eq(refreshSessions.id, sessionId), eq(refreshSessions.userId, userId)));
    return rows[0] ?? null;
  },
};
