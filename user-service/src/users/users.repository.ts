// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Sonnet 5, Claude Opus 4.8), dates: 2026-09-20 to
//   2026-11-05
// Scope: Generated the initial implementation for "registration, one-time activation and identity
//   lookup" (USR-01, USR-02, USR-03); later tests, new features and bug fixes.
// Author review: Anselm Long, Jonus Ho, Patrick Thomas and Zhang Yuan validated correctness and the
//   implementation, and checked for fatal errors and architectural conflicts, before committing.

import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { toOutboxRow, type CataloguedEventType, type NewOutboxEvent } from '@foc/platform';
import { execute, type Database } from '../db/db.js';
import {
  activationTokens,
  outboxEvents,
  passwordResetTokens,
  profiles,
  userRoles,
  users,
} from '../db/schema.js';

export type AccountStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED';
export type Role = 'STUDENT' | 'ADMIN';

/** A registration: no password, which is chosen at activation once the inbox is proven (#309). */
export interface NewUser {
  id: string;
  email: string;
  displayName: string;
}

export interface IdentityRow {
  status: AccountStatus;
  roles: Role[];
  displayName: string;
}

/** A user's roles as a sorted array, correlated to the outer `users` row. */
export const rolesOf = sql<
  Role[]
>`array(SELECT r.role FROM user_roles r WHERE r.user_id = ${users.id} ORDER BY r.role)`;

/** Profile columns a self-service update may set, in a fixed camelCase list. */
const PROFILE_KEYS = [
  'displayName',
  'faculty',
  'avatarRef',
  'contactPreference',
  'preferredMode',
] as const;

/**
 * All SQL for the identity tables, expressed through Drizzle. Every function
 * takes a {@link Database} — the top-level instance or a transaction handle — so
 * the service can run several of them in one transaction.
 */
