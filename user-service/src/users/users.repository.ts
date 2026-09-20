import type { Queryable } from '../db/db.js';

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

/**
 * All SQL for the identity tables. Every function takes a {@link Queryable} so
 * the service can run several of them in one transaction.
 */
export const usersRepository = {
  /** Inserts the user, or returns false if the email is taken (unique index, race-safe). */
  async insertUser(q: Queryable, user: NewUser): Promise<boolean> {
    const { rows } = await q.query(
      `INSERT INTO users (id, email, password_hash, status)
       VALUES ($1, $2, $3, 'PENDING_ACTIVATION')
       ON CONFLICT ((lower(email))) DO NOTHING
       RETURNING id`,
      [user.id, user.email, user.passwordHash],
    );
    if (rows.length === 0) return false;
    await q.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'STUDENT')`, [user.id]);
    await q.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [
      user.id,
      user.displayName,
    ]);
    return true;
  },

  async insertActivationToken(
    q: Queryable,
    t: { id: string; userId: string; tokenHash: string; ttlHours: number },
  ): Promise<void> {
    await q.query(
      `INSERT INTO activation_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [t.id, t.userId, t.tokenHash, t.ttlHours],
    );
  },

  /**
   * Atomically claims a live token. The conditional UPDATE is the single-use
   * guarantee: two concurrent callers cannot both get a row back.
   */
  async consumeActivationToken(q: Queryable, tokenHash: string): Promise<string | null> {
    const { rows } = await q.query<{ user_id: string }>(
      `UPDATE activation_tokens SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash],
    );
    return rows[0]?.user_id ?? null;
  },

  async findActivationToken(
    q: Queryable,
    tokenHash: string,
  ): Promise<{ userId: string; consumed: boolean } | null> {
    const { rows } = await q.query<{ user_id: string; consumed_at: unknown }>(
      `SELECT user_id, consumed_at FROM activation_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { userId: row.user_id, consumed: row.consumed_at !== null } : null;
  },

  /** Flips PENDING_ACTIVATION → ACTIVE once. Returns false if the account was not pending. */
  async markActivated(q: Queryable, userId: string): Promise<boolean> {
    const { rows } = await q.query(
      `UPDATE users SET status = 'ACTIVE', activated_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'PENDING_ACTIVATION'
       RETURNING id`,
      [userId],
    );
    return rows.length > 0;
  },

  async isActivated(q: Queryable, userId: string): Promise<boolean> {
    const { rows } = await q.query(
      `SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE' AND activated_at IS NOT NULL`,
      [userId],
    );
    return rows.length > 0;
  },

  async insertOutboxEvent(
    q: Queryable,
    e: {
      id: string;
      eventType: string;
      aggregateId: string;
      payload: unknown;
      correlationId: string;
    },
  ): Promise<void> {
    await q.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, correlation_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [e.id, e.eventType, e.aggregateId, JSON.stringify(e.payload), e.correlationId],
    );
  },

  /** Login lookup. The only place a password hash is read, and it never leaves the auth service. */
  async findCredentials(
    q: Queryable,
    normalizedEmail: string,
  ): Promise<{
    id: string;
    passwordHash: string;
    status: AccountStatus;
    displayName: string;
    roles: Role[];
  } | null> {
    const { rows } = await q.query<{
      id: string;
      password_hash: string;
      status: AccountStatus;
      display_name: string;
      roles: Role[];
    }>(
      `SELECT u.id, u.password_hash, u.status, coalesce(p.display_name, '') AS display_name,
              array(SELECT r.role FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE lower(u.email) = lower($1)`,
      [normalizedEmail],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          passwordHash: r.password_hash,
          status: r.status,
          displayName: r.display_name,
          roles: r.roles,
        }
      : null;
  },

  /** The caller's own account for `GET /users/me`. */
  async findMe(q: Queryable, userId: string) {
    const { rows } = await q.query<{
      id: string;
      email: string;
      status: AccountStatus;
      created_at: Date;
      display_name: string;
      faculty: string | null;
      avatar_ref: string | null;
      contact_preference: string;
      preferred_mode: string;
      roles: Role[];
    }>(
      `SELECT u.id, u.email, u.status, u.created_at, p.display_name, p.faculty, p.avatar_ref,
              p.contact_preference, p.preferred_mode,
              array(SELECT r.role FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles
       FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  },

  /** Deliberately selects only what the least-data lookup may return — never a hash or token. */
  async findIdentity(q: Queryable, userId: string): Promise<IdentityRow | null> {
    const { rows } = await q.query<{ status: AccountStatus; display_name: string; roles: Role[] }>(
      `SELECT u.status, coalesce(p.display_name, '') AS display_name,
              array(SELECT r.role FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    return row ? { status: row.status, roles: row.roles, displayName: row.display_name } : null;
  },
};
