import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app.js';
import {
  activeStudent,
  bearer,
  http,
  login,
  ORIGIN,
  seededAdmin,
  TRUNCATE_ALL,
  type Actor,
} from './helpers/actors.js';

let t: TestApp;
let root: Actor; // seeded admin
let root2: Actor; // second seeded admin
let student: Actor;

const as = (a: Actor) => ({
  suspend: (id: string, reason = 'test reason') =>
    http(t).post(`/admin/users/${id}/suspend`).set('Authorization', bearer(a)).send({ reason }),
  reactivate: (id: string, reason = 'test reason') =>
    http(t).post(`/admin/users/${id}/reactivate`).set('Authorization', bearer(a)).send({ reason }),
  role: (id: string, role: string, reason = 'test reason') =>
    http(t).put(`/admin/users/${id}/role`).set('Authorization', bearer(a)).send({ role, reason }),
  get: (path: string) => http(t).get(path).set('Authorization', bearer(a)),
});
const events = async (type: string) =>
  (await t.db.query('SELECT * FROM outbox_events WHERE event_type = $1', [type])).rows;
const audit = async () =>
  (await t.db.query('SELECT * FROM audit_records ORDER BY occurred_at')).rows;

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

describe('suspend / reactivate (US-FR3.1.2, US-FR4.1.4)', () => {
  it('suspends: status changes, sessions die, the account is locked out, event and audit written', async () => {
    const res = await as(root).suspend(student.id, 'Repeated no-shows').expect(200);
    expect(res.body.status).toBe('SUSPENDED');

    // the student's live access token and refresh cookie stop working at once
    await http(t).get('/users/me').set('Authorization', bearer(student)).expect(401);
    await http(t)
      .post('/auth/refresh')
      .set('Cookie', student.cookie)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(401);
    const denied = await http(t)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: student.email, password: 'correct-horse-battery-staple' })
      .expect(403);
    expect(denied.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const [row] = await audit();
    expect(row).toMatchObject({
      actor_id: root.id,
      target_user_id: student.id,
      action: 'SUSPEND',
      reason: 'Repeated no-shows',
    });
    const [event] = await events('UserSuspended');
    expect(event!.payload).toEqual({ userId: student.id, status: 'SUSPENDED', reasonRef: row!.id });
  });

  it('is idempotent: a second suspend adds no audit row and no event', async () => {
    await as(root).suspend(student.id).expect(200);
    await as(root).suspend(student.id).expect(200);
    expect(await audit()).toHaveLength(1);
    expect(await events('UserSuspended')).toHaveLength(1);
  });

  it('reactivates, allows login again, and records event and audit', async () => {
    await as(root).suspend(student.id).expect(200);
    const res = await as(root).reactivate(student.id, 'Appeal upheld').expect(200);
    expect(res.body.status).toBe('ACTIVE');
    await login(t, student.email);
    expect((await audit()).map((a) => a.action)).toEqual(['SUSPEND', 'REACTIVATE']);
    const [event] = await events('UserReactivated');
    expect(event!.payload).toMatchObject({ userId: student.id, status: 'ACTIVE' });
    await as(root).reactivate(student.id).expect(200); // idempotent
    expect(await events('UserReactivated')).toHaveLength(1);
  });

  it('cannot suspend an account that never activated, so reactivation can never skip activation', async () => {
    await http(t)
      .post('/auth/register')
      .send({
        email: 'pending@u.nus.edu',
        password: 'correct-horse-battery-staple',
        displayName: 'P',
      })
      .expect(201);
    const id = (await t.db.query('SELECT id FROM users WHERE email = $1', ['pending@u.nus.edu']))
      .rows[0]!.id as string;
    const res = await as(root).suspend(id).expect(409);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    await as(root).reactivate(id).expect(409);
  });

  it('requires a reason and a real user', async () => {
    await http(t)
      .post(`/admin/users/${student.id}/suspend`)
      .set('Authorization', bearer(root))
      .send({})
      .expect(422);
    await http(t)
      .post(`/admin/users/${student.id}/suspend`)
      .set('Authorization', bearer(root))
      .send({ reason: '  ' })
      .expect(422);
    await as(root).suspend('00000000-0000-4000-8000-000000000000').expect(404);
    await as(root).suspend('not-a-uuid').expect(422);
  });

  it('will not let an admin suspend themselves', async () => {
    const res = await as(root).suspend(root.id).expect(409);
    expect(res.body.error.code).toBe('SELF_SUSPENSION_FORBIDDEN');
  });

  it('lets only a seeded admin suspend another admin', async () => {
    await as(root).role(student.id, 'ADMIN').expect(200); // student becomes an appointed admin
    const appointed = await login(t, student.email);
    const denied = await as(appointed).suspend(root2.id).expect(403);
    expect(denied.body.error.code).toBe('ADMIN_ACTION_NOT_PERMITTED');
    await as(root).suspend(appointed.id).expect(200); // seeded may
  });
});

