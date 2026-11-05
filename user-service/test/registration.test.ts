import { userActivatedPayload } from '@foc/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import {
  activation,
  createTestApp,
  PASSWORD,
  validRegistration,
  type TestApp,
} from './helpers/app.js';
import { ORIGIN } from './helpers/actors.js';

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
    'TRUNCATE outbox_events, activation_tokens, refresh_sessions, profiles, user_roles, users RESTART IDENTITY CASCADE',
  );
});

describe('POST /auth/register', () => {
  it('creates a pending student with a profile and no password yet (#309)', async () => {
    const res = await http().post('/auth/register').send(validRegistration()).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING_ACTIVATION' });

    const user = (await t.db.query('SELECT * FROM users')).rows[0]!;
    expect(user.email).toBe('e0123456@u.nus.edu');
    expect(user.status).toBe('PENDING_ACTIVATION');
    expect(user.password_hash).toBeNull();

    expect((await t.db.query('SELECT role FROM user_roles')).rows).toEqual([{ role: 'STUDENT' }]);
    expect((await t.db.query('SELECT display_name FROM profiles')).rows).toEqual([
      { display_name: 'Alex Tan' },
    ]);
  });

  it('refuses a password: it is chosen at activation, once the inbox is proven (#309)', async () => {
    const res = await http()
      .post('/auth/register')
      .send({ ...validRegistration(), password: PASSWORD })
      .expect(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: 'password', code: 'UNKNOWN_FIELD' }),
    ]);
    expect(await count('users')).toBe(0);
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
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'password', code: 'UNKNOWN_FIELD' }),
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
  const activate = (token: string, password = PASSWORD) =>
    http().post('/auth/activate').send(activation(token, password));
  const signIn = (password: string, email = 'e0123456@u.nus.edu') =>
    http().post('/auth/login').set('Origin', ORIGIN).send({ email, password });
  const events = async () =>
    (await t.db.query("SELECT * FROM outbox_events WHERE event_type = 'user.activated'")).rows;
  const user = async () => (await t.db.query('SELECT * FROM users')).rows[0]!;

  it('stores only a hash of the token', async () => {
    const token = await register();
    const rows = (await t.db.query('SELECT token_hash FROM activation_tokens')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('activates the account and publishes exactly one user.activated', async () => {
    const token = await register();
    const res = await activate(token).expect(200);
    expect(res.body).toMatchObject({ status: 'ACTIVE', alreadyActivated: false });

    expect((await user()).status).toBe('ACTIVE');
    const emitted = await events();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({
      userId: res.body.userId,
      activatedAt: expect.any(String),
    });
    expect(emitted[0]!.event_type).toBe('user.activated');
    expect(userActivatedPayload.safeParse(emitted[0]!.payload).success).toBe(true);
    expect(emitted[0]!.aggregate_id).toBe(res.body.userId);
  });

  it('sets the chosen password, stored only as an Argon2id hash, and does not sign in', async () => {
    const res = await activate(await register()).expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual(['alreadyActivated', 'status', 'userId']);

    const stored = await user();
    expect(String(stored.password_hash)).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    await signIn(PASSWORD).expect(200);
  });

  it('gives two accounts with the same password different hashes (unique salts)', async () => {
    await activate(await register('a@u.nus.edu')).expect(200);
    await activate(await register('b@u.nus.edu')).expect(200);
    const hashes = (await t.db.query('SELECT password_hash FROM users')).rows.map(
      (r) => r.password_hash,
    );
    expect(new Set(hashes).size).toBe(2);
  });

  it('is idempotent on replay: 200, alreadyActivated, no second event, the password unchanged', async () => {
    const token = await register();
    await activate(token).expect(200);
    const hash = (await user()).password_hash;
    for (let i = 0; i < 3; i++) {
      const replay = await activate(token, `another-passphrase-${i}`).expect(200);
      expect(replay.body).toMatchObject({ status: 'ACTIVE', alreadyActivated: true });
    }
    expect(await events()).toHaveLength(1);
    expect((await user()).password_hash).toBe(hash);
    await signIn(PASSWORD).expect(200);
    await signIn('another-passphrase-0').expect(401);
  });

  it('lets one of several simultaneous submits set the password; the rest are replays', async () => {
    const token = await register();
    const passwords = Array.from({ length: 5 }, (_, i) => `concurrent-passphrase-${i}`);
    const results = await Promise.all(passwords.map((password) => activate(token, password)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const winners = results.filter((r) => r.body.alreadyActivated === false);
    expect(winners).toHaveLength(1);
    expect(await events()).toHaveLength(1);

    const hash = String((await user()).password_hash);
    const matching = await Promise.all(passwords.map((p) => verifyPassword(hash, p)));
    expect(matching.filter(Boolean)).toHaveLength(1);
    expect(matching[results.indexOf(winners[0]!)]).toBe(true);
  });

  it('expires the link after 30 minutes, leaving the account pending and without a password', async () => {
    const token = await register();
    const { rows } = await t.db.query(
      'SELECT extract(epoch FROM expires_at - now())::int AS ttl FROM activation_tokens',
    );
    // 30 minutes by default (ACTIVATION_TOKEN_TTL_MINUTES), as for a reset link.
    expect(Number(rows[0]!.ttl)).toBeGreaterThan(29 * 60);
    expect(Number(rows[0]!.ttl)).toBeLessThanOrEqual(30 * 60);

    // Thirty-one minutes on.
    await t.db.exec("UPDATE activation_tokens SET expires_at = expires_at - interval '31 minutes'");
    const res = await activate(token).expect(410);
    expect(res.body.error.code).toBe('ACTIVATION_TOKEN_EXPIRED');
    expect(await user()).toMatchObject({ status: 'PENDING_ACTIVATION', password_hash: null });
    expect(await events()).toHaveLength(0);
  });

  it('does not activate a suspended account, and leaves the token unconsumed', async () => {
    const token = await register();
    // Only a pending account may lack a password, so one is set alongside the status.
    await t.db.exec("UPDATE users SET status = 'SUSPENDED', password_hash = 'the-old-hash'");
    const res = await activate(token).expect(404);
    expect(res.body.error.code).toBe('ACTIVATION_TOKEN_INVALID');
    expect(await user()).toMatchObject({ status: 'SUSPENDED', password_hash: 'the-old-hash' });
    expect(
      (await t.db.query('SELECT consumed_at FROM activation_tokens')).rows[0]!.consumed_at,
    ).toBeNull();
    expect(await events()).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    const res = await activate('x'.repeat(43)).expect(404);
    expect(res.body.error.code).toBe('ACTIVATION_TOKEN_INVALID');
  });

  it('applies the password policy, never echoes the password, and leaves the link usable', async () => {
    const token = await register();
    await http().post('/auth/activate').send({}).expect(422);
    await http().post('/auth/activate').send(activation('short')).expect(422);
    const missing = await http().post('/auth/activate').send({ token }).expect(422);
    expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'password' })]);
    const short = await activate(token, 'too-short-1').expect(422);
    expect(short.body.error.details).toEqual([
      expect.objectContaining({ field: 'password', code: 'TOO_SMALL' }),
    ]);
    expect(JSON.stringify(short.body)).not.toContain('too-short-1');
    await activate(token, 'x'.repeat(129)).expect(422);
    expect(await user()).toMatchObject({ status: 'PENDING_ACTIVATION', password_hash: null });

    await activate(token).expect(200);
  });
});

