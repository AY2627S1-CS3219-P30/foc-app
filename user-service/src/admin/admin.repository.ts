import type { Queryable } from '../db/db.js';
import type { AccountStatus, Role } from '../users/users.repository.js';

export type AuditAction = 'SUSPEND' | 'REACTIVATE' | 'ROLE_GRANT' | 'ROLE_REVOKE';

export interface LockedUser {
  id: string;
  status: AccountStatus;
  isSeededAdmin: boolean;
  roles: Role[];
}

const ROLES = `array(SELECT r.role FROM user_roles r WHERE r.user_id = u.id ORDER BY r.role)`;

/** Escapes LIKE wildcards so a search for `50%` matches the text, not everything. */
const likePrefix = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase() + '%';

/** SQL for administration. Every function takes a {@link Queryable} so a whole action shares one transaction. */
export const adminRepository = {
  /**
   * Locks every ADMIN role row. Taken first by anything that could reduce the
   * number of administrators, so two simultaneous demotions are serialised and
   * cannot both pass the "at least one admin" check.
   */
  async lockAdminIds(q: Queryable): Promise<string[]> {
    const { rows } = await q.query<{ user_id: string }>(
      `SELECT user_id FROM user_roles WHERE role = 'ADMIN' ORDER BY user_id FOR UPDATE`,
    );
    return rows.map((r) => r.user_id);
  },

  async lockUser(q: Queryable, userId: string): Promise<LockedUser | null> {
    const { rows } = await q.query<{
      id: string;
      status: AccountStatus;
      is_seeded_admin: boolean;
      roles: Role[];
    }>(
      `SELECT u.id, u.status, u.is_seeded_admin, ${ROLES} AS roles
       FROM users u WHERE u.id = $1 FOR UPDATE`,
      [userId],
    );
    const r = rows[0];
    return r
      ? { id: r.id, status: r.status, isSeededAdmin: r.is_seeded_admin, roles: r.roles }
      : null;
  },

  async isSeededAdmin(q: Queryable, userId: string): Promise<boolean> {
    const { rows } = await q.query<{ is_seeded_admin: boolean }>(
      `SELECT is_seeded_admin FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.is_seeded_admin === true;
  },

  async setStatus(q: Queryable, userId: string, status: AccountStatus): Promise<void> {
    await q.query(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [
      userId,
      status,
    ]);
  },

  async grantAdmin(q: Queryable, userId: string, grantedBy: string): Promise<void> {
    await q.query(
      `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, 'ADMIN', $2)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId, grantedBy],
    );
  },

  async revokeAdmin(q: Queryable, userId: string): Promise<void> {
    await q.query(`DELETE FROM user_roles WHERE user_id = $1 AND role = 'ADMIN'`, [userId]);
  },

  async insertAudit(
    q: Queryable,
    a: {
      id: string;
      actorId: string;
      targetUserId: string;
      action: AuditAction;
      reason: string;
      correlationId: string;
    },
  ): Promise<void> {
    await q.query(
      `INSERT INTO audit_records (id, actor_id, target_user_id, action, reason, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [a.id, a.actorId, a.targetUserId, a.action, a.reason, a.correlationId],
    );
  },

  /** Ordinary users are never returned with a hash; this view is the only place an admin reads an account. */
  async findAdminUser(q: Queryable, userId: string) {
    const { rows } = await q.query<AdminUserRow>(`${ADMIN_USER_SELECT} WHERE u.id = $1`, [userId]);
    return rows[0] ?? null;
  },

  async listUsers(
    q: Queryable,
    f: { page: number; pageSize: number; status?: string; role?: string; q?: string },
  ) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.status) add('u.status = ?', f.status);
    if (f.role)
      add('EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ?)', f.role);
    if (f.q) {
      params.push(likePrefix(f.q));
      const n = params.length;
      where.push(
        `(lower(u.email) LIKE $${n} ESCAPE '\\' OR lower(p.display_name) LIKE $${n} ESCAPE '\\')`,
      );
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u LEFT JOIN profiles p ON p.user_id = u.id ${clause}`,
      params,
    );
    const { rows } = await q.query<AdminUserRow>(
      `${ADMIN_USER_SELECT} ${clause} ORDER BY u.created_at, u.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    );
    return { rows, total: total.rows[0]?.n ?? 0 };
  },

  async listAudit(q: Queryable, f: { page: number; pageSize: number; targetUserId?: string }) {
    const params: unknown[] = [];
    let clause = '';
    if (f.targetUserId) {
      params.push(f.targetUserId);
      clause = 'WHERE target_user_id = $1';
    }
    const total = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_records ${clause}`,
      params,
    );
    const { rows } = await q.query<AuditRow>(
      `SELECT id, actor_id, target_user_id, action, reason, occurred_at, correlation_id
       FROM audit_records ${clause}
       ORDER BY occurred_at DESC, id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    );
    return { rows, total: total.rows[0]?.n ?? 0 };
  },

  /** Boot-time bootstrap. Returns false if the address already has an account (never escalated). */
  async insertSeededAdmin(
    q: Queryable,
    u: { id: string; email: string; passwordHash: string; displayName: string },
  ): Promise<boolean> {
    const { rows } = await q.query(
      `INSERT INTO users (id, email, password_hash, status, is_seeded_admin, activated_at)
       VALUES ($1, $2, $3, 'ACTIVE', true, now())
       ON CONFLICT ((lower(email))) DO NOTHING
       RETURNING id`,
      [u.id, u.email, u.passwordHash],
    );
    if (rows.length === 0) return false;
    await q.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'STUDENT'), ($1, 'ADMIN')`, [
      u.id,
    ]);
    await q.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [
      u.id,
      u.displayName,
    ]);
    return true;
  },
};

export interface AdminUserRow extends Record<string, unknown> {
  id: string;
  email: string;
  status: AccountStatus;
  is_seeded_admin: boolean;
  created_at: Date;
  activated_at: Date | null;
  display_name: string;
  faculty: string | null;
  avatar_ref: string | null;
  contact_preference: string;
  preferred_mode: string;
  roles: Role[];
}

export interface AuditRow extends Record<string, unknown> {
  id: string;
  actor_id: string;
  target_user_id: string;
  action: AuditAction;
  reason: string;
  occurred_at: Date;
  correlation_id: string;
}

const ADMIN_USER_SELECT = `
  SELECT u.id, u.email, u.status, u.is_seeded_admin, u.created_at, u.activated_at,
         coalesce(p.display_name, '') AS display_name, p.faculty, p.avatar_ref,
         coalesce(p.contact_preference, 'IN_APP') AS contact_preference,
         coalesce(p.preferred_mode, 'REQUESTER') AS preferred_mode,
         ${ROLES} AS roles
  FROM users u LEFT JOIN profiles p ON p.user_id = u.id`;
