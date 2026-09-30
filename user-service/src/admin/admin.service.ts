import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException, EVENTS } from '@foc/platform';
import { sessionsRepository as sessions } from '../auth/sessions.repository.js';
import { DB, type Database } from '../db/db.js';
import {
  usersRepository as users,
  type AccountStatus,
  type Role,
} from '../users/users.repository.js';
import {
  adminRepository as admin,
  type AdminUserRow,
  type AuditAction,
  type AuditRow,
} from './admin.repository.js';

export interface AdminUserView {
  id: string;
  email: string;
  roles: Role[];
  status: AccountStatus;
  isSeededAdmin: boolean;
  profile: {
    displayName: string;
    faculty: string | null;
    avatarRef: string | null;
    contactPreference: string;
    preferredMode: string;
  };
  createdAt: string;
  activatedAt: string | null;
}

export const toAdminUserView = (r: AdminUserRow): AdminUserView => ({
  id: r.id,
  email: r.email,
  roles: r.roles,
  status: r.status,
  isSeededAdmin: r.isSeededAdmin,
  profile: {
    displayName: r.displayName,
    faculty: r.faculty,
    avatarRef: r.avatarRef,
    contactPreference: r.contactPreference,
    preferredMode: r.preferredMode,
  },
  createdAt: new Date(r.createdAt).toISOString(),
  activatedAt: r.activatedAt ? new Date(r.activatedAt).toISOString() : null,
});

const toAuditView = (r: AuditRow) => ({
  id: r.id,
  actorId: r.actorId,
  actorType: r.actorType,
  targetUserId: r.targetUserId,
  action: r.action,
  reason: r.reason,
  occurredAt: new Date(r.occurredAt).toISOString(),
  correlationId: r.correlationId,
});

const notFound = () => new ApiException(404, 'NOT_FOUND', 'User not found.');

/**
 * The id as stored, never as typed in the URL. A UUID is case-insensitive, so `/admin/users/ABC…`
 * finds the same row, but tokens (`sub`) and every event carry the stored lower-case form: an event
 * naming the user in another case would miss every cache keyed on it, and a self-check comparing
 * against the raw path parameter could be sidestepped by changing its case.
 */
const canonicalId = (target: { id: string }): string => target.id.toLowerCase();

/**
 * Administration: suspend, reactivate and role changes (US-FR3.1.2–3.1.3.1).
 * Every action runs in one transaction that also writes its audit row and its
 * event, so a change can never commit without its record.
 */
