import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { sessionsRepository } from '../src/auth/sessions.repository.js';
import { createTestApp, openLimiters, type TestApp } from './helpers/app.js';
import {
  activeStudent,
  bearer,
  http,
  login,
  ORIGIN,
  PASSWORD,
  seededAdmin,
  stepUp,
  TRUNCATE_ALL,
  type Actor,
} from './helpers/actors.js';

/**
 * The controls on administrators (ADR 0008): password re-entry and two people for every role change
 * (ADM-03), and the record of reads, the alerts and the suspension limit (ADM-04).
 */

let t: TestApp;
let root: Actor; // seeded admin, password re-entered
let root2: Actor; // second seeded admin, password re-entered
let student: Actor;

const as = (a: Actor, app: TestApp = t) => {
  const send = (method: 'post' | 'put', path: string, body: object) =>
    http(app)[method](path).set('Authorization', bearer(a)).send(body);
  return {
    role: (id: string, role: string, reason = 'test reason') =>
      send('put', `/admin/users/${id}/role`, { role, reason }),
    approve: (requestId: string, reason = 'approved') =>
      send('post', `/admin/role-requests/${requestId}/approve`, { reason }),
    reject: (requestId: string, reason = 'rejected') =>
      send('post', `/admin/role-requests/${requestId}/reject`, { reason }),
    suspend: (id: string, reason = 'test reason') =>
      send('post', `/admin/users/${id}/suspend`, { reason }),
    reactivate: (id: string, reason = 'test reason') =>
      send('post', `/admin/users/${id}/reactivate`, { reason }),
    stepUp: (password: string) => send('post', '/auth/step-up', { password }),
    get: (path: string) => http(app).get(path).set('Authorization', bearer(a)),
  };
};

const code = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;
const isAdmin = async (id: string, app: TestApp = t) =>
  (await app.db.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'ADMIN'", [id])).rows
    .length === 1;
const statusOf = async (id: string, app: TestApp = t) =>
  (await app.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [id])).rows[0]!
    .status;
const alerts = async (app: TestApp = t) =>
  (
    await app.db.query<{ kind: string; actor_id: string; details: Record<string, unknown> }>(
      'SELECT kind, actor_id, details FROM admin_alerts ORDER BY occurred_at',
    )
  ).rows;
/** Human-initiated audit rows, oldest first. */
const audit = async (app: TestApp = t) =>
  (
    await app.db.query<{ action: string; actor_id: string }>(
      "SELECT action, actor_id FROM audit_records WHERE actor_type = 'USER' ORDER BY occurred_at",
    )
  ).rows;
const events = async (type: string, app: TestApp = t) =>
  (await app.db.query('SELECT 1 FROM outbox_events WHERE event_type = $1', [type])).rows.length;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(TRUNCATE_ALL);
  root = await seededAdmin(t, 'root1@u.nus.edu');
  root2 = await seededAdmin(t, 'root2@u.nus.edu');
  student = await activeStudent(t, 'student@u.nus.edu');
});

