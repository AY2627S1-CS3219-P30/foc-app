import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { usersRepository } from '../src/users/users.repository.js';
import { createTestApp, openLimiters, type TestApp } from './helpers/app.js';
import {
  activeStudent,
  bearer,
  changePassword,
  http,
  login,
  ORIGIN,
  PASSWORD,
  seededAdmin,
  TRUNCATE_ALL,
} from './helpers/actors.js';

let t: TestApp;
const EMAIL = 'e0123456@u.nus.edu';
const NEW_PASSWORD = 'a-brand-new-passphrase';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(TRUNCATE_ALL);
});

describe('POST /auth/password', () => {
  it('replaces the password: the new one signs in, the old one does not', async () => {
    await activeStudent(t, EMAIL);
    await changePassword(t, EMAIL, PASSWORD, NEW_PASSWORD).expect(204);
    await login(t, EMAIL, NEW_PASSWORD);
    const old = await http(t)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(401);
    expect(old.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('ends every existing session: whoever knew the old password may hold one', async () => {
    const before = await activeStudent(t, EMAIL);
    await changePassword(t, EMAIL, PASSWORD, NEW_PASSWORD).expect(204);

    await http(t).get('/users/me').set('Authorization', bearer(before)).expect(401);
    await http(t)
      .post('/auth/refresh')
      .set('Cookie', before.cookie)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(401);
  });

  it('a login that verified the old password just before a change starts no session', async () => {
    await activeStudent(t, EMAIL);
    // What a login in flight read before the change committed: the old hash, which it then verifies.
    const stale = await usersRepository.findCredentials(t.orm, EMAIL);
    await changePassword(t, EMAIL, PASSWORD, NEW_PASSWORD).expect(204);

    const read = vi.spyOn(usersRepository, 'findCredentials').mockResolvedValueOnce(stale);
    try {
      const res = await http(t)
        .post('/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }
    const live = await t.db.query('SELECT 1 FROM refresh_sessions WHERE revoked_at IS NULL');
    expect(live.rows).toHaveLength(0);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    await activeStudent(t, EMAIL);
    const wrong = await changePassword(t, EMAIL, 'not-the-password', NEW_PASSWORD).expect(401);
    const unknown = await changePassword(t, 'nobody@u.nus.edu', PASSWORD, NEW_PASSWORD).expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('refuses a new password equal to the current one, or outside the policy', async () => {
    await activeStudent(t, EMAIL);
    const same = await changePassword(t, EMAIL, PASSWORD, PASSWORD).expect(422);
    expect(same.body.error.details).toEqual([
      expect.objectContaining({ field: 'newPassword', code: 'PASSWORD_UNCHANGED' }),
    ]);

    const short = await changePassword(t, EMAIL, PASSWORD, 'short').expect(422);
    expect(short.body.error.details[0].field).toBe('newPassword');
    // Nothing changed: the original password still signs in.
    await login(t, EMAIL, PASSWORD);
  });

  it('refuses a suspended account, after the password is proven', async () => {
    const admin = await seededAdmin(t, 'root@u.nus.edu');
    const student = await activeStudent(t, EMAIL);
    await http(t)
      .post(`/admin/users/${student.id}/suspend`)
      .set('Authorization', bearer(admin))
      .send({ reason: 'abuse' })
      .expect(200);
    const res = await changePassword(t, EMAIL, PASSWORD, NEW_PASSWORD).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('rejects a foreign origin and a non-JSON body like login does', async () => {
    await activeStudent(t, EMAIL);
    const foreign = await http(t)
      .post('/auth/password')
      .set('Origin', 'https://evil.example')
      .send({ email: EMAIL, currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(403);
    expect(foreign.body.error.code).toBe('CSRF_REJECTED');
    await http(t)
      .post('/auth/password')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`email=${EMAIL}&currentPassword=${PASSWORD}&newPassword=${NEW_PASSWORD}`)
      .expect(403);
  });

  it('shares the login rate limit per email', async () => {
    const strict = await createTestApp({
      rateLimiters: { ...openLimiters(), loginPerEmail: new RateLimiter(2, 60_000) },
    });
    try {
      const attempt = () =>
        http(strict)
          .post('/auth/password')
          .set('Origin', ORIGIN)
          .send({ email: EMAIL, currentPassword: 'guess-guess-guess', newPassword: NEW_PASSWORD });
      await attempt().expect(401);
      await attempt().expect(401);
      const limited = await attempt().expect(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.headers['retry-after']).toBeDefined();
    } finally {
      await strict.close();
    }
  });
});
