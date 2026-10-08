import { Inject, Injectable, Logger } from '@nestjs/common';
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
  type AdminAlertKind,
  type AdminAlertRow,
  type AdminReadRow,
  type AdminUserRow,
  type AuditAction,
  type AuditRow,
  type LockedUser,
  type RoleRequestRow,
  type RoleRequestStatus,
} from './admin.repository.js';

/** The controls on administrators (ADR 0008), from configuration. */
export interface AdminSettings {
  /** How long a role-change request may wait for its second admin. */
  roleRequestTtlHours: number;
  /** How recently the password must have been re-entered for the riskiest actions. */
  stepUpWindowSeconds: number;
  /** Suspensions by one admin in an hour that raise BULK_SUSPENSIONS. */
  suspensionsAlertPerHour: number;
  /** Suspensions by one admin in an hour beyond which the next is refused. */
  suspensionsLimitPerHour: number;
  /** Account reads by one admin in an hour that raise BULK_READS. */
  readsAlertPerHour: number;
}
export const ADMIN_SETTINGS = Symbol('ADMIN_SETTINGS');

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

export interface RoleRequestView {
  id: string;
  targetUserId: string;
  role: Role;
  requestedBy: string;
  reason: string;
  status: RoleRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

const toRoleRequestView = (r: RoleRequestRow): RoleRequestView => ({
  id: r.id,
  targetUserId: r.targetUserId,
  role: r.role,
  requestedBy: r.requestedBy,
  reason: r.reason,
  status: r.status,
  createdAt: new Date(r.createdAt).toISOString(),
  expiresAt: new Date(r.expiresAt).toISOString(),
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
  decisionReason: r.decisionReason,
});

const toReadView = (r: AdminReadRow) => ({
  id: r.id,
  actorId: r.actorId,
  targetUserId: r.targetUserId,
  occurredAt: new Date(r.occurredAt).toISOString(),
  correlationId: r.correlationId,
});

const toAlertView = (r: AdminAlertRow) => ({
  id: r.id,
  kind: r.kind,
  actorId: r.actorId,
  details: r.details,
  occurredAt: new Date(r.occurredAt).toISOString(),
});

/** A role change either applied at once (no second admin could approve) or is waiting for one. */
export type RoleChangeResult =
  { applied: true; user: AdminUserView } | { applied: false; request: RoleRequestView };

const HOUR_SECONDS = 3600;

const notFound = () => new ApiException(404, 'NOT_FOUND', 'User not found.');
const requestNotFound = () => new ApiException(404, 'NOT_FOUND', 'Role request not found.');

/**
 * The id as stored, never as typed in the URL. A UUID is case-insensitive, so `/admin/users/ABC…`
 * finds the same row, but tokens (`sub`) and every event carry the stored lower-case form: an event
 * naming the user in another case would miss every cache keyed on it, and a self-check comparing
 * against the raw path parameter could be sidestepped by changing its case.
 */
const canonicalId = (target: { id: string }): string => target.id.toLowerCase();

/**
 * Administration: suspend, reactivate and role changes (US-FR3.1.2–3.1.3.1), under the controls of
 * ADR 0008: two people for every role change, password re-entry for the riskiest actions, a limit
 * and alerts on bulk suspensions, and a record of every account an admin reads.
 *
 * Every action runs in one transaction that also writes its audit row and its event, so a change
 * can never commit without its record.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADMIN_SETTINGS) private readonly settings: AdminSettings,
  ) {}

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

  /**
   * An admin reading one account: recorded, unless it is their own (ADR 0008). Many reads in an
   * hour raise BULK_READS.
   */
  async readUser(actorId: string, userId: string, correlationId: string): Promise<AdminUserView> {
    const view = await this.getUser(userId);
    if (view.id.toLowerCase() === actorId) return view;
    await admin.insertAdminRead(this.db, {
      id: randomUUID(),
      actorId,
      targetUserId: view.id.toLowerCase(),
      correlationId,
    });
    const reads = await admin.countReads(this.db, actorId, HOUR_SECONDS);
    if (reads >= this.settings.readsAlertPerHour) {
      await this.raiseOncePerHour('BULK_READS', actorId, {
        readsInLastHour: reads,
        threshold: this.settings.readsAlertPerHour,
      });
    }
    return view;
  }

  async listAudit(f: {
    page: number;
    pageSize: number;
    targetUserId?: string;
    actorId?: string;
    action?: AuditAction;
    from?: string;
    to?: string;
  }) {
    const { rows, total } = await admin.listAudit(this.db, f);
    return { page: f.page, pageSize: f.pageSize, total, items: rows.map(toAuditView) };
  }