describe('password re-entry (ADM-03)', () => {
  it('takes only the account’s own password, and refuses a wrong one as login does', async () => {
    const fresh = await login(t, root.email); // a new sign-in has not re-entered it
    const wrong = await as(fresh).stepUp('not-the-password').expect(401);
    expect(code(wrong)).toBe('INVALID_CREDENTIALS');
    expect(code(await as(fresh).role(student.id, 'ADMIN').expect(401))).toBe('STEP_UP_REQUIRED');

    await as(fresh).stepUp(PASSWORD).expect(204);
    await as(fresh).role(student.id, 'ADMIN').expect(202);

    await http(t).post('/auth/step-up').send({ password: PASSWORD }).expect(401); // no token
    await as(fresh).stepUp('').expect(422);
  });

  it('belongs to one sign-in: a token refresh keeps it, another login does not', async () => {
    const laptop = await login(t, root.email);
    const phone = await login(t, root.email);
    await stepUp(t, laptop);
    expect(code(await as(phone).role(student.id, 'ADMIN').expect(401))).toBe('STEP_UP_REQUIRED');

    const refreshed = await http(t)
      .post('/auth/refresh')
      .set('Cookie', laptop.cookie)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(200);
    const renewed = { ...laptop, accessToken: refreshed.body.accessToken as string };
    await as(renewed).role(student.id, 'ADMIN').expect(202);
  });

  it('lapses after the window', async () => {
    await t.db.query("UPDATE refresh_sessions SET stepped_up_at = now() - interval '301 seconds'");
    expect(code(await as(root).role(student.id, 'ADMIN').expect(401))).toBe('STEP_UP_REQUIRED');
    await stepUp(t, root);
    await as(root).role(student.id, 'ADMIN').expect(202);
  });

  it('is asked for only once the permission rules pass, so nobody is prompted for a password they could not use', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    await as(root2).approve(asked.body.request.id).expect(200);
    const appointed = await login(t, student.email); // has not re-entered the password

    const demote = await as(appointed).role(root.id, 'STUDENT').expect(403);
    expect(code(demote)).toBe('ADMIN_DOWNGRADE_NOT_PERMITTED');
    expect(code(await as(appointed).suspend(root.id).expect(403))).toBe(
      'ADMIN_ACTION_NOT_PERMITTED',
    );
    expect(code(await as(appointed).role(appointed.id, 'STUDENT').expect(409))).toBe(
      'SELF_DEMOTION_FORBIDDEN',
    );
    // a request that would change nothing is answered without one, too
    await as(appointed).role(root.id, 'ADMIN').expect(200);
  });

  it('is needed to suspend an administrator, but not a student', async () => {
    const fresh = await login(t, root.email);
    await as(fresh).suspend(student.id).expect(200);
    expect(code(await as(fresh).suspend(root2.id).expect(401))).toBe('STEP_UP_REQUIRED');
    expect(await statusOf(root2.id)).toBe('ACTIVE');
    await stepUp(t, fresh);
    await as(fresh).suspend(root2.id).expect(200);
  });

  it("is needed to approve or reject someone else's request, not to withdraw your own", async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    const approver = await login(t, root2.email); // has not re-entered the password
    expect(code(await as(approver).approve(asked.body.request.id).expect(401))).toBe(
      'STEP_UP_REQUIRED',
    );
    // A stolen token must not be able to quietly reject every pending demotion either.
    expect(code(await as(approver).reject(asked.body.request.id, 'Not now').expect(401))).toBe(
      'STEP_UP_REQUIRED',
    );
    expect(await isAdmin(student.id)).toBe(false);
    // Both refusals left it open, and its requester withdraws it without re-entering anything.
    const requester = await login(t, root.email);
    await as(requester).reject(asked.body.request.id, 'Asked by mistake').expect(200);
  });

  it('counts for nothing on a revoked session', async () => {
    const { rows } = await t.db.query<{ id: string }>(
      'SELECT id FROM refresh_sessions WHERE stepped_up_at IS NOT NULL LIMIT 1',
    );
    const sid = rows[0]!.id;
    expect(await sessionsRepository.steppedUpWithin(t.orm, sid, 300)).toBe(true);
    await t.db.query('UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1', [sid]);
    expect(await sessionsRepository.steppedUpWithin(t.orm, sid, 300)).toBe(false);
  });

  it('is rate-limited per account, like sign-in', async () => {
    const limited = await createTestApp({
      rateLimiters: { ...openLimiters(), stepUpPerUser: new RateLimiter(2, 60_000) },
    });
    try {
      const a = await seededAdmin(limited, 'root@u.nus.edu', { stepUp: false });
      await as(a, limited).stepUp('guess-one-wrong').expect(401);
      await as(a, limited).stepUp('guess-two-wrong').expect(401);
      const blocked = await as(a, limited).stepUp(PASSWORD).expect(429);
      expect(code(blocked)).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});

describe('two people for every role change (ADM-03)', () => {
  it('changes nothing until a second admin approves; then applies once, with both names on record', async () => {
    const asked = await as(root).role(student.id, 'ADMIN', 'New ops lead').expect(202);
    const request = asked.body.request;
    expect(request).toMatchObject({
      targetUserId: student.id,
      role: 'ADMIN',
      requestedBy: root.id,
      reason: 'New ops lead',
      status: 'PENDING',
      decidedBy: null,
    });
    const ttl = Date.parse(request.expiresAt) - Date.parse(request.createdAt);
    expect(Math.abs(ttl - 24 * 3600_000)).toBeLessThan(5_000);
    expect(await isAdmin(student.id)).toBe(false);
    expect(await events('user.role-changed')).toBe(0);
    const pending = await as(root2).get('/admin/role-requests?status=PENDING').expect(200);
    expect(pending.body.items.map((r: { id: string }) => r.id)).toEqual([request.id]);

    const approved = await as(root2).approve(request.id, 'Agreed').expect(200);
    expect(approved.body.roles).toContain('ADMIN');
    const decided = await as(root).get('/admin/role-requests?status=APPROVED').expect(200);
    expect(decided.body.items).toEqual([
      expect.objectContaining({
        id: request.id,
        status: 'APPROVED',
        decidedBy: root2.id,
        decisionReason: 'Agreed',
      }),
    ]);
    expect(await events('user.role-changed')).toBe(1);
    expect((await alerts()).filter((a) => a.kind === 'ROLE_CHANGE')).toEqual([
      expect.objectContaining({
        actor_id: root2.id,
        details: expect.objectContaining({
          targetUserId: student.id,
          role: 'ADMIN',
          requestedBy: root.id,
          approvedBy: root2.id,
        }),
      }),
    ]);

    const again = await as(root2).approve(request.id).expect(409);
    expect(code(again)).toBe('ROLE_REQUEST_NOT_PENDING');
  });

  it('will not let the requester approve their own request, nor the target decide it', async () => {
    const root3 = await seededAdmin(t, 'root3@u.nus.edu');
    const own = await as(root).role(student.id, 'ADMIN').expect(202);
    expect(code(await as(root).approve(own.body.request.id).expect(409))).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );

    const demote = await as(root).role(root2.id, 'STUDENT').expect(202); // root3 may approve
    expect(code(await as(root2).approve(demote.body.request.id).expect(409))).toBe(
      'CONFLICT_OF_INTEREST',
    );
    expect(code(await as(root2).reject(demote.body.request.id).expect(409))).toBe(
      'CONFLICT_OF_INTEREST',
    );
    await as(root3).approve(demote.body.request.id).expect(200);
    expect(await isAdmin(root2.id)).toBe(false);
  });

  it('lets the requester withdraw; a rejection changes no role and is on record', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    const withdrawn = await as(root).reject(asked.body.request.id, 'Asked by mistake').expect(200);
    expect(withdrawn.body).toMatchObject({
      status: 'REJECTED',
      decidedBy: root.id,
      decisionReason: 'Asked by mistake',
    });
    expect(code(await as(root2).approve(asked.body.request.id).expect(409))).toBe(
      'ROLE_REQUEST_NOT_PENDING',
    );
    expect(await isAdmin(student.id)).toBe(false);
    expect(await audit()).toEqual([
      { action: 'ROLE_CHANGE_REQUESTED', actor_id: root.id },
      { action: 'ROLE_CHANGE_REJECTED', actor_id: root.id },
    ]);
    await as(root).role(student.id, 'ADMIN').expect(202); // the target is free for a new request
  });

  it('allows one open request per target', async () => {
    const first = await as(root).role(student.id, 'ADMIN').expect(202);
    const second = await as(root2).role(student.id, 'STUDENT').expect(200); // nothing to change
    expect(second.body.roles).not.toContain('ADMIN');
    expect(code(await as(root2).role(student.id, 'ADMIN').expect(409))).toBe(
      'ROLE_REQUEST_PENDING',
    );
    const open = await as(root).get('/admin/role-requests?status=PENDING').expect(200);
    expect(open.body.items.map((r: { id: string }) => r.id)).toEqual([first.body.request.id]);
  });

  it('expires a request nobody decided in time', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    await t.db.query(
      "UPDATE role_change_requests SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'",
    );

    const listed = await as(root2).get('/admin/role-requests').expect(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ id: asked.body.request.id, status: 'EXPIRED' }),
    ]);
    const open = await as(root2).get('/admin/role-requests?status=PENDING').expect(200);
    expect(open.body.total).toBe(0);
    expect(code(await as(root2).approve(asked.body.request.id).expect(409))).toBe(
      'ROLE_REQUEST_EXPIRED',
    );
    expect(await isAdmin(student.id)).toBe(false);
    await as(root).role(student.id, 'ADMIN').expect(202); // a fresh request replaces it
  });

  it('checks the rules again at approval: a target suspended meanwhile is not appointed', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    await as(root2).suspend(student.id).expect(200);
    expect(code(await as(root2).approve(asked.body.request.id).expect(409))).toBe(
      'ACCOUNT_NOT_ACTIVE',
    );
    expect(await isAdmin(student.id)).toBe(false);
  });

  it('checks the rules again at approval: a requester suspended meanwhile has no authority left', async () => {
    const root3 = await seededAdmin(t, 'root3@u.nus.edu');
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    await as(root2).suspend(root.id).expect(200); // keeps the role, loses the authority
    expect(code(await as(root3).approve(asked.body.request.id).expect(409))).toBe(
      'ROLE_REQUEST_STALE',
    );
    expect(await isAdmin(student.id)).toBe(false);
  });

  it('checks the rules again at approval: a requester demoted meanwhile has no authority left', async () => {
    const root3 = await seededAdmin(t, 'root3@u.nus.edu');
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    const demote = await as(root2).role(root.id, 'STUDENT').expect(202);
    await as(root3).approve(demote.body.request.id).expect(200);
    expect(code(await as(root3).approve(asked.body.request.id).expect(409))).toBe(
      'ROLE_REQUEST_STALE',
    );
    expect(await isAdmin(student.id)).toBe(false);
  });

  it('lets exactly one of two simultaneous approvals through', async () => {
    const root3 = await seededAdmin(t, 'root3@u.nus.edu');
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    const results = await Promise.all([
      as(root2).approve(asked.body.request.id),
      as(root3).approve(asked.body.request.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(code(results.find((r) => r.status === 409)!)).toBe('ROLE_REQUEST_NOT_PENDING');
    expect((await audit()).filter((a) => a.action === 'ROLE_GRANT')).toHaveLength(1);
    expect(await events('user.role-changed')).toBe(1);
  });

  it('keeps one open request per target even when nobody could approve it any more', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    await as(root).suspend(root2.id).expect(200); // the only approver
    // Applying at once now would leave the open request to be approved later, changing nothing.
    expect(code(await as(root).role(student.id, 'ADMIN').expect(409))).toBe('ROLE_REQUEST_PENDING');
    expect(await isAdmin(student.id)).toBe(false);

    await as(root).reject(asked.body.request.id, 'Asked again').expect(200); // withdraw
    // Asking again waits too: root2 is suspended, but still holds the role.
    await as(root).role(student.id, 'ADMIN').expect(202);
    expect(await isAdmin(student.id)).toBe(false);
  });

  it('cannot be sidestepped by suspending the other admins first', async () => {
    await as(root).suspend(root2.id).expect(200); // the only other admin
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    expect(asked.body.request.status).toBe('PENDING');
    expect(await isAdmin(student.id)).toBe(false);
  });

  it('applies at once, and says so on the audit row, only when nobody else holds the role', async () => {
    // With two admins, demoting the other has no possible approver: the target decides nothing.
    await as(root).role(root2.id, 'STUDENT').expect(200);
    // root is now the only admin.
    const res = await as(root).role(student.id, 'ADMIN').expect(200);
    expect(res.body.roles).toContain('ADMIN');

    const rows = (
      await t.db.query<{ action: string; approval: string }>(
        "SELECT action, approval FROM audit_records WHERE actor_type = 'USER' ORDER BY occurred_at",
      )
    ).rows;
    expect(rows).toEqual([
      { action: 'ROLE_REVOKE', approval: 'NO_APPROVER' },
      { action: 'ROLE_GRANT', approval: 'NO_APPROVER' },
    ]);
    expect((await alerts()).map((a) => a.kind)).toEqual(['ROLE_CHANGE', 'ROLE_CHANGE']);
    expect((await alerts())[1]!.details).toMatchObject({
      requestedBy: root.id,
      approvedBy: root.id,
      approval: 'NO_APPROVER',
    });
  });

  it('refuses an approval that would change nothing, and records none', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    // Something outside this API gave the role meanwhile.
    await t.db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'ADMIN')", [student.id]);
    expect(code(await as(root2).approve(asked.body.request.id).expect(409))).toBe(
      'ROLE_REQUEST_STALE',
    );
    const open = await as(root).get('/admin/role-requests?status=PENDING').expect(200);
    expect(open.body.total).toBe(1);
    expect((await audit()).map((a) => a.action)).toEqual(['ROLE_CHANGE_REQUESTED']);
  });

  it('refuses an approver or requester suspended while the request was in flight', async () => {
    const service = t.app.get(AdminService);
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    const id = asked.body.request.id as string;
    // Suspended after the guards let the call in: the service checks again under its locks.
    await t.db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [root2.id]);
    const refused = { code: 'FORBIDDEN' };
    await expect(
      service.approveRoleRequest(root2.id, 'unused', id, 'x', 'c'),
    ).rejects.toMatchObject(refused);
    await expect(service.rejectRoleRequest(root2.id, 'unused', id, 'x', 'c')).rejects.toMatchObject(
      refused,
    );
    expect(await isAdmin(student.id)).toBe(false);
  });

  it('refuses a suspension or reactivation by an admin suspended while it was in flight', async () => {
    const service = t.app.get(AdminService);
    // Suspended after the guards let the call in — the second of two admins suspending each other.
    await t.db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [root2.id]);
    await expect(service.suspend(root2.id, 'unused', root.id, 'x', 'c')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      service.reactivate(root2.id, 'unused', student.id, 'x', 'c'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await statusOf(root.id)).toBe('ACTIVE');
  });
});

