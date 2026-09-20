import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SERVICE_KEY, validRegistration, type TestApp } from './helpers/app.js';

let t: TestApp;
let userId: string;
const http = () => request(t.app.getHttpServer());
const asService = (path: string) => http().get(path).set('x-service-key', SERVICE_KEY);

beforeAll(async () => {
  t = await createTestApp();
  const res = await http().post('/auth/register').send(validRegistration()).expect(201);
  userId = res.body.userId;
});
afterAll(async () => {
  await t.close();
});

describe('GET /internal/users/:userId (US-FR4.1.2)', () => {
  it('returns only existence, status, roles and display name', async () => {
    const res = await asService(`/internal/users/${userId}`).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['displayName', 'exists', 'roles', 'status', 'userId'].sort(),
    );
    expect(res.body).toEqual({
      userId,
      exists: true,
      status: 'PENDING_ACTIVATION',
      roles: ['STUDENT'],
      displayName: 'Alex Tan',
    });
  });

  it('never returns a hash, token or email, whatever the account state', async () => {
    const token = t.mailbox.latestFor('e0123456@u.nus.edu')!.token;
    await http().post('/auth/activate').send({ token }).expect(200);
    const res = await asService(`/internal/users/${userId}`).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/argon2|password|hash|token|@u\.nus\.edu/i);
    expect(res.body.status).toBe('ACTIVE');
  });

  it('answers 200 with exists:false for an unknown user', async () => {
    const id = randomUUID();
    const res = await asService(`/internal/users/${id}`).expect(200);
    expect(res.body).toEqual({ userId: id, exists: false });
  });

  it('rejects a malformed id', async () => {
    const res = await asService('/internal/users/not-a-uuid').expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires a service credential', async () => {
    const none = await http().get(`/internal/users/${userId}`).expect(401);
    expect(none.body.error.code).toBe('SERVICE_UNAUTHENTICATED');
    await http()
      .get(`/internal/users/${userId}`)
      .set('x-service-key', 'wrong-key-wrong-key')
      .expect(401);
  });

  it('does not accept a user access token in place of a service credential', async () => {
    await http()
      .get(`/internal/users/${userId}`)
      .set('authorization', 'Bearer eyJhbGciOiJFZERTQSJ9.e30.sig')
      .expect(401);
  });
});

describe('GET /internal/users/:userId/permissions (US-FR4.1.3)', () => {
  it('grants order permissions to an active student, and no admin rights', async () => {
    const res = await asService(`/internal/users/${userId}/permissions`).expect(200);
    expect(res.body).toEqual({
      userId,
      status: 'ACTIVE',
      isAdmin: false,
      canPlaceOrders: true,
      canAcceptOrders: true,
    });
  });

  it('reports admin only for an ACTIVE account holding ADMIN', async () => {
    await t.db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'ADMIN')", [userId]);
    expect((await asService(`/internal/users/${userId}/permissions`)).body.isAdmin).toBe(true);

    await t.db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [userId]);
    const suspended = (await asService(`/internal/users/${userId}/permissions`)).body;
    expect(suspended).toMatchObject({
      isAdmin: false,
      canPlaceOrders: false,
      canAcceptOrders: false,
    });
  });

  it('returns 404 for an unknown user and requires the service key', async () => {
    await asService(`/internal/users/${randomUUID()}/permissions`).expect(404);
    await http().get(`/internal/users/${userId}/permissions`).expect(401);
  });
});