  async listReads(f: { page: number; pageSize: number; actorId?: string; targetUserId?: string }) {
    const { rows, total } = await admin.listReads(this.db, f);
    return { page: f.page, pageSize: f.pageSize, total, items: rows.map(toReadView) };
  }

  async listAlerts(f: { page: number; pageSize: number; kind?: AdminAlertKind }) {
    const { rows, total } = await admin.listAlerts(this.db, f);
    return { page: f.page, pageSize: f.pageSize, total, items: rows.map(toAlertView) };
  }

  async listRoleRequests(f: { page: number; pageSize: number; status?: RoleRequestStatus }) {
    const { rows, total } = await admin.listRoleRequests(this.db, f);
    return { page: f.page, pageSize: f.pageSize, total, items: rows.map(toRoleRequestView) };
  }

  /**
   * Suspends an ACTIVE account. Its refresh sessions are revoked in the same
   * transaction, so it cannot mint a new access token, and the audit row's id
   * travels in the event as the reason reference.
   *
   * Suspending an admin also needs the password re-entered recently. One admin may suspend at most
   * `suspensionsLimitPerHour` accounts an hour: the actor's row is locked first, so two suspensions
   * by the same admin count one after the other, and a refused one changes nothing.
   */
  async suspend(
    actorId: string,
    sessionId: string,
    targetId: string,
    reason: string,
    correlationId: string,
  ) {
    const outcome = await this.db.transaction(async (tx) => {
      await admin.lockUser(tx, actorId);
      const target = await admin.lockUser(tx, targetId);
      if (!target) throw notFound();
      const userId = canonicalId(target);
      if (actorId === userId) {
        throw new ApiException(409, 'SELF_SUSPENSION_FORBIDDEN', 'You cannot suspend yourself.');
      }
      if (target.roles.includes('ADMIN')) {
        if (!(await admin.isSeededAdmin(tx, actorId))) {
          throw new ApiException(
            403,
            'ADMIN_ACTION_NOT_PERMITTED',
            'Only a seeded administrator can suspend an administrator.',
          );
        }
        await this.requireStepUp(tx, sessionId);
      }
      if (target.status === 'SUSPENDED') return { done: true as const }; // idempotent
      if (target.status !== 'ACTIVE') {
        throw new ApiException(
          409,
          'ACCOUNT_NOT_ACTIVE',
          'Only an active account can be suspended.',
        );
      }

      const recent = await admin.countActorActions(tx, actorId, 'SUSPEND', HOUR_SECONDS);
      if (recent >= this.settings.suspensionsLimitPerHour) {
        return { done: false as const, recent }; // refused below, after this changes nothing
      }

      await admin.setStatus(tx, userId, 'SUSPENDED');
      await sessions.revokeAllForUser(tx, userId);
      const auditId = await this.record(tx, actorId, userId, 'SUSPEND', reason, correlationId);
      if (target.roles.includes('ADMIN')) {
        // Rare and high-impact: it is also how a seeded admin clears approvers out of the way.
        await this.raise(tx, 'ADMIN_SUSPENDED', actorId, {
          targetUserId: userId,
          reasonRef: auditId,
        });
      }
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
      return { done: true as const, suspendedInLastHour: recent + 1 };
    });

    if (!outcome.done) {
      await this.raiseOncePerHour('SUSPENSION_LIMIT_REACHED', actorId, {
        suspensionsInLastHour: outcome.recent,
        limit: this.settings.suspensionsLimitPerHour,
      });
      throw new ApiException(
        429,
        'RATE_LIMITED',
        'You have reached the limit on suspensions for this hour. Ask another administrator.',
      );
    }
    if (
      'suspendedInLastHour' in outcome &&
      outcome.suspendedInLastHour !== undefined &&
      outcome.suspendedInLastHour >= this.settings.suspensionsAlertPerHour
    ) {
      await this.raiseOncePerHour('BULK_SUSPENSIONS', actorId, {
        suspensionsInLastHour: outcome.suspendedInLastHour,
        threshold: this.settings.suspensionsAlertPerHour,
      });
    }
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
   * Asks to appoint (`ADMIN`) or downgrade (`STUDENT`) an administrator (ADR 0008).
   *
   * The rules of US-FR3.1.3 are checked first, then the password re-entry, so nobody is asked for a
   * password they could not use. The change itself waits for an eligible approver — an active admin
   * who is neither the requester nor the target. If there is none, the requester acts alone and the
   * change applies now.
   *
   * Lock order matters: the admin role rows are locked first, so two simultaneous demotions queue
   * up, and the actor's own authority is checked again *after* the lock.
   */
  async requestRoleChange(
    actorId: string,
    sessionId: string,
    targetId: string,
    role: Role,
    reason: string,
    correlationId: string,
  ): Promise<RoleChangeResult> {
    const result = await this.db.transaction(async (tx): Promise<RoleChangeResult | 'noop'> => {
      const adminIds = await admin.lockAdminIds(tx);
      if (!adminIds.includes(actorId)) {
        throw new ApiException(403, 'FORBIDDEN', 'Administrator role required.');
      }
      const target = await admin.lockUser(tx, targetId);
      if (!target) throw notFound();
      const userId = canonicalId(target);

      if (!(await this.roleRulesAllow(tx, actorId, target, role, adminIds))) return 'noop';
      await this.requireStepUp(tx, sessionId);

      // Before the shortcut below: an open request must be decided or withdrawn first, or it could
      // be approved later on top of a change made without it.
      await admin.expireStaleRequests(tx, userId);
      if (await admin.findPendingRequest(tx, userId)) {
        throw new ApiException(
          409,
          'ROLE_REQUEST_PENDING',
          'A role change for this user is already waiting for approval.',
        );
      }

      const eligible = (await admin.activeAdminIds(tx)).filter(
        (id) => id !== actorId && id !== userId,
      );
      if (eligible.length === 0) {
        this.logger.warn({
          actorId,
          targetUserId: userId,
          role,
          correlationId,
          msg: 'role change applied without a second administrator: none is eligible to approve',
        });
        await this.applyRoleChange(tx, {
          approverId: actorId,
          requesterId: actorId,
          target,
          role,
          reason,
          correlationId,
        });
        return { applied: true, user: await this.getUserIn(tx, userId) };
      }

      const request = await admin.insertRoleRequest(tx, {
        id: randomUUID(),
        targetUserId: userId,
        role,
        requestedBy: actorId,
        reason,
        ttlHours: this.settings.roleRequestTtlHours,
        correlationId,
      });
      await this.record(tx, actorId, userId, 'ROLE_CHANGE_REQUESTED', reason, correlationId);
      return { applied: false, request: toRoleRequestView(request) };
    });
    return result === 'noop' ? { applied: true, user: await this.getUser(targetId) } : result;
  }

  /**
   * The second admin approves (ADR 0008). Every rule is checked again, now: the requester must
   * still hold their authority and the target must still be eligible. Only this changes the role.
   */
  async approveRoleRequest(
    actorId: string,
    sessionId: string,
    requestId: string,
    reason: string,
    correlationId: string,
  ): Promise<AdminUserView> {
    const targetUserId = await this.db.transaction(async (tx) => {
      const adminIds = await admin.lockAdminIds(tx);
      const request = await this.openRequest(tx, requestId);
      this.assertCanDecide(actorId, request);
      if (!adminIds.includes(actorId)) {
        throw new ApiException(403, 'FORBIDDEN', 'Administrator role required.');
      }
      // Active, not merely holding the role: a suspended requester has lost their authority too.
      if (!(await admin.activeAdminIds(tx)).includes(request.requestedBy)) {
        throw new ApiException(
          409,
          'ROLE_REQUEST_STALE',
          'The administrator who asked for this change is no longer an active administrator.',
        );
      }
      const target = await admin.lockUser(tx, request.targetUserId);
      if (!target) throw notFound();
      const changes = await this.roleRulesAllow(
        tx,
        request.requestedBy,
        target,
        request.role,
        adminIds,
      );
      await this.requireStepUp(tx, sessionId);

      await admin.decideRoleRequest(tx, request.id, {
        status: 'APPROVED',
        decidedBy: actorId,
        decisionReason: reason,
      });
      if (changes) {
        await this.applyRoleChange(tx, {
          approverId: actorId,
          requesterId: request.requestedBy,
          target,
          role: request.role,
          reason,
          correlationId,
        });
      }
      return canonicalId(target);
    });
    return this.getUser(targetUserId);
  }

  /** The second admin refuses, or the requester withdraws. Changes no role. */
  async rejectRoleRequest(
    actorId: string,
    requestId: string,
    reason: string,
    correlationId: string,
  ): Promise<RoleRequestView> {
    return this.db.transaction(async (tx) => {
      const request = await this.openRequest(tx, requestId);
      if (actorId === request.targetUserId) {
        throw new ApiException(
          409,
          'CONFLICT_OF_INTEREST',
          'You cannot decide a role change about yourself.',
        );
      }
      const decided = await admin.decideRoleRequest(tx, request.id, {
        status: 'REJECTED',
        decidedBy: actorId,
        decisionReason: reason,
      });
      await this.record(
        tx,
        actorId,
        request.targetUserId,
        'ROLE_CHANGE_REJECTED',
        reason,
        correlationId,
      );
      return toRoleRequestView(decided);
    });
  }

  /**
   * The US-FR3.1.3 rules for `actorId` changing `target` to `role`. Throws when the change is not
   * allowed, returns false when it would change nothing (idempotent), true when it would apply.
   */
  private async roleRulesAllow(
    tx: Database,
    actorId: string,
    target: LockedUser,
    role: Role,
    adminIds: string[],
  ): Promise<boolean> {
    const userId = canonicalId(target);
    if (role === 'ADMIN') {
      if (target.roles.includes('ADMIN')) return false;
      if (target.status !== 'ACTIVE') {
        throw new ApiException(
          409,
          'ACCOUNT_NOT_ACTIVE',
          'Only an active account can be made an administrator.',
        );
      }
      return true;
    }

    // role === 'STUDENT': downgrade
    if (!target.roles.includes('ADMIN')) return false;
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
    return true;
  }

  /** Grants or revokes, audits it with the approver as actor, announces it, and raises ROLE_CHANGE. */
  private async applyRoleChange(
    tx: Database,
    c: {
      approverId: string;
      requesterId: string;
      target: LockedUser;
      role: Role;
      reason: string;
      correlationId: string;
    },
  ): Promise<void> {
    const userId = canonicalId(c.target);
    let roles: Role[];
    let action: 'ROLE_GRANT' | 'ROLE_REVOKE';
    if (c.role === 'ADMIN') {
      await admin.grantAdmin(tx, userId, c.requesterId);
      roles = [...c.target.roles, 'ADMIN'];
      action = 'ROLE_GRANT';
    } else {
      await admin.revokeAdmin(tx, userId);
      roles = c.target.roles.filter((r) => r !== 'ADMIN');
      action = 'ROLE_REVOKE';
    }
    const auditId = await this.record(tx, c.approverId, userId, action, c.reason, c.correlationId);
    await this.roleChanged(tx, userId, roles, auditId, c.correlationId);
    await this.raise(tx, 'ROLE_CHANGE', c.approverId, {
      targetUserId: userId,
      role: c.role,
      requestedBy: c.requesterId,
      approvedBy: c.approverId,
      reasonRef: auditId,
    });
  }

  /**
   * Loads a request to decide, refusing one already decided or past its deadline. An expired request
   * is not rewritten here — the refusal rolls the transaction back — it reads as EXPIRED anyway, and
   * the next request for the same user clears it.
   */
  private async openRequest(tx: Database, requestId: string): Promise<RoleRequestRow> {
    const request = await admin.lockRoleRequest(tx, requestId);
    if (!request) throw requestNotFound();
    if (request.status === 'EXPIRED') {
      throw new ApiException(
        409,
        'ROLE_REQUEST_EXPIRED',
        'This request waited too long for approval. Ask again.',
      );
    }
    if (request.status !== 'PENDING') {
      throw new ApiException(
        409,
        'ROLE_REQUEST_NOT_PENDING',
        'This request has already been decided.',
      );
    }
    return request;
  }

  /** The two people in a two-person rule must be different, and the target decides nothing. */
  private assertCanDecide(actorId: string, request: RoleRequestRow): void {
    if (actorId === request.requestedBy) {
      throw new ApiException(
        409,
        'SELF_APPROVAL_FORBIDDEN',
        'Another administrator must approve your request.',
      );
    }
    if (actorId === request.targetUserId) {
      throw new ApiException(
        409,
        'CONFLICT_OF_INTEREST',
        'You cannot decide a role change about yourself.',
      );
    }
  }

  /** Throws `401 STEP_UP_REQUIRED` unless the password was re-entered on this session recently. */
  private async requireStepUp(tx: Database, sessionId: string): Promise<void> {
    if (!(await sessions.steppedUpWithin(tx, sessionId, this.settings.stepUpWindowSeconds))) {
      throw new ApiException(
        401,
        'STEP_UP_REQUIRED',
        'Re-enter your password to confirm this action.',
      );
    }
  }

  private async getUserIn(tx: Database, userId: string): Promise<AdminUserView> {
    const row = await admin.findAdminUser(tx, userId);
    if (!row) throw notFound();
    return toAdminUserView(row);
  }

  /** Records an alert and logs it. The details name accounts by id only, never by email. */
  private async raise(
    db: Database,
    kind: AdminAlertKind,
    actorId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await admin.insertAlert(db, { id: randomUUID(), kind, actorId, details });
    this.logger.warn({ alert: kind, actorId, ...details, msg: 'admin activity alert' });
  }

  /** A bulk alert is raised at most once per admin per hour; the counts keep rising regardless. */
  private async raiseOncePerHour(
    kind: AdminAlertKind,
    actorId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (await admin.hasRecentAlert(this.db, kind, actorId, HOUR_SECONDS)) return;
    await this.raise(this.db, kind, actorId, details);
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
