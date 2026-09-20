import { createPublicKey } from 'node:crypto';
import { decodeJwt, importJWK, jwtVerify } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { createTestApp, openLimiters, validRegistration, type TestApp } from './helpers/app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const EMAIL = 'e0123456@u.nus.edu';
const PASSWORD = validRegistration().password;
const ORIGIN = 'http://localhost:3000'; // the default CORS_ORIGINS

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

async function activeUser(email = EMAIL) {
  await http().post('/auth/register').send(validRegistration(email)).expect(201);
  await http()
    .post('/auth/activate')
    .send({ token: t.mailbox.latestFor(email)!.token })
    .expect(200);
}

const login = (email = EMAIL, password = PASSWORD) =>
  http().post('/auth/login').send({ email, password });

/** The raw `foc_refresh=<token>` pair from a Set-Cookie header. */
function refreshCookie(res: request.Response): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = raw.find((c) => c.startsWith('foc_refresh='));
  expect(line, 'expected a foc_refresh cookie').toBeTruthy();
  return line!.split(';')[0]!;
}
const tokenOf = (cookie: string) => cookie.slice('foc_refresh='.length);

const refresh = (cookie: string) =>
  http()
    .post('/auth/refresh')
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json');
const logout = (cookie: string) =>
  http()
    .post('/auth/logout')
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json');
const me = (accessToken: string) =>
  http().get('/users/me').set('Authorization', `Bearer ${accessToken}`);

describe('POST /auth/login', () => {
  it('returns a 15-minute access token and sets a hardened refresh cookie', async () => {
    await activeUser();
    const res = await login().expect(200);

    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(res.body.user).toMatchObject({
      displayName: 'Alex Tan',
      roles: ['STUDENT'],
      status: 'ACTIVE',
    });
    expect(res.body.refreshToken).toBeUndefined(); // cookie only, never in the body

    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join('\n');
    expect(setCookie).toMatch(/foc_refresh=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/auth/i);

    const claims = decodeJwt(res.body.accessToken);
    expect(claims.exp! - claims.iat!).toBe(900);
  });

  it('puts only sub, sid, iss, jti, iat and exp in the token — no role or status', async () => {
    await activeUser();
    const res = await login().expect(200);
    const claims = decodeJwt(res.body.accessToken);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
    expect(claims.sub).toBe(res.body.user.id);
  });

  it('can be verified by another service using only the public JWKS', async () => {
    await activeUser();
    const { accessToken } = (await login().expect(200)).body;
    const { keys } = (await http().get('/.well-known/jwks.json').expect(200)).body;
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('d'); // no private material

    const key = await importJWK(keys[0], 'EdDSA');
    const { payload } = await jwtVerify(accessToken, key, { algorithms: ['EdDSA'] });
    expect(payload.sub).toBeTruthy();
    // and a token signed by anyone else does not verify
    const other = createPublicKey({ key: keys[0], format: 'jwk' });
    expect(other.asymmetricKeyType).toBe('ed25519');
  });

  it('stores only a hash of the refresh token', async () => {
    await activeUser();
    const token = tokenOf(refreshCookie(await login().expect(200)));
    const rows = (await t.db.query('SELECT token_hash FROM refresh_sessions')).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('gives an unknown email and a wrong password the same response', async () => {
    await activeUser();
    const wrong = await login(EMAIL, 'definitely-wrong-password').expect(401);
    const unknown = await login('nobody@u.nus.edu', PASSWORD).expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    expect((await t.db.query('SELECT 1 FROM refresh_sessions')).rows).toHaveLength(0);
  });

  it('refuses a pending account, but only after the password is proven', async () => {
    await http().post('/auth/register').send(validRegistration()).expect(201);
    const ok = await login().expect(403);
    expect(ok.body.error.code).toBe('ACCOUNT_NOT_ACTIVATED');
    const bad = await login(EMAIL, 'wrong-wrong-wrong').expect(401); // does not reveal the account exists
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a suspended account and issues no session', async () => {
    await activeUser();
    await t.db.exec("UPDATE users SET status = 'SUSPENDED'");
    const res = await login().expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await t.db.query('SELECT 1 FROM refresh_sessions')).rows).toHaveLength(0);
  });

  it('accepts a differently-cased, padded email', async () => {
    await activeUser();
    await login('  E0123456@U.NUS.EDU ').expect(200);
  });

  it('validates the body', async () => {
    await http().post('/auth/login').send({}).expect(422);
    await http()
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD, admin: true })
      .expect(422);
  });
});