@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listUsers(f: {
    page: number;
    pageSize: number;
    status?: string;
    role?: string;
    q?: string;
  }) {
    const { rows, total } = await admin.listUsers(this.db, f);
    return { page: f.page, pageSize: f.pageSize, total, items: rows.map(toAdminUserView) };
  }

  async getUser(userId: string): Promise<AdminUserView> {
    const row = await admin.findAdminUser(this.db, userId);
    if (!row) throw notFound();
    return toAdminUserView(row);
  }

  async listAudit(f: { page: number; pageSize: number; targetUserId?: string }) {
    const { rows, total } = await admin.listAudit(this.db, f);
    return { page: f.page, pageSize: f.pageSize, total, items: rows.map(toAuditView) };
  }

  /**
   * Suspends an ACTIVE account. Its refresh sessions are revoked in the same
   * transaction, so it cannot mint a new access token, and the audit row's id
   * travels in the event as the reason reference.
   */
  async suspend(actorId: string, targetId: string, reason: string, correlationId: string) {
    await this.db.transaction(async (tx) => {
      const target = await admin.lockUser(tx, targetId);
      if (!target) throw notFound();
      const userId = canonicalId(target);
      if (actorId === userId) {
        throw new ApiException(409, 'SELF_SUSPENSION_FORBIDDEN', 'You cannot suspend yourself.');
      }
      if (target.roles.includes('ADMIN') && !(await admin.isSeededAdmin(tx, actorId))) {
        throw new ApiException(
          403,
          'ADMIN_ACTION_NOT_PERMITTED',
          'Only a seeded administrator can suspend an administrator.',
        );
      }
      if (target.status === 'SUSPENDED') return; // idempotent: no second audit row or event
      if (target.status !== 'ACTIVE') {
        throw new ApiException(
          409,
          'ACCOUNT_NOT_ACTIVE',
          'Only an active account can be suspended.',
        );
      }

      await admin.setStatus(tx, userId, 'SUSPENDED');
      await sessions.revokeAllForUser(tx, userId);
      const auditId = await this.record(tx, actorId, userId, 'SUSPEND', reason, correlationId);
      await users.insertOutboxEvent(tx, {
        id: randomUUID(),
        eventType: EVENTS.USER_SUSPENDED,
        aggregateId: userId,
        payload: {
          userId,
          status: 'SUSPENDED',
          reasonRef: auditId,
          occurredAt: new Date().toISOString(),
        },
        correlationId,
      });
    });
    return this.getUser(targetId);
  }

  /** Restores a SUSPENDED account. Only an account that was active can be suspended, so this never skips activation. */
  async reactivate(actorId: string, targetId: string, reason: string, correlationId: string) {
    await this.db.transaction(async (tx) => {
      const target = await admin.lockUser(tx, targetId);
      if (!target) throw notFound();
      const userId = canonicalId(target);
      if (target.status === 'ACTIVE') return; // idempotent
      if (target.status !== 'SUSPENDED') {
        throw new ApiException(
          409,
          'ACCOUNT_NOT_ACTIVE',
          'Only a suspended account can be reactivated.',
        );
      }
      await admin.setStatus(tx, userId, 'ACTIVE');
      const auditId = await this.record(tx, actorId, userId, 'REACTIVATE', reason, correlationId);
      await users.insertOutboxEvent(tx, {
        id: randomUUID(),
        eventType: EVENTS.USER_REACTIVATED,
        aggregateId: userId,
        payload: {
          userId,
          status: 'ACTIVE',
          reasonRef: auditId,
          occurredAt: new Date().toISOString(),
        },
        correlationId,
      });
    });
    return this.getUser(targetId);
  }

  /**
   * Appoints (`ADMIN`) or downgrades (`STUDENT`) an administrator.
   *
   * Lock order matters: the admin role rows are locked first, so two
   * simultaneous demotions queue up, and the actor's own authority is checked
   * again *after* the lock — a demotion that landed a moment earlier must not
   * still let its victim demote someone else.
   */
  async setRole(
    actorId: string,
    targetId: string,
    role: Role,
    reason: string,
    correlationId: string,
  ) {
    await this.db.transaction(async (tx) => {
      const adminIds = await admin.lockAdminIds(tx);
      if (!adminIds.includes(actorId)) {
        throw new ApiException(403, 'FORBIDDEN', 'Administrator role required.');
      }
      const target = await admin.lockUser(tx, targetId);
      if (!target) throw notFound();
      const userId = canonicalId(target);

      if (role === 'ADMIN') {
        if (target.roles.includes('ADMIN')) return; // idempotent
        if (target.status !== 'ACTIVE') {
          throw new ApiException(
            409,
            'ACCOUNT_NOT_ACTIVE',
            'Only an active account can be made an administrator.',
          );
        }
        await admin.grantAdmin(tx, userId, actorId);
        const auditId = await this.record(tx, actorId, userId, 'ROLE_GRANT', reason, correlationId);
        const roles: Role[] = [...target.roles, 'ADMIN'];
        await this.roleChanged(tx, userId, roles, auditId, correlationId);
        return;
      }

      // role === 'STUDENT': downgrade
      if (!target.roles.includes('ADMIN')) return; // idempotent
      if (actorId === userId) {
        throw new ApiException(
          409,
          'SELF_DEMOTION_FORBIDDEN',
          'You cannot remove your own administrator role.',
        );
      }
      if (!(await admin.isSeededAdmin(tx, actorId))) {
        throw new ApiException(
          403,
          'ADMIN_DOWNGRADE_NOT_PERMITTED',
          'Only a seeded administrator can downgrade an administrator.',
        );
      }
      // Defence in depth. Unreachable today ONLY because (a) self-demotion is refused above and (b)
      // the actor must be a different, still-current admin. If self-demotion is ever allowed, this
      // check becomes the only thing keeping the last administrator in place — and has no test that
      // reaches it. Add one before relaxing that rule.
      if (adminIds.length <= 1) {
        throw new ApiException(409, 'LAST_ADMIN', 'At least one administrator must remain.');
      }
      await admin.revokeAdmin(tx, userId);
      const auditId = await this.record(tx, actorId, userId, 'ROLE_REVOKE', reason, correlationId);
      const roles = target.roles.filter((r) => r !== 'ADMIN');
      await this.roleChanged(tx, userId, roles, auditId, correlationId);
    });
    return this.getUser(targetId);
  }

  /**
   * Tells other services that cache a caller's roles to drop them now (USR-07), rather than let a
   * demoted administrator keep admin rights there until the cache expires.
   */
  private roleChanged(
    tx: Database,
    userId: string,
    roles: Role[],
    auditId: string,
    correlationId: string,
  ): Promise<void> {
    return users.insertOutboxEvent(tx, {
      id: randomUUID(),
      eventType: EVENTS.USER_ROLE_CHANGED,
      aggregateId: userId,
      payload: {
        userId,
        roles: [...roles].sort(),
        reasonRef: auditId,
        occurredAt: new Date().toISOString(),
      },
      correlationId,
    });
  }

  private async record(
    tx: Database,
    actorId: string,
    targetUserId: string,
    action: Exclude<AuditAction, 'ADMIN_BOOTSTRAP'>,
    reason: string,
    correlationId: string,
  ): Promise<string> {
    const id = randomUUID();
    await admin.insertAudit(tx, { id, actorId, targetUserId, action, reason, correlationId });
    return id;
  }
}
