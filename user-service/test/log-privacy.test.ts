import request from 'supertest';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmins } from '../src/admin/seed.js';
import { env } from '../src/config.js';
import { UsersModule } from '../src/users/users.module.js';
import { createTestApp, SERVICE_KEY, validRegistration, type TestApp } from './helpers/app.js';

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(chunk.toString());
    cb();
  },
});

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ logLevel: 'trace', logDestination: sink });
});
afterAll(async () => {
  await t.close();
});

describe('log privacy (US-NFR2.1.1)', () => {
  it('writes no password, hash or token to any log line at any level', async () => {
    const http = () => request(t.app.getHttpServer());
    const reg = validRegistration();

    const created = await http().post('/auth/register').send(reg).expect(201);
    const token = t.mailbox.latestFor(reg.email)!.token;
    await http().post('/auth/register').send(reg).expect(409); // duplicate path
    await http()
      .post('/auth/register')
      .send({ ...reg, email: 'a@gmail.com' })
      .expect(422);
    await http().post('/auth/activate').send({ token }).expect(200);
    await http().post('/auth/activate').send({ token }).expect(200); // replay path
    await http()
      .post('/auth/activate')
      .send({ token: 'y'.repeat(43) })
      .expect(404);
    await http()
      .get(`/internal/users/${created.body.userId}`)
      .set('x-service-key', SERVICE_KEY)
      .expect(200);
    await http().get(`/internal/users/${created.body.userId}`).expect(401);

    const hash = String(
      (await t.db.query('SELECT password_hash FROM users')).rows[0]!.password_hash,
    );
    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(0); // the capture actually works

    expect(output).not.toContain(reg.password);
    expect(output).not.toContain(token);
    expect(output).not.toContain(hash);
    expect(output).not.toContain(SERVICE_KEY);
    expect(output).not.toMatch(/argon2/i);
  });
});

/**
 * USR-08 (US-NFR4.1.1): logs identify a user by `userId` and a request by `correlationId`, never by
 * a verified email, a credential or a token. Walks the registration, login, refresh, profile and
 * admin paths — success and error — with an email embedded in a query string too, then scans
 * everything written at `trace`.
 */
describe('log privacy across auth and admin paths (US-NFR4.1.1)', () => {
  it('logs no email address, credential or token on any tested path', async () => {
    const start = lines.length;
    const http = () => request(t.app.getHttpServer());
    const origin = 'http://localhost:3000';
    const adminEmail = 'root@u.nus.edu';
    const studentEmail = 'e0999999@u.nus.edu';
    const password = validRegistration().password;
    const adminPassword = 'the-admins-own-passphrase';

    await seedAdmins(t.db, {
      emails: [adminEmail],
      password,
      allowedDomains: ['u.nus.edu'],
    });
    await http().post('/auth/register').send(validRegistration(studentEmail)).expect(201);
    const activation = t.mailbox.latestFor(studentEmail)!.token;
    await http().post('/auth/activate').send({ token: activation }).expect(200);

    const login = (email: string, pw = password) =>
      http().post('/auth/login').set('Origin', origin).send({ email, password: pw });
    await login(studentEmail, 'wrong-password-here').expect(401);
    await login('nobody@u.nus.edu').expect(401);
    const studentLogin = await login(studentEmail).expect(200);
    // The bootstrap password only opens POST /auth/password (USR-03); that path is scanned too.
    await login(adminEmail).expect(403);
    await http()
      .post('/auth/password')
      .set('Origin', origin)
      .send({ email: adminEmail, currentPassword: password, newPassword: adminPassword })
      .expect(204);
    await http()
      .post('/auth/password')
      .set('Origin', origin)
      .send({
        email: adminEmail,
        currentPassword: 'wrong-password-here',
        newPassword: 'x'.repeat(12),
      })
      .expect(401);
    const adminLogin = await login(adminEmail, adminPassword).expect(200);

    const cookieOf = (res: request.Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith('foc_refresh='))!
        .split(';')[0]!;
    const studentCookie = cookieOf(studentLogin);
    const refresh = (cookie: string) =>
      http()
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .set('Origin', origin)
        .set('Content-Type', 'application/json');
    const rotated = await refresh(studentCookie).expect(200);
    await refresh(studentCookie).expect(401); // reuse detection path
    await refresh('foc_refresh=garbage').expect(401);

    // Reuse detection revoked that whole family, so the student signs in again.
    const studentAgain = await login(studentEmail).expect(200);
    const student = `Bearer ${studentAgain.body.accessToken}`;
    const admin = `Bearer ${adminLogin.body.accessToken}`;
    const studentId = studentLogin.body.user.id as string;
    await http().get('/users/me').set('Authorization', admin).expect(200);
    await http().patch('/users/me').set('Authorization', admin).send({ email: 'x@u.nus.edu' });
    await http().get('/admin/users').set('Authorization', student).expect(403);
    await http()
      .get(`/admin/users?q=${encodeURIComponent(studentEmail)}`)
      .set('Authorization', admin)
      .expect(200);
    await http().get(`/admin/users/${studentId}`).set('Authorization', admin).expect(200);
    await http()
      .post(`/admin/users/${studentId}/suspend`)
      .set('Authorization', admin)
      .send({ reason: 'log scan' })
      .expect(200);
    await login(studentEmail).expect(403); // suspended path
    await http()
      .post(`/admin/users/${studentId}/reactivate`)
      .set('Authorization', admin)
      .send({ reason: 'log scan' })
      .expect(200);
    await http().get('/admin/audit-records').set('Authorization', admin).expect(200);
    await http().get('/users/me').set('Authorization', 'Bearer not-a-token').expect(401);
    await http()
      .post('/auth/logout')
      .set('Cookie', cookieOf(studentAgain))
      .set('Origin', origin)
      .set('Content-Type', 'application/json')
      .expect(204);

    const output = lines.slice(start).join('');
    expect(output.length).toBeGreaterThan(0);
    // Request lines carry a correlation id, so a request can still be traced without the email.
    expect(output).toMatch(/correlationId/);

    const hashes = (await t.db.query<{ password_hash: string }>('SELECT password_hash FROM users'))
      .rows;
    const secrets = [
      password,
      adminPassword,
      activation,
      studentLogin.body.accessToken,
      adminLogin.body.accessToken,
      rotated.body.accessToken,
      studentAgain.body.accessToken,
      studentCookie.slice('foc_refresh='.length),
      SERVICE_KEY,
      ...hashes.map((h) => h.password_hash),
    ];
    for (const secret of secrets) expect(output).not.toContain(secret);
    // No email address of any kind, in plain or URL-encoded form.
    expect(output).not.toMatch(/[a-z0-9._%+-]+(@|%40)[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe('development mailbox guard', () => {
  it('refuses to start in production, so activation tokens are never exposed there', () => {
    const mutable = env as { NODE_ENV: string };
    const original = mutable.NODE_ENV;
    mutable.NODE_ENV = 'production';
    try {
      expect(() => UsersModule.forRoot()).toThrow(/No production mail adapter/);
    } finally {
      mutable.NODE_ENV = original;
    }
  });
});
