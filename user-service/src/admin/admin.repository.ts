import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { execute, type Database } from '../db/db.js';
import {
  adminAlerts,
  adminReads,
  auditRecords,
  profiles,
  roleChangeRequests,
  userRoles,
  users,
} from '../db/schema.js';
import { rolesOf, type AccountStatus, type Role } from '../users/users.repository.js';

export type AuditAction =
  | 'SUSPEND'
  | 'REACTIVATE'
  | 'ROLE_GRANT'
  | 'ROLE_REVOKE'
  | 'ADMIN_BOOTSTRAP'
  | 'ROLE_CHANGE_REQUESTED'
  | 'ROLE_CHANGE_REJECTED';

/** A role-change request's lifecycle (ADR 0008). `EXPIRED` is set lazily, when a stale request is next touched. */
export type RoleRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export type AdminAlertKind =
  | 'ROLE_CHANGE'
  | 'ADMIN_SUSPENDED'
  | 'BULK_SUSPENSIONS'
  | 'SUSPENSION_LIMIT_REACHED'
  | 'BULK_READS';

/** `SYSTEM` is the boot-time bootstrap; every other row has a human actor. */
export type AuditActorType = 'USER' | 'SYSTEM';

export interface LockedUser {
  id: string;
  status: AccountStatus;
  isSeededAdmin: boolean;
  roles: Role[];
}

/** Escapes LIKE wildcards so a search for `50%` matches the text, not everything. */
const likePrefix = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase() + '%';

/**
 * The projection every admin read of a user shares — never a password hash.
 * `coalesce`s cover the LEFT JOIN missing a profile row.
 */
const adminUserColumns = {
  id: users.id,
  email: users.email,
  status: users.status,
  isSeededAdmin: users.isSeededAdmin,
  createdAt: users.createdAt,
  activatedAt: users.activatedAt,
  displayName: sql<string>`coalesce(${profiles.displayName}, '')`,
  faculty: profiles.faculty,
  avatarRef: profiles.avatarRef,
  contactPreference: sql<string>`coalesce(${profiles.contactPreference}, 'IN_APP')`,
  preferredMode: sql<string>`coalesce(${profiles.preferredMode}, 'REQUESTER')`,
  roles: rolesOf,
};

/** A pending request whose deadline passed counts as EXPIRED, whether or not that was written yet. */
const effectiveStatus = sql<RoleRequestStatus>`CASE WHEN ${roleChangeRequests.status} = 'PENDING' AND ${roleChangeRequests.expiresAt} <= now() THEN 'EXPIRED' ELSE ${roleChangeRequests.status} END`;

const roleRequestColumns = {
  id: roleChangeRequests.id,
  targetUserId: roleChangeRequests.targetUserId,
  role: roleChangeRequests.role,
  requestedBy: roleChangeRequests.requestedBy,
  reason: roleChangeRequests.reason,
  status: effectiveStatus,
  createdAt: roleChangeRequests.createdAt,
  expiresAt: roleChangeRequests.expiresAt,
  decidedBy: roleChangeRequests.decidedBy,
  decidedAt: roleChangeRequests.decidedAt,
  decisionReason: roleChangeRequests.decisionReason,
  correlationId: roleChangeRequests.correlationId,
};