describe('GET /users/me (access-token guard)', () => {
  it('returns the caller’s account for a valid token', async () => {
    await activeUser();
    const { accessToken } = (await login().expect(200)).body;
    const res = await me(accessToken).expect(200);
    expect(res.body).toMatchObject({
      email: EMAIL,
      roles: ['STUDENT'],
      status: 'ACTIVE',
      profile: { displayName: 'Alex Tan', preferredMode: 'REQUESTER', contactPreference: 'IN_APP' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|argon2|password/i);
  });

  it('rejects a missing, malformed or forged token', async () => {
    await http().get('/users/me').expect(401);
    await me('not.a.jwt').expect(401);
    await activeUser();
    const { accessToken } = (await login().expect(200)).body;
    const [h, , s] = accessToken.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...decodeJwt(accessToken), sub: 'someone-else' }),
    ).toString('base64url');
    await me(`${h}.${forgedPayload}.${s}`).expect(401);
  });

  it('accepts a token just inside its 15 minutes and rejects it just after', async () => {
    await activeUser();
    const { accessToken } = (await login().expect(200)).body;
    // Only Date is faked, so HTTP and the database keep working while the token ages.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const issuedAt = Date.now();
      vi.setSystemTime(issuedAt + 14 * 60_000);
      await me(accessToken).expect(200);
      vi.setSystemTime(issuedAt + 16 * 60_000);
      await me(accessToken).expect(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 403 for a suspended account’s live token', async () => {
    await activeUser();
    const { accessToken } = (await login().expect(200)).body;
    await t.db.exec("UPDATE users SET status = 'SUSPENDED'");
    const res = await me(accessToken).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('POST /auth/refresh — rotation', () => {
  it('issues a new token and invalidates the old one', async () => {
    await activeUser();
    const first = refreshCookie(await login().expect(200));
    const res = await refresh(first).expect(200);
    const second = refreshCookie(res);

    expect(second).not.toBe(first);
    expect(res.body.accessToken).toBeTruthy();
    await me(res.body.accessToken).expect(200);

    const rows = (
      await t.db.query('SELECT rotated_at, family_id FROM refresh_sessions ORDER BY issued_at')
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rotated_at).not.toBeNull();
    expect(rows[1]!.rotated_at).toBeNull();
    expect(rows[0]!.family_id).toBe(rows[1]!.family_id);
  });

  it('kills the whole family when a rotated token is reused', async () => {
    await activeUser();
    const first = refreshCookie(await login().expect(200));
    const second = refreshCookie(await refresh(first).expect(200));
    const third = refreshCookie(await refresh(second).expect(200));

    // an attacker replays the very first token
    const replay = await refresh(first).expect(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // the legitimate holder's *current* token is now dead too — not just the replayed one
    const after = await refresh(third).expect(401);
    expect(after.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    const live = (await t.db.query('SELECT 1 FROM refresh_sessions WHERE revoked_at IS NULL')).rows;
    expect(live).toHaveLength(0);
  });

  it('does not touch another login’s family', async () => {
    await activeUser();
    const a = refreshCookie(await login().expect(200));
    const b = refreshCookie(await login().expect(200));
    await refresh(a).expect(200);
    await refresh(a).expect(401); // reuse in A's family
    await refresh(b).expect(200); // B unaffected
  });

  it('serialises concurrent use of one token: one wins, the rest are treated as reuse', async () => {
    await activeUser();
    const first = refreshCookie(await login().expect(200));
    const results = await Promise.all(Array.from({ length: 4 }, () => refresh(first)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401).length).toBeGreaterThanOrEqual(1);
  });

  it('denies a missing, unknown, expired or revoked token', async () => {
    await activeUser();
    await http()
      .post('/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(401);
    await refresh('foc_refresh=' + 'z'.repeat(43)).expect(401);

    const cookie = refreshCookie(await login().expect(200));
    await t.db.exec("UPDATE refresh_sessions SET expires_at = now() - interval '1 minute'");
    const expired = await refresh(cookie).expect(401);
    expect(expired.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    const fresh = refreshCookie(await login().expect(200));
    await t.db.exec('UPDATE refresh_sessions SET revoked_at = now()');
    await refresh(fresh).expect(401);
  });

  it('refuses to refresh once the account is suspended, and revokes the family', async () => {
    await activeUser();
    const cookie = refreshCookie(await login().expect(200));
    await t.db.exec("UPDATE users SET status = 'SUSPENDED'");
    const res = await refresh(cookie).expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(
      (await t.db.query('SELECT 1 FROM refresh_sessions WHERE revoked_at IS NULL')).rows,
    ).toHaveLength(0);
  });

  it('clears the cookie when the session is dead', async () => {
    const res = await http()
      .post('/auth/refresh')
      .set('Cookie', 'foc_refresh=' + 'q'.repeat(43))
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(401);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).join()).toMatch(
      /foc_refresh=;/,
    );
  });
});

describe('CSRF defence on the cookie endpoints', () => {
  it('rejects a foreign Origin', async () => {
    await activeUser();
    const cookie = refreshCookie(await login().expect(200));
    const res = await http()
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'application/json')
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    await http()
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'application/json')
      .expect(403);
    await refresh(cookie).expect(200); // the rejected attempts did not burn or revoke the session
  });

  it('rejects a non-JSON content type (a plain HTML form post)', async () => {
    await activeUser();
    const cookie = refreshCookie(await login().expect(200));
    await http()
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(403);
  });
});

describe('POST /auth/logout', () => {
  it('kills the refresh session and the access token immediately', async () => {
    await activeUser();
    const res = await login().expect(200);
    const cookie = refreshCookie(res);
    await me(res.body.accessToken).expect(200);

    await logout(cookie).expect(204);

    await refresh(cookie).expect(401);
    await me(res.body.accessToken).expect(401); // not "within 15 minutes" — now
  });

  it('revokes the whole family, including tokens issued by earlier rotations', async () => {
    await activeUser();
    const first = refreshCookie(await login().expect(200));
    const rotated = await refresh(first).expect(200);
    await logout(refreshCookie(rotated)).expect(204);
    await me(rotated.body.accessToken).expect(401);
    expect(
      (await t.db.query('SELECT 1 FROM refresh_sessions WHERE revoked_at IS NULL')).rows,
    ).toHaveLength(0);
  });

  it('is idempotent and clears the cookie, even with no session', async () => {
    const res = await http()
      .post('/auth/logout')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(204);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).join()).toMatch(
      /foc_refresh=;/,
    );
  });
});

describe('rate limiting', () => {
  it('limits login attempts per email and reports Retry-After', async () => {
    const strict = createTestApp({
      rateLimiters: { ...openLimiters(), loginPerEmail: new RateLimiter(3, 60_000) },
    });
    const s = await strict;
    try {
      const post = () =>
        request(s.app.getHttpServer())
          .post('/auth/login')
          .send({ email: EMAIL, password: 'wrong-wrong-wrong' });
      for (let i = 0; i < 3; i++) await post().expect(401);
      const blocked = await post().expect(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // a different email is unaffected
      await request(s.app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'other@u.nus.edu', password: 'wrong-wrong-wrong' })
        .expect(401);
    } finally {
      await s.close();
    }
  });

  it('limits login attempts per IP, whatever the email', async () => {
    const s = await createTestApp({
      rateLimiters: { ...openLimiters(), loginPerIp: new RateLimiter(2, 60_000) },
    });
    try {
      const post = (email: string) =>
        request(s.app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: 'wrong-wrong-wrong' });
      await post('a@u.nus.edu').expect(401);
      await post('b@u.nus.edu').expect(401);
      await post('c@u.nus.edu').expect(429);
    } finally {
      await s.close();
    }
  });

  it('limits registrations per IP', async () => {
    const s = await createTestApp({
      rateLimiters: { ...openLimiters(), registerPerIp: new RateLimiter(1, 60_000) },
    });
    try {
      const post = (email: string) =>
        request(s.app.getHttpServer()).post('/auth/register').send(validRegistration(email));
      await post('a@u.nus.edu').expect(201);
      await post('b@u.nus.edu').expect(429);
    } finally {
      await s.close();
    }
  });
});

describe('RateLimiter', () => {
  it('resets after its window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(true);
    const blocked = limiter.hit('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    now = 1001;
    expect(limiter.hit('k').allowed).toBe(true);
  });
});