describe('roles (US-FR3.1.3, US-FR3.1.3.1)', () => {
  it('appoints an admin, who can then use admin endpoints, and records who granted it', async () => {
    await as(student).get('/admin/users').expect(403);
    const res = await as(root).role(student.id, 'ADMIN', 'New ops lead').expect(200);
    expect(res.body.roles).toEqual(['ADMIN', 'STUDENT']);
    expect(res.body.isSeededAdmin).toBe(false);
    await as(student).get('/admin/users').expect(200); // same token: role is read live, not from the token
    const grant = (
      await t.db.query("SELECT granted_by FROM user_roles WHERE user_id = $1 AND role = 'ADMIN'", [
        student.id,
      ])
    ).rows[0]!;
    expect(grant.granted_by).toBe(root.id);
    expect((await audit()).at(-1)).toMatchObject({
      action: 'ROLE_GRANT',
      target_user_id: student.id,
      reason: 'New ops lead',
    });
  });

  it('is idempotent when the role is already held', async () => {
    await as(root).role(student.id, 'ADMIN').expect(200);
    await as(root).role(student.id, 'ADMIN').expect(200);
    expect((await audit()).filter((a) => a.action === 'ROLE_GRANT')).toHaveLength(1);
  });

  it('refuses to appoint an account that is not active', async () => {
    await as(root).suspend(student.id).expect(200);
    const res = await as(root).role(student.id, 'ADMIN').expect(409);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('refuses an appointed admin who tries to downgrade another admin — even a seeded one', async () => {
    await as(root).role(student.id, 'ADMIN').expect(200);
    const appointed = await login(t, student.email);
    const a = await as(appointed).role(root.id, 'STUDENT').expect(403);
    expect(a.body.error.code).toBe('ADMIN_DOWNGRADE_NOT_PERMITTED');
    await as(root).get('/admin/users').expect(200); // root is still an admin
  });

  it('lets a seeded admin downgrade an appointed admin, who then loses access immediately', async () => {
    await as(root).role(student.id, 'ADMIN').expect(200);
    const appointed = await login(t, student.email);
    await as(appointed).get('/admin/users').expect(200);

    const res = await as(root).role(appointed.id, 'STUDENT', 'Left the team').expect(200);
    expect(res.body.roles).toEqual(['STUDENT']);
    await as(appointed).get('/admin/users').expect(403);
    expect((await audit()).at(-1)).toMatchObject({ action: 'ROLE_REVOKE' });
  });

  it('lets a seeded admin downgrade another seeded admin while one remains', async () => {
    await as(root).role(root2.id, 'STUDENT').expect(200);
    await as(root).get('/admin/users').expect(200);
  });

  it('forbids demoting yourself, seeded or appointed', async () => {
    const seeded = await as(root).role(root.id, 'STUDENT').expect(409);
    expect(seeded.body.error.code).toBe('SELF_DEMOTION_FORBIDDEN');
    await as(root).role(student.id, 'ADMIN').expect(200);
    const appointed = await login(t, student.email);
    const own = await as(appointed).role(appointed.id, 'STUDENT').expect(409);
    expect(own.body.error.code).toBe('SELF_DEMOTION_FORBIDDEN');
  });

  it('never leaves zero administrators, even when two seeded admins demote each other at once', async () => {
    const results = await Promise.all([
      as(root).role(root2.id, 'STUDENT'),
      as(root2).role(root.id, 'STUDENT'),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const admins = (await t.db.query("SELECT user_id FROM user_roles WHERE role = 'ADMIN'")).rows;
    expect(admins).toHaveLength(1);
  });

  it('validates the body', async () => {
    await as(root).role(student.id, 'SUPERUSER').expect(422);
    await http(t)
      .put(`/admin/users/${student.id}/role`)
      .set('Authorization', bearer(root))
      .send({ role: 'ADMIN' })
      .expect(422);
  });
});

describe('audit trail (US-NFR4.1.2)', () => {
  it('lists records newest first and filters by target', async () => {
    await as(root).suspend(student.id, 'one').expect(200);
    await as(root).reactivate(student.id, 'two').expect(200);
    const all = (await as(root).get('/admin/audit-records').expect(200)).body;
    expect(all.total).toBe(2);
    expect(all.items.map((i: { action: string }) => i.action)).toEqual(['REACTIVATE', 'SUSPEND']);
    expect(all.items[0]).toEqual({
      id: expect.any(String),
      actorId: root.id,
      targetUserId: student.id,
      action: 'REACTIVATE',
      reason: 'two',
      occurredAt: expect.any(String),
      correlationId: expect.any(String),
    });
    const none = (await as(root).get(`/admin/audit-records?targetUserId=${root.id}`).expect(200))
      .body;
    expect(none.total).toBe(0);
  });

  it('is append-only: the database rejects UPDATE and DELETE', async () => {
    await as(root).suspend(student.id).expect(200);
    await expect(t.db.query("UPDATE audit_records SET reason = 'rewritten'")).rejects.toThrow(
      /append-only/,
    );
    await expect(t.db.query('DELETE FROM audit_records')).rejects.toThrow(/append-only/);
    expect(await audit()).toHaveLength(1);
  });

  it('has no API route that creates, edits or deletes a record', async () => {
    await as(root).suspend(student.id).expect(200);
    const id = (await audit())[0]!.id as string;
    for (const call of [
      http(t).post('/admin/audit-records').send({}),
      http(t).put(`/admin/audit-records/${id}`).send({}),
      http(t).patch(`/admin/audit-records/${id}`).send({}),
      http(t).delete(`/admin/audit-records/${id}`),
    ]) {
      const res = await call.set('Authorization', bearer(root));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await audit()).toHaveLength(1);
  });
});

describe('GET /admin/users', () => {
  it('lists with pagination and never returns credentials', async () => {
    const res = (await as(root).get('/admin/users').expect(200)).body;
    expect(res).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(JSON.stringify(res)).not.toMatch(/argon2|password|hash|token/i);
    const first = (await as(root).get('/admin/users?pageSize=2').expect(200)).body;
    expect(first.items).toHaveLength(2);
    const second = (await as(root).get('/admin/users?pageSize=2&page=2').expect(200)).body;
    expect(second.items).toHaveLength(1);
  });

  it('filters by status, role and search prefix, and treats % literally', async () => {
    await as(root).suspend(student.id).expect(200);
    expect((await as(root).get('/admin/users?status=SUSPENDED').expect(200)).body.total).toBe(1);
    expect((await as(root).get('/admin/users?role=ADMIN').expect(200)).body.total).toBe(2);
    expect((await as(root).get('/admin/users?q=STUD').expect(200)).body.items[0].email).toBe(
      'student@u.nus.edu',
    );
    expect((await as(root).get('/admin/users?q=%25').expect(200)).body.total).toBe(0);
  });

  it('bounds the page size and rejects bad filters', async () => {
    await as(root).get('/admin/users?pageSize=101').expect(422);
    await as(root).get('/admin/users?page=0').expect(422);
    await as(root).get('/admin/users?status=BANNED').expect(422);
  });

  it('reads one account', async () => {
    const res = (await as(root).get(`/admin/users/${student.id}`).expect(200)).body;
    expect(res).toMatchObject({
      email: 'student@u.nus.edu',
      status: 'ACTIVE',
      isSeededAdmin: false,
    });
    await as(root).get('/admin/users/00000000-0000-4000-8000-000000000000').expect(404);
  });
});