/**
 * #309: someone registers a student's address and keeps its link alive by resending. They never
 * see the link, so they never choose the password: only the inbox's owner does, at activation.
 */
describe('the pre-registration hijack (#309)', () => {
  const EMAIL = 'e0123456@u.nus.edu';
  const ATTACKER_PASSWORD = 'the-attackers-chosen-passphrase';
  const STUDENT_PASSWORD = 'the-students-own-passphrase';
  const signIn = (password: string) =>
    http().post('/auth/login').set('Origin', ORIGIN).send({ email: EMAIL, password });
  const activate = (token: string, password: string) =>
    http().post('/auth/activate').send(activation(token, password));

  it("leaves the student with only the password they chose; the attacker's never works", async () => {
    // The attacker cannot offer a password with the sign-up, so registers without one.
    await http()
      .post('/auth/register')
      .send({ ...validRegistration(EMAIL), password: ATTACKER_PASSWORD })
      .expect(422);
    await http().post('/auth/register').send(validRegistration(EMAIL)).expect(201);
    // And keeps the address's link alive.
    for (let i = 0; i < 3; i++) {
      const previous = t.mailbox.latestFor(EMAIL)!.token;
      await http().post('/auth/activation/resend').send({ email: EMAIL }).expect(202);
      await vi.waitFor(() => expect(t.mailbox.latestFor(EMAIL)!.token).not.toBe(previous));
    }
    // A pending account has no password, so nothing anyone tries signs in.
    for (const password of [ATTACKER_PASSWORD, PASSWORD, 'not-a-real-password']) {
      expect((await signIn(password).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const signUp = await http().post('/auth/register').send(validRegistration(EMAIL)).expect(409);
    expect(signUp.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');

    // The student opens the newest link from their own inbox and chooses their password.
    const link = t.mailbox.latestFor(EMAIL)!.token;
    await activate(link, STUDENT_PASSWORD).expect(200);

    await signIn(STUDENT_PASSWORD).expect(200);
    expect((await signIn(ATTACKER_PASSWORD).expect(401)).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    // Anyone replaying the link afterwards changes nothing.
    await activate(link, ATTACKER_PASSWORD).expect(200);
    await signIn(ATTACKER_PASSWORD).expect(401);
    await signIn(STUDENT_PASSWORD).expect(200);
    expect(
      (await t.db.query("SELECT 1 FROM outbox_events WHERE event_type = 'user.activated'")).rows,
    ).toHaveLength(1);
  });

  it('replaces a password planted before #309 on a still-pending account', async () => {
    // Migration 0007 keeps a pending account's hash, for images from before #309 to roll back to.
    await http().post('/auth/register').send(validRegistration(EMAIL)).expect(201);
    await t.db.query('UPDATE users SET password_hash = $1', [
      await hashPassword(ATTACKER_PASSWORD),
    ]);

    // Pending: the planted password starts no session.
    const early = await signIn(ATTACKER_PASSWORD).expect(403);
    expect(early.body.error.code).toBe('ACCOUNT_NOT_ACTIVATED');
    expect(await count('refresh_sessions')).toBe(0);

    await activate(t.mailbox.latestFor(EMAIL)!.token, STUDENT_PASSWORD).expect(200);
    await signIn(STUDENT_PASSWORD).expect(200);
    expect((await signIn(ATTACKER_PASSWORD).expect(401)).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
  });
});
