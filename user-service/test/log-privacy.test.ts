import { Logger } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** An email address, plain or URL-encoded. */
const EMAIL = /[a-z0-9._%+-]+(@|%40)[a-z0-9.-]+\.[a-z]{2,}/i;
/**
 * Captured lines holding an email address. Every test checks the whole capture, not only its own
 * lines, so an address logged on an earlier path (a 409, a 422, a replay) fails the run too.
 */
const linesWithEmail = () => lines.filter((line) => EMAIL.test(line));

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ logLevel: 'trace', logDestination: sink });
});
afterAll(async () => {
  await t.close();
});

/**
 * Proves the scans below can fail. The first version of this suite never saw Nest's `Logger`
 * output (decisions.md §12 L3), so a logged email passed it.
 */
describe('the log capture', () => {
  it("receives Nest's Logger output, and the email pattern finds an address in it", () => {
    const start = lines.length;
    new Logger('probe').log('log-capture canary probe@u.nus.edu');
    new Logger('probe').warn('log-capture canary probe%40u.nus.edu');
    // Taken back out, so the scans below judge only what the service itself logged.
    const probe = lines.splice(start);

    expect(probe).toHaveLength(2);
    for (const line of probe) {
      expect(line).toContain('log-capture canary');
      expect(line).toMatch(EMAIL);
    }
  });
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
    expect(linesWithEmail()).toEqual([]);
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
    const wrongPassword = 'wrong-password-here';
    const refusedNewPassword = 'x'.repeat(12);
    await login(studentEmail, wrongPassword).expect(401);
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
        currentPassword: wrongPassword,
        newPassword: refusedNewPassword,
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
    await http()
      .patch('/users/me')
      .set('Authorization', admin)
      .send({ email: 'x@u.nus.edu' })
      .expect(422);
    await http().get('/admin/users').set('Authorization', student).expect(403);
    await http()
      .get(`/admin/users?q=${encodeURIComponent(studentEmail)}`)
      .set('Authorization', admin)
      .expect(200);
    await http().get(`/admin/users/${studentId}`).set('Authorization', admin).expect(200);
    // An address in the path, where the query-string strip does not reach: raw, encoded, and on
    // a route that does not exist.
    await http().get(`/admin/users/${studentEmail}`).set('Authorization', admin).expect(422);
    await http()
      .get(`/admin/users/${encodeURIComponent(studentEmail)}`)
      .set('Authorization', admin)
      .expect(422);
    await http().get(`/no-such-route/${studentEmail}`).expect(404);
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

    const output = lines.join('');
    // Every request line carries a correlation id, so a request can still be traced without the
    // email.
    const requestLines = lines
      .map((line) => JSON.parse(line) as { msg?: string; correlationId?: unknown })
      .filter((line) => line.msg === 'request completed');
    expect(requestLines.length).toBeGreaterThan(30);
    for (const line of requestLines) expect(line.correlationId).toEqual(expect.any(String));

    const hashes = (await t.db.query<{ password_hash: string }>('SELECT password_hash FROM users'))
      .rows;
    const refreshValue = (res: request.Response) => cookieOf(res).slice('foc_refresh='.length);
    const secrets = [
      password,
      adminPassword,
      wrongPassword,
      refusedNewPassword,
      activation,
      studentLogin.body.accessToken,
      adminLogin.body.accessToken,
      rotated.body.accessToken,
      studentAgain.body.accessToken,
      refreshValue(studentLogin),
      refreshValue(rotated),
      refreshValue(adminLogin),
      refreshValue(studentAgain),
      SERVICE_KEY,
      validRegistration().displayName,
      ...hashes.map((h) => h.password_hash),
    ];
    for (const secret of secrets) expect(output).not.toContain(secret);
    // No email address of any kind, in plain or URL-encoded form, anywhere in the capture.
    expect(linesWithEmail()).toEqual([]);
  });

  it('logs an unhandled error without the row PostgreSQL quotes or the address a mailer names', async () => {
    const start = lines.length;
    const http = () => request(t.app.getHttpServer());
    const address = 'leaky.student@u.nus.edu';
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';

    // What node-postgres raises on a unique violation: the offending row is in `detail`, and
    // `where` can quote the statement.
    const uniqueViolation = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_lower_key"'),
      {
        code: '23505',
        severity: 'ERROR',
        table: 'users',
        constraint: 'users_email_lower_key',
        detail: `Key (lower(email))=(${address}) already exists.`,
        where: `SQL statement "INSERT INTO users VALUES ('${address}', '${hash}')"`,
      },
    );
    const query = vi.spyOn(t.db, 'query').mockRejectedValueOnce(uniqueViolation);
    await http()
      .get(`/internal/users/${randomUUID()}`)
      .set('x-service-key', SERVICE_KEY)
      .expect(500);
    query.mockRestore();

    // A mail provider's rejection names the recipient in its message.
    const send = vi
      .spyOn(t.mailbox, 'sendActivation')
      .mockRejectedValueOnce(new Error(`550 5.1.1 <${address}>: Recipient address rejected`));
    await http().post('/auth/register').send(validRegistration(address)).expect(500);
    send.mockRestore();

    // Both were logged, with what locates them, so the scan below is not vacuous.
    const logged = lines
      .slice(start)
      .map((line) => JSON.parse(line) as { context?: string; err?: Record<string, unknown> })
      .filter((line) => line.context === 'ErrorEnvelopeFilter');
    expect(logged.map((line) => line.err)).toEqual([
      expect.objectContaining({
        code: '23505',
        table: 'users',
        constraint: 'users_email_lower_key',
      }),
      expect.objectContaining({ message: '550 5.1.1 <[email]>: Recipient address rejected' }),
    ]);
    expect(linesWithEmail()).toEqual([]);
    expect(lines.join('')).not.toContain(hash);
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