describe('watching the admins (ADM-04)', () => {
  it('records every read of another account, not of one’s own, and lists them by actor or target', async () => {
    await as(root).get(`/admin/users/${student.id}`).expect(200);
    await as(root).get(`/admin/users/${student.id.toUpperCase()}`).expect(200);
    await as(root).get(`/admin/users/${root.id}`).expect(200); // own account
    await as(root2).get(`/admin/users/${student.id}`).expect(200);
    await as(root)
      .get(`/admin/users/${'0'.repeat(8)}-0000-4000-8000-000000000000`)
      .expect(404);

    const byRoot = await as(root2).get(`/admin/reads?actorId=${root.id}`).expect(200);
    expect(byRoot.body.total).toBe(2);
    for (const r of byRoot.body.items) {
      expect(r).toMatchObject({ actorId: root.id, targetUserId: student.id });
      expect(r.correlationId).toEqual(expect.any(String));
    }
    const ofStudent = await as(root).get(`/admin/reads?targetUserId=${student.id}`).expect(200);
    expect(ofStudent.body.total).toBe(3);
    await as(root).get('/admin/reads?actorId=nobody').expect(422);
  });

  it('keeps the reads and the alerts append-only, like the audit trail', async () => {
    await as(root).get(`/admin/users/${student.id}`).expect(200);
    await as(root).suspend(root2.id).expect(200); // ADMIN_SUSPENDED
    for (const table of ['admin_reads', 'admin_alerts']) {
      await expect(t.db.query(`UPDATE ${table} SET actor_id = $1`, [student.id])).rejects.toThrow(
        /append-only/,
      );
      await expect(t.db.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
      expect(
        (await t.db.query(`SELECT 1 FROM ${table} WHERE actor_id = $1`, [root.id])).rows,
      ).toHaveLength(1);
    }
  });

  it('raises BULK_READS once an hour when one admin reads many accounts', async () => {
    const app = await createTestApp({ adminSettings: { readsAlertPerHour: 3 } });
    try {
      const a = await seededAdmin(app, 'root@u.nus.edu');
      for (let n = 1; n <= 4; n++) {
        const s = await activeStudent(app, `s${n}@u.nus.edu`);
        await as(a, app).get(`/admin/users/${s.id}`).expect(200);
        const raised = (await alerts(app)).filter((x) => x.kind === 'BULK_READS');
        expect(raised, `after read ${n}`).toHaveLength(n >= 3 ? 1 : 0);
      }
      expect((await alerts(app))[0]).toMatchObject({
        kind: 'BULK_READS',
        actor_id: a.id,
        details: { readsInLastHour: 3, threshold: 3 },
      });
    } finally {
      await app.close();
    }
  });

  it('limits how many accounts one admin suspends in an hour; the refused one changes nothing', async () => {
    const app = await createTestApp({
      adminSettings: { suspensionsAlertPerHour: 2, suspensionsLimitPerHour: 3 },
    });
    try {
      const a = await seededAdmin(app, 'root@u.nus.edu');
      const b = await seededAdmin(app, 'root2@u.nus.edu');
      const ids: string[] = [];
      for (let n = 1; n <= 4; n++) ids.push((await activeStudent(app, `s${n}@u.nus.edu`)).id);

      for (const id of ids.slice(0, 3)) await as(a, app).suspend(id).expect(200);
      const refused = await as(a, app).suspend(ids[3]!).expect(429);
      expect(code(refused)).toBe('RATE_LIMITED');
      await as(a, app).suspend(ids[3]!).expect(429);
      expect(await statusOf(ids[3]!, app)).toBe('ACTIVE');
      expect((await audit(app)).filter((r) => r.action === 'SUSPEND')).toHaveLength(3);
      expect(await events('user.suspended', app)).toBe(3);

      // each alert once, however many attempts follow
      expect(await alerts(app)).toEqual([
        expect.objectContaining({
          kind: 'BULK_SUSPENSIONS',
          actor_id: a.id,
          details: { suspensionsInLastHour: 2, threshold: 2 },
        }),
        expect.objectContaining({
          kind: 'SUSPENSION_LIMIT_REACHED',
          actor_id: a.id,
          details: { suspensionsInLastHour: 3, limit: 3 },
        }),
      ]);

      await as(a, app).suspend(ids[0]!).expect(200); // already suspended: nothing new, not refused
      await as(b, app).suspend(ids[3]!).expect(200); // the limit is per admin
    } finally {
      await app.close();
    }
  });

  it('lets only a seeded admin reactivate an admin, with the password, and raises ADMIN_REACTIVATED', async () => {
    const asked = await as(root).role(student.id, 'ADMIN').expect(202);
    await as(root2).approve(asked.body.request.id).expect(200);
    const appointed = await login(t, student.email);
    await as(root).suspend(root2.id, 'Left the team').expect(200);

    // An appointed admin cannot undo a seeded admin's suspension of an admin.
    expect(code(await as(appointed).reactivate(root2.id).expect(403))).toBe(
      'ADMIN_ACTION_NOT_PERMITTED',
    );
    // A stolen access token is not enough either.
    const fresh = await login(t, root.email);
    expect(code(await as(fresh).reactivate(root2.id).expect(401))).toBe('STEP_UP_REQUIRED');
    expect(await statusOf(root2.id)).toBe('SUSPENDED');

    await stepUp(t, fresh);
    await as(fresh).reactivate(root2.id, 'Back from leave').expect(200);
    expect((await alerts()).filter((a) => a.kind === 'ADMIN_REACTIVATED')).toEqual([
      expect.objectContaining({
        actor_id: root.id,
        details: { targetUserId: root2.id, reasonRef: expect.any(String) },
      }),
    ]);
  });

  it('leaves exactly one admin suspended when two suspend each other at once', async () => {
    const results = await Promise.all([as(root).suspend(root2.id), as(root2).suspend(root.id)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    // The other was suspended first: refused by its guard or by the service's own check.
    expect([401, 403]).toContain(results.find((r) => r.status !== 200)!.status);
    const suspended = (
      await t.db.query("SELECT 1 FROM users WHERE status = 'SUSPENDED' AND id IN ($1, $2)", [
        root.id,
        root2.id,
      ])
    ).rows;
    expect(suspended).toHaveLength(1);
  });

  it('records every account a full list returns, and nothing for the directory', async () => {
    const directory = await as(root).get('/admin/directory').expect(200);
    expect(directory.body.total).toBe(3);
    expect(Object.keys(directory.body.items[0]).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'isSeededAdmin',
      'roles',
      'status',
    ]);
    expect((await t.db.query('SELECT 1 FROM admin_reads')).rows).toHaveLength(0);

    await as(root).get('/admin/users').expect(200); // root, root2 and the student
    const reads = await as(root2).get(`/admin/reads?actorId=${root.id}`).expect(200);
    expect(reads.body.items.map((r: { targetUserId: string }) => r.targetUserId).sort()).toEqual(
      [root2.id, student.id].sort(), // root's own account is not a read
    );
  });

  it('raises ADMIN_SUSPENDED whenever an administrator is suspended, and only then', async () => {
    await as(root).suspend(student.id).expect(200);
    await as(root).suspend(root2.id, 'Left the team').expect(200);
    const raised = await alerts();
    expect(raised).toEqual([
      expect.objectContaining({
        kind: 'ADMIN_SUSPENDED',
        actor_id: root.id,
        details: { targetUserId: root2.id, reasonRef: expect.any(String) },
      }),
    ]);
  });

  it('lists alerts newest first, filters by kind, and names accounts by id only', async () => {
    await as(root).suspend(root2.id).expect(200);
    await as(root).reactivate(root2.id).expect(200);
    const all = await as(root).get('/admin/alerts').expect(200);
    expect(all.body.items.map((a: { kind: string }) => a.kind)).toEqual([
      'ADMIN_REACTIVATED',
      'ADMIN_SUSPENDED',
    ]);
    expect(JSON.stringify(all.body)).not.toContain('@');
    const one = await as(root).get('/admin/alerts?kind=ADMIN_SUSPENDED').expect(200);
    expect(one.body.total).toBe(1);
    await as(root).get('/admin/alerts?kind=SOMETHING').expect(422);
  });

  it('filters the audit trail by actor, action and time', async () => {
    await as(root).suspend(student.id, 'one').expect(200);
    await as(root2).reactivate(student.id, 'two').expect(200);

    const byActor = await as(root).get(`/admin/audit-records?actorId=${root2.id}`).expect(200);
    expect(byActor.body.items.map((r: { action: string }) => r.action)).toEqual(['REACTIVATE']);
    const byAction = await as(root).get('/admin/audit-records?action=SUSPEND').expect(200);
    expect(byAction.body.items.map((r: { actorId: string }) => r.actorId)).toEqual([root.id]);

    const hourFromNow = encodeURIComponent(new Date(Date.now() + 3600_000).toISOString());
    const hourAgo = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString());
    expect(
      (await as(root).get(`/admin/audit-records?from=${hourFromNow}`).expect(200)).body.total,
    ).toBe(0);
    expect((await as(root).get(`/admin/audit-records?to=${hourAgo}`).expect(200)).body.total).toBe(
      0,
    );
    const window = await as(root)
      .get(`/admin/audit-records?from=${hourAgo}&to=${hourFromNow}&action=REACTIVATE`)
      .expect(200);
    expect(window.body.total).toBe(1);

    await as(root).get('/admin/audit-records?action=DELETE').expect(422);
    await as(root).get('/admin/audit-records?from=yesterday').expect(422);
    await as(root).get(`/admin/audit-records?from=${hourFromNow}&to=${hourAgo}`).expect(422);
  });
});
