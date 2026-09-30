import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { toOutboxRow, type CataloguedEventType, type NewOutboxEvent } from '@foc/platform';
import { execute, type Database } from '../db/db.js';
import { activationTokens, outboxEvents, profiles, userRoles, users } from '../db/schema.js';

export type AccountStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED';
export type Role = 'STUDENT' | 'ADMIN';

export interface NewUser {
  id: string;
  email: string;
  passwordHash: string;
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
          VALUES (${user.id}, ${user.email}, ${user.passwordHash}, 'PENDING_ACTIVATION')
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
    t: { id: string; userId: string; tokenHash: string; ttlHours: number },
  ): Promise<void> {
    await db.insert(activationTokens).values({
      id: t.id,
      userId: t.userId,
      tokenHash: t.tokenHash,
      expiresAt: sql`now() + make_interval(hours => ${t.ttlHours})`,
    });
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
  ): Promise<{ userId: string; consumed: boolean } | null> {
    const rows = await db
      .select({ userId: activationTokens.userId, consumedAt: activationTokens.consumedAt })
      .from(activationTokens)
      .where(eq(activationTokens.tokenHash, tokenHash));
    const row = rows[0];
    return row ? { userId: row.userId, consumed: row.consumedAt !== null } : null;
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

  /** Login lookup. The only place a password hash is read, and it never leaves the auth service. */
  async findCredentials(
    db: Database,
    normalizedEmail: string,
  ): Promise<{
    id: string;
    passwordHash: string;
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