/** SQL for administration. Every function takes a {@link Database} so a whole action shares one transaction. */
export const adminRepository = {
  /**
   * Locks every ADMIN role row. Taken first by anything that could reduce the
   * number of administrators, so two simultaneous demotions are serialised and
   * cannot both pass the "at least one admin" check.
   */
  async lockAdminIds(db: Database): Promise<string[]> {
    const rows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.role, 'ADMIN'))
      .orderBy(userRoles.userId)
      .for('update');
    return rows.map((r) => r.userId);
  },

  async lockUser(db: Database, userId: string): Promise<LockedUser | null> {
    const rows = await db
      .select({
        id: users.id,
        status: users.status,
        isSeededAdmin: users.isSeededAdmin,
        roles: rolesOf,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return rows[0] ?? null;
  },

  async isSeededAdmin(db: Database, userId: string): Promise<boolean> {
    const rows = await db
      .select({ isSeededAdmin: users.isSeededAdmin })
      .from(users)
      .where(eq(users.id, userId));
    return rows[0]?.isSeededAdmin === true;
  },

  async setStatus(db: Database, userId: string, status: AccountStatus): Promise<void> {
    await db
      .update(users)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
  },

  async grantAdmin(db: Database, userId: string, grantedBy: string): Promise<void> {
    await db
      .insert(userRoles)
      .values({ userId, role: 'ADMIN', grantedBy })
      .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] });
  },

  async revokeAdmin(db: Database, userId: string): Promise<void> {
    await db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.role, 'ADMIN')));
  },

  /** `actorId: null` records the SYSTEM as the actor (the bootstrap); the table enforces that pairing. */
  async insertAudit(
    db: Database,
    a: {
      id: string;
      actorId: string | null;
      targetUserId: string;
      action: AuditAction;
      reason: string;
      correlationId: string;
    },
  ): Promise<void> {
    await db.insert(auditRecords).values({
      id: a.id,
      actorId: a.actorId,
      actorType: a.actorId === null ? 'SYSTEM' : 'USER',
      targetUserId: a.targetUserId,
      action: a.action,
      reason: a.reason,
      correlationId: a.correlationId,
    });
  },

  /** Ordinary users are never returned with a hash; this view is the only place an admin reads an account. */
  async findAdminUser(db: Database, userId: string): Promise<AdminUserRow | null> {
    const rows = await db
      .select(adminUserColumns)
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    return rows[0] ?? null;
  },

  async listUsers(
    db: Database,
    f: { page: number; pageSize: number; status?: string; role?: string; q?: string },
  ): Promise<{ rows: AdminUserRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (f.status) conditions.push(eq(users.status, f.status as AccountStatus));
    if (f.role) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = ${users.id} AND r.role = ${f.role})`,
      );
    }
    if (f.q) {
      const like = likePrefix(f.q);
      conditions.push(
        sql`(lower(${users.email}) LIKE ${like} ESCAPE '\\' OR lower(${profiles.displayName}) LIKE ${like} ESCAPE '\\')`,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(where);
    const rows = await db
      .select(adminUserColumns)
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(where)
      .orderBy(users.createdAt, users.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  async listAudit(
    db: Database,
    f: {
      page: number;
      pageSize: number;
      targetUserId?: string;
      actorId?: string;
      action?: AuditAction;
      from?: string;
      to?: string;
    },
  ): Promise<{ rows: AuditRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (f.targetUserId) conditions.push(eq(auditRecords.targetUserId, f.targetUserId));
    if (f.actorId) conditions.push(eq(auditRecords.actorId, f.actorId));
    if (f.action) conditions.push(eq(auditRecords.action, f.action));
    if (f.from) conditions.push(gte(auditRecords.occurredAt, new Date(f.from)));
    if (f.to) conditions.push(lte(auditRecords.occurredAt, new Date(f.to)));
    const where = conditions.length ? and(...conditions) : undefined;

    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditRecords)
      .where(where);
    const rows = await db
      .select({
        id: auditRecords.id,
        actorId: auditRecords.actorId,
        actorType: auditRecords.actorType,
        targetUserId: auditRecords.targetUserId,
        action: auditRecords.action,
        reason: auditRecords.reason,
        occurredAt: auditRecords.occurredAt,
        correlationId: auditRecords.correlationId,
      })
      .from(auditRecords)
      .where(where)
      .orderBy(sql`${auditRecords.occurredAt} DESC`, auditRecords.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  /** Admins who could act now: holding ADMIN and ACTIVE. A suspended admin approves nothing. */
  async activeAdminIds(db: Database): Promise<string[]> {
    const rows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.role, 'ADMIN'), eq(users.status, 'ACTIVE')));
    return rows.map((r) => r.userId);
  },

  /** How many `action` audit rows this actor wrote in the last `seconds`. */
  async countActorActions(
    db: Database,
    actorId: string,
    action: AuditAction,
    seconds: number,
  ): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditRecords)
      .where(
        and(
          eq(auditRecords.actorId, actorId),
          eq(auditRecords.action, action),
          sql`${auditRecords.occurredAt} > now() - make_interval(secs => ${seconds})`,
        ),
      );
    return rows[0]?.n ?? 0;
  },

  // ---- role-change requests (ADR 0008: two-person rule) ----------------------------------------

  /** Marks pending requests past their deadline as EXPIRED, so a new request for the target can start. */
  async expireStaleRequests(db: Database, targetUserId: string): Promise<void> {
    await db
      .update(roleChangeRequests)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(roleChangeRequests.targetUserId, targetUserId),
          eq(roleChangeRequests.status, 'PENDING'),
          sql`${roleChangeRequests.expiresAt} <= now()`,
        ),
      );
  },

  async findPendingRequest(db: Database, targetUserId: string): Promise<RoleRequestRow | null> {
    const rows = await db
      .select(roleRequestColumns)
      .from(roleChangeRequests)
      .where(
        and(
          eq(roleChangeRequests.targetUserId, targetUserId),
          eq(roleChangeRequests.status, 'PENDING'),
        ),
      );
    return rows[0] ?? null;
  },

  async insertRoleRequest(
    db: Database,
    r: {
      id: string;
      targetUserId: string;
      role: Role;
      requestedBy: string;
      reason: string;
      ttlHours: number;
      correlationId: string;
    },
  ): Promise<RoleRequestRow> {
    const rows = await db
      .insert(roleChangeRequests)
      .values({
        id: r.id,
        targetUserId: r.targetUserId,
        role: r.role,
        requestedBy: r.requestedBy,
        reason: r.reason,
        expiresAt: sql`now() + make_interval(hours => ${r.ttlHours})`,
        correlationId: r.correlationId,
      })
      .returning(roleRequestColumns);
    return rows[0]!;
  },

  /** Locks one request for a decision, so two admins deciding at once queue up. */
  async lockRoleRequest(db: Database, id: string): Promise<RoleRequestRow | null> {
    const rows = await db
      .select(roleRequestColumns)
      .from(roleChangeRequests)
      .where(eq(roleChangeRequests.id, id))
      .for('update');
    return rows[0] ?? null;
  },

  async decideRoleRequest(
    db: Database,
    id: string,
    d: { status: 'APPROVED' | 'REJECTED'; decidedBy: string; decisionReason: string },
  ): Promise<RoleRequestRow> {
    const rows = await db
      .update(roleChangeRequests)
      .set({
        status: d.status,
        decidedBy: d.decidedBy,
        decidedAt: sql`now()`,
        decisionReason: d.decisionReason,
      })
      .where(eq(roleChangeRequests.id, id))
      .returning(roleRequestColumns);
    return rows[0]!;
  },

  /** Newest first. A pending request past its deadline reads as EXPIRED without a write. */
  async listRoleRequests(
    db: Database,
    f: { page: number; pageSize: number; status?: RoleRequestStatus },
  ): Promise<{ rows: RoleRequestRow[]; total: number }> {
    const where = f.status ? sql`${effectiveStatus} = ${f.status}` : undefined;
    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(roleChangeRequests)
      .where(where);
    const rows = await db
      .select(roleRequestColumns)
      .from(roleChangeRequests)
      .where(where)
      .orderBy(sql`${roleChangeRequests.createdAt} DESC`, roleChangeRequests.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  // ---- watching the admins (ADR 0008, ADM-04) --------------------------------------------------

  async insertAdminRead(
    db: Database,
    r: { id: string; actorId: string; targetUserId: string; correlationId: string },
  ): Promise<void> {
    await db.insert(adminReads).values(r);
  },

  async countReads(db: Database, actorId: string, seconds: number): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminReads)
      .where(
        and(
          eq(adminReads.actorId, actorId),
          sql`${adminReads.occurredAt} > now() - make_interval(secs => ${seconds})`,
        ),
      );
    return rows[0]?.n ?? 0;
  },

  async listReads(
    db: Database,
    f: { page: number; pageSize: number; actorId?: string; targetUserId?: string },
  ): Promise<{ rows: AdminReadRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (f.actorId) conditions.push(eq(adminReads.actorId, f.actorId));
    if (f.targetUserId) conditions.push(eq(adminReads.targetUserId, f.targetUserId));
    const where = conditions.length ? and(...conditions) : undefined;
    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminReads)
      .where(where);
    const rows = await db
      .select({
        id: adminReads.id,
        actorId: adminReads.actorId,
        targetUserId: adminReads.targetUserId,
        occurredAt: adminReads.occurredAt,
        correlationId: adminReads.correlationId,
      })
      .from(adminReads)
      .where(where)
      .orderBy(sql`${adminReads.occurredAt} DESC`, adminReads.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  async insertAlert(
    db: Database,
    a: { id: string; kind: AdminAlertKind; actorId: string; details: Record<string, unknown> },
  ): Promise<void> {
    await db.insert(adminAlerts).values(a);
  },

  /** Whether this kind of alert was already raised for this admin in the last `seconds`. */
  async hasRecentAlert(
    db: Database,
    kind: AdminAlertKind,
    actorId: string,
    seconds: number,
  ): Promise<boolean> {
    const rows = await db
      .select({ id: adminAlerts.id })
      .from(adminAlerts)
      .where(
        and(
          eq(adminAlerts.kind, kind),
          eq(adminAlerts.actorId, actorId),
          sql`${adminAlerts.occurredAt} > now() - make_interval(secs => ${seconds})`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  async listAlerts(
    db: Database,
    f: { page: number; pageSize: number; kind?: AdminAlertKind },
  ): Promise<{ rows: AdminAlertRow[]; total: number }> {
    const where = f.kind ? eq(adminAlerts.kind, f.kind) : undefined;
    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminAlerts)
      .where(where);
    const rows = await db
      .select({
        id: adminAlerts.id,
        kind: adminAlerts.kind,
        actorId: adminAlerts.actorId,
        details: adminAlerts.details,
        occurredAt: adminAlerts.occurredAt,
      })
      .from(adminAlerts)
      .where(where)
      .orderBy(sql`${adminAlerts.occurredAt} DESC`, adminAlerts.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  /**
   * Boot-time bootstrap. Returns false if the address already has an account (never escalated).
   * The account must change its password before its first session: the bootstrap secret is shared
   * configuration and must not become anyone's permanent credential.
   */
  async insertSeededAdmin(
    db: Database,
    u: { id: string; email: string; passwordHash: string; displayName: string },
  ): Promise<boolean> {
    // An address that already has an account is skipped, never escalated (see insertUser).
    const inserted = await execute(
      db,
      sql`INSERT INTO ${users}
            (id, email, password_hash, status, is_seeded_admin, must_change_password, activated_at)
          VALUES (${u.id}, ${u.email}, ${u.passwordHash}, 'ACTIVE', true, true, now())
          ON CONFLICT ((lower(email))) DO NOTHING
          RETURNING id`,
    );
    if (inserted.length === 0) return false;
    await db.insert(userRoles).values([
      { userId: u.id, role: 'STUDENT' },
      { userId: u.id, role: 'ADMIN' },
    ]);
    await db.insert(profiles).values({ userId: u.id, displayName: u.displayName });
    return true;
  },
};

export interface AdminUserRow {
  id: string;
  email: string;
  status: AccountStatus;
  isSeededAdmin: boolean;
  createdAt: Date;
  activatedAt: Date | null;
  displayName: string;
  faculty: string | null;
  avatarRef: string | null;
  contactPreference: string;
  preferredMode: string;
  roles: Role[];
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorType: AuditActorType;
  targetUserId: string;
  action: AuditAction;
  reason: string;
  occurredAt: Date;
  correlationId: string;
}

export interface RoleRequestRow {
  id: string;
  targetUserId: string;
  role: Role;
  requestedBy: string;
  reason: string;
  status: RoleRequestStatus;
  createdAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  correlationId: string;
}

export interface AdminReadRow {
  id: string;
  actorId: string;
  targetUserId: string;
  occurredAt: Date;
  correlationId: string;
}

export interface AdminAlertRow {
  id: string;
  kind: AdminAlertKind;
  actorId: string;
  details: unknown;
  occurredAt: Date;
}
