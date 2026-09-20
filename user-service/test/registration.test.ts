import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, validRegistration, type TestApp } from './helpers/app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const count = async (table: string) =>
  Number((await t.db.query<{ n: string }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(
    'TRUNCATE outbox_events, activation_tokens, profiles, user_roles, users RESTART IDENTITY CASCADE',
  );
});

describe('POST /auth/register', () => {
  it('creates a pending student with a profile and a hashed password', async () => {
    const res = await http().post('/auth/register').send(validRegistration()).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING_ACTIVATION' });

    const user = (await t.db.query('SELECT * FROM users')).rows[0]!;
    expect(user.email).toBe('e0123456@u.nus.edu');
    expect(user.status).toBe('PENDING_ACTIVATION');
    expect(String(user.password_hash)).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain('correct-horse');

    expect((await t.db.query('SELECT role FROM user_roles')).rows).toEqual([{ role: 'STUDENT' }]);
    expect((await t.db.query('SELECT display_name FROM profiles')).rows).toEqual([
      { display_name: 'Alex Tan' },
    ]);
  });

  it('gives two accounts with the same password different hashes (unique salts)', async () => {
    await http().post('/auth/register').send(validRegistration('a@u.nus.edu')).expect(201);
    await http().post('/auth/register').send(validRegistration('b@u.nus.edu')).expect(201);
    const hashes = (await t.db.query('SELECT password_hash FROM users')).rows.map(
      (r) => r.password_hash,
    );
    expect(new Set(hashes).size).toBe(2);
  });

  it('rejects an off-domain email and creates nothing', async () => {
    const res = await http()
      .post('/auth/register')
      .send(validRegistration('alex@gmail.com'))
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: 'email', code: 'EMAIL_DOMAIN_NOT_ALLOWED' }),
    ]);
    expect(await count('users')).toBe(0);
    expect(await count('profiles')).toBe(0);
  });

  it('does not accept a look-alike domain', async () => {
    await http().post('/auth/register').send(validRegistration('a@evil-u.nus.edu')).expect(422);
    await http().post('/auth/register').send(validRegistration('a@u.nus.edu.evil.com')).expect(422);
    expect(await count('users')).toBe(0);
  });

  it('rejects a duplicate email, including a case and whitespace variant, without a second row', async () => {
    await http().post('/auth/register').send(validRegistration()).expect(201);
    const res = await http()
      .post('/auth/register')
      .send(validRegistration('  E0123456@U.NUS.EDU '))
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(await count('users')).toBe(1);
    expect(await count('activation_tokens')).toBe(1);
  });

  it('lets exactly one of several simultaneous registrations for one email succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => http().post('/auth/register').send(validRegistration())),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await count('users')).toBe(1);
  });

  it('reports every invalid field and never echoes the password', async () => {
    const res = await http()
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'short', role: 'ADMIN' })
      .expect(422);
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'password', 'displayName', 'role']));
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'role', code: 'UNKNOWN_FIELD' }),
    );
    expect(JSON.stringify(res.body)).not.toContain('short');
    expect(await count('users')).toBe(0);
  });

  it('carries the caller correlation id on errors', async () => {
    const res = await http()
      .post('/auth/register')
      .set('x-correlation-id', 'corr-abc')
      .send({})
      .expect(422);
    expect(res.body.error.correlationId).toBe('corr-abc');
  });
});

describe('POST /auth/activate', () => {
  const register = async (email = 'e0123456@u.nus.edu') => {
    await http().post('/auth/register').send(validRegistration(email)).expect(201);
    return t.mailbox.latestFor(email)!.token;
  };
  const events = async () =>
    (await t.db.query("SELECT * FROM outbox_events WHERE event_type = 'UserActivated'")).rows;

  it('stores only a hash of the token', async () => {
    const token = await register();
    const rows = (await t.db.query('SELECT token_hash FROM activation_tokens')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('activates the account and publishes exactly one UserActivated', async () => {
    const token = await register();
    const res = await http().post('/auth/activate').send({ token }).expect(200);
    expect(res.body).toMatchObject({ status: 'ACTIVE', alreadyActivated: false });

    expect((await t.db.query('SELECT status FROM users')).rows[0]!.status).toBe('ACTIVE');
    const emitted = await events();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({ userId: res.body.userId });
    expect(emitted[0]!.aggregate_id).toBe(res.body.userId);
  });

  it('is idempotent on replay: 200, alreadyActivated, and no second event', async () => {
    const token = await register();
    await http().post('/auth/activate').send({ token }).expect(200);
    for (let i = 0; i < 3; i++) {
      const replay = await http().post('/auth/activate').send({ token }).expect(200);
      expect(replay.body).toMatchObject({ status: 'ACTIVE', alreadyActivated: true });
    }
    expect(await events()).toHaveLength(1);
  });

  it('emits one event when the same token is submitted concurrently', async () => {
    const token = await register();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => http().post('/auth/activate').send({ token })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.alreadyActivated === false)).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('rejects an expired token, leaves the account pending and emits nothing', async () => {
    const token = await register();
    await t.db.exec("UPDATE activation_tokens SET expires_at = now() - interval '1 minute'");
    const res = await http().post('/auth/activate').send({ token }).expect(410);
    expect(res.body.error.code).toBe('ACTIVATION_TOKEN_EXPIRED');
    expect((await t.db.query('SELECT status FROM users')).rows[0]!.status).toBe(
      'PENDING_ACTIVATION',
    );
    expect(await events()).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    const res = await http()
      .post('/auth/activate')
      .send({ token: 'x'.repeat(43) })
      .expect(404);
    expect(res.body.error.code).toBe('ACTIVATION_TOKEN_INVALID');
  });

  it('rejects a malformed body', async () => {
    await http().post('/auth/activate').send({}).expect(422);
    await http().post('/auth/activate').send({ token: 'short' }).expect(422);
  });
});