export const usersRepository = {
  /** Inserts the user, or returns false if the email is taken (unique index, race-safe). */
  async insertUser(db: Database, user: NewUser): Promise<boolean> {
    // DO NOTHING rather than catching the violation, which would abort the caller's transaction.
    // Targeting the email index keeps any other conflict (a primary-key collision) an error;
    // Drizzle cannot name an expression index, so the statement is written out.
    const inserted = await execute(
      db,
      sql`INSERT INTO ${users} (id, email, password_hash, status)
          VALUES (${user.id}, ${user.email}, NULL, 'PENDING_ACTIVATION')
          ON CONFLICT ((lower(email))) DO NOTHING
          RETURNING id`,
    );
    if (inserted.length === 0) return false;
    await db.insert(userRoles).values({ userId: user.id, role: 'STUDENT' });
    await db.insert(profiles).values({ userId: user.id, displayName: user.displayName });
    return true;
  },

  async insertActivationToken(
    db: Database,
    t: { id: string; userId: string; tokenHash: string; ttlMinutes: number },
  ): Promise<void> {
    await db.insert(activationTokens).values({
      id: t.id,
      userId: t.userId,
      tokenHash: t.tokenHash,
      expiresAt: sql`now() + make_interval(mins => ${t.ttlMinutes})`,
    });
  },

  /**
   * Re-registration of an address that never activated and whose every link has expired: the new
   * registrant sets the display name, and the password stays unset until the inbox is proven. A
   * pending account with a live link, or any activated one, is left alone. Returns the account's id.
   *
   * Locks the account first, then looks for a live link in a statement of its own: under READ
   * COMMITTED that statement sees a link a concurrent re-register committed while this one waited
   * on the lock, which a single UPDATE re-checked after the wait would not.
   */
  async reviveExpiredRegistration(db: Database, user: Omit<NewUser, 'id'>): Promise<string | null> {
    const id = await usersRepository.lockPendingUser(db, user.email);
    if (!id) return null;
    const live = await db
      .select({ id: activationTokens.id })
      .from(activationTokens)
      .where(
        and(
          eq(activationTokens.userId, id),
          isNull(activationTokens.consumedAt),
          sql`${activationTokens.expiresAt} > now()`,
        ),
      )
      .limit(1);
    if (live.length > 0) return null;
    await db
      .update(users)
      .set({ passwordHash: null, updatedAt: sql`now()` })
      .where(eq(users.id, id));
    await db.update(profiles).set({ displayName: user.displayName }).where(eq(profiles.userId, id));
    return id;
  },

  /** The pending account at this address, locked until the transaction ends so resends queue. */
  async lockPendingUser(db: Database, normalizedEmail: string): Promise<string | null> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = lower(${normalizedEmail})`,
          eq(users.status, 'PENDING_ACTIVATION'),
        ),
      )
      .for('update');
    return rows[0]?.id ?? null;
  },

  /**
   * Locks the account a token belongs to before the token itself. Resend locks the account and
   * then its tokens, so activation must take the same order or the two can deadlock. Returns the
   * account's status.
   */
  async lockUserOfToken(db: Database, tokenHash: string): Promise<AccountStatus | null> {
    const rows = await db
      .select({ status: users.status })
      .from(users)
      .innerJoin(activationTokens, eq(activationTokens.userId, users.id))
      .where(eq(activationTokens.tokenHash, tokenHash))
      .for('update', { of: users });
    return rows[0]?.status ?? null;
  },

  /** Invalidates every link not yet used, so only the one about to be sent works. */
  async deleteUnconsumedActivationTokens(db: Database, userId: string): Promise<void> {
    await db
      .delete(activationTokens)
      .where(and(eq(activationTokens.userId, userId), isNull(activationTokens.consumedAt)));
  },

  /**
   * Atomically claims a live token. The conditional UPDATE is the single-use
   * guarantee: two concurrent callers cannot both get a row back.
   */
  async consumeActivationToken(db: Database, tokenHash: string): Promise<string | null> {
    const rows = await db
      .update(activationTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(activationTokens.tokenHash, tokenHash),
          isNull(activationTokens.consumedAt),
          gt(activationTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: activationTokens.userId });
    return rows[0]?.userId ?? null;
  },

  async findActivationToken(
    db: Database,
    tokenHash: string,
  ): Promise<{ userId: string; consumed: boolean; expired: boolean } | null> {
    const rows = await db
      .select({
        userId: activationTokens.userId,
        consumed: sql<boolean>`${activationTokens.consumedAt} IS NOT NULL`,
        expired: sql<boolean>`${activationTokens.expiresAt} <= now()`,
      })
      .from(activationTokens)
      .where(eq(activationTokens.tokenHash, tokenHash));
    return rows[0] ?? null;
  },

  /** Flips PENDING_ACTIVATION → ACTIVE once. Returns false if the account was not pending. */
  async markActivated(db: Database, userId: string): Promise<boolean> {
    const rows = await db
      .update(users)
      .set({ status: 'ACTIVE', activatedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(users.id, userId), eq(users.status, 'PENDING_ACTIVATION')))
      .returning({ id: users.id });
    return rows.length > 0;
  },

  async isActivated(db: Database, userId: string): Promise<boolean> {
    const rows = await db
      .select({ one: sql`1` })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.status, 'ACTIVE'),
          sql`${users.activatedAt} IS NOT NULL`,
        ),
      );
    return rows.length > 0;
  },

  /**
   * The account at this address that may reset its password (#309): an active one, or one still
   * pending, since the reset link proves the inbox as activation does. A suspended account is not
   * returned. Locked until the transaction ends, so two requests for one account queue.
   */
  async lockResettableUser(db: Database, normalizedEmail: string): Promise<string | null> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = lower(${normalizedEmail})`,
          inArray(users.status, ['PENDING_ACTIVATION', 'ACTIVE']),
        ),
      )
      .for('update');
    return rows[0]?.id ?? null;
  },

  async insertPasswordResetToken(
    db: Database,
    t: { id: string; userId: string; tokenHash: string; ttlMinutes: number },
  ): Promise<void> {
    await db.insert(passwordResetTokens).values({
      id: t.id,
      userId: t.userId,
      tokenHash: t.tokenHash,
      expiresAt: sql`now() + make_interval(mins => ${t.ttlMinutes})`,
    });
  },

  /** Invalidates every reset link not yet used. */
  async deleteUnconsumedPasswordResetTokens(db: Database, userId: string): Promise<void> {
    await db
      .delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.consumedAt)));
  },

  /** What a reset token is, if it exists, and whether its account is a bootstrap administrator. */
  async findPasswordResetToken(
    db: Database,
    tokenHash: string,
  ): Promise<{ consumed: boolean; expired: boolean; isSeededAdmin: boolean } | null> {
    const rows = await db
      .select({
        consumed: sql<boolean>`${passwordResetTokens.consumedAt} IS NOT NULL`,
        expired: sql<boolean>`${passwordResetTokens.expiresAt} <= now()`,
        isSeededAdmin: users.isSeededAdmin,
      })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(eq(passwordResetTokens.tokenHash, tokenHash));
    return rows[0] ?? null;
  },

  /**
   * Locks the account a reset token belongs to, before the token itself, in the order a reset
   * request takes (account, then its tokens). Returns the account's status.
   */
  async lockUserOfPasswordResetToken(
    db: Database,
    tokenHash: string,
  ): Promise<AccountStatus | null> {
    const rows = await db
      .select({ status: users.status })
      .from(users)
      .innerJoin(passwordResetTokens, eq(passwordResetTokens.userId, users.id))
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .for('update', { of: users });
    return rows[0]?.status ?? null;
  },

  /** Claims a live reset token; as for activation, the conditional UPDATE makes it single use. */
  async consumePasswordResetToken(db: Database, tokenHash: string): Promise<string | null> {
    const rows = await db
      .update(passwordResetTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    return rows[0]?.userId ?? null;
  },

  /**
   * Sets a password the inbox owner chose through an emailed link, whatever the old one was. Clears
   * the forced-change flag: the bootstrap password is no longer the account's.
   */
  async setPassword(db: Database, userId: string, passwordHash: string): Promise<void> {
    await db
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
  },

  /**
   * Writes an event to the outbox in the caller's transaction. The type and payload must match the
   * shared catalogue (`@foc/platform` EVENTS / PAYLOAD_SCHEMAS): `toOutboxRow` validates the payload,
   * so a shape a consumer would dead-letter fails the change that produced it instead of reaching
   * the broker. The platform's OutboxRelay publishes the row once the transaction commits (EVT-02).
   */
  async insertOutboxEvent<K extends CataloguedEventType>(
    db: Database,
    e: NewOutboxEvent<K> & { id: string },
  ): Promise<void> {
    await db.insert(outboxEvents).values(toOutboxRow(e));
  },

  /** Password re-entry (`POST /auth/step-up`): the hash of a signed-in user, for the auth service only. */
  async findPasswordHash(db: Database, userId: string): Promise<string | null> {
    const rows = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    return rows[0]?.passwordHash ?? null;
  },

  /**
   * Login lookup. One of two places a password hash is read, and it never leaves the auth service.
   * The hash is null while the account is pending (#309): it has no password to match.
   */
  async findCredentials(
    db: Database,
    normalizedEmail: string,
  ): Promise<{
    id: string;
    passwordHash: string | null;
    status: AccountStatus;
    mustChangePassword: boolean;
    isSeededAdmin: boolean;
    displayName: string;
    roles: Role[];
  } | null> {
    const rows = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        isSeededAdmin: users.isSeededAdmin,
        displayName: sql<string>`coalesce(${profiles.displayName}, '')`,
        roles: rolesOf,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(sql`lower(${users.email}) = lower(${normalizedEmail})`);
    return rows[0] ?? null;
  },

  /**
   * Compare-and-swap on the stored hash: it succeeds only if the password is still the one the
   * caller just proved, so two simultaneous changes cannot both win. Clears the forced-change flag.
   */
  async replacePassword(
    db: Database,
    userId: string,
    expectedHash: string,
    newHash: string,
  ): Promise<boolean> {
    const rows = await db
      .update(users)
      .set({ passwordHash: newHash, mustChangePassword: false, updatedAt: sql`now()` })
      .where(and(eq(users.id, userId), eq(users.passwordHash, expectedHash)))
      .returning({ id: users.id });
    return rows.length > 0;
  },

  /** The caller's own account for `GET /users/me`. */
  async findMe(db: Database, userId: string) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        createdAt: users.createdAt,
        displayName: profiles.displayName,
        faculty: profiles.faculty,
        avatarRef: profiles.avatarRef,
        contactPreference: profiles.contactPreference,
        preferredMode: profiles.preferredMode,
        roles: rolesOf,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    return rows[0] ?? null;
  },

  /** Applies only the fields present. Column names come from a fixed map, never from input. */
  async updateProfile(
    db: Database,
    userId: string,
    changes: Partial<{
      displayName: string;
      faculty: string | null;
      avatarRef: string | null;
      contactPreference: string;
      preferredMode: string;
    }>,
  ): Promise<void> {
    const set: PgUpdateSetSource<typeof profiles> = {};
    for (const key of PROFILE_KEYS) {
      if (changes[key] !== undefined) (set as Record<string, unknown>)[key] = changes[key];
    }
    if (Object.keys(set).length === 0) return;
    await db.update(profiles).set(set).where(eq(profiles.userId, userId));
  },

  /**
   * Every ACTIVE user holding ADMIN who can sign in, by ID alone. A seeded admin that has not yet
   * replaced the bootstrap password cannot hold a session, so it is left out.
   */
  async listActiveAdminIds(db: Database): Promise<string[]> {
    const rows = await db
      .select({ userId: users.id })
      .from(users)
      .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, 'ADMIN')))
      .where(and(eq(users.status, 'ACTIVE'), eq(users.mustChangePassword, false)))
      .orderBy(users.id);
    return rows.map((row) => row.userId);
  },

  /** Deliberately selects only what the least-data lookup may return — never a hash or token. */
  async findIdentity(db: Database, userId: string): Promise<IdentityRow | null> {
    const rows = await db
      .select({
        status: users.status,
        displayName: sql<string>`coalesce(${profiles.displayName}, '')`,
        roles: rolesOf,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    const row = rows[0];
    return row ? { status: row.status, roles: row.roles, displayName: row.displayName } : null;
  },
};
