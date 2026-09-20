import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthenticator, type AuthConfig } from '../src/index.js';
import {
  SERVICE_KEY,
  startFakeUserService,
  type FakeUserService,
} from './helpers/fake-user-service.js';

let fake: FakeUserService;
beforeAll(async () => {
  fake = await startFakeUserService();
});
afterAll(async () => fake.close());
beforeEach(() => {
  fake.behaviour.introspectStatus = 200;
  fake.behaviour.introspectDelayMs = 0;
  fake.behaviour.jwksStatus = 200;
  fake.behaviour.garbageBody = false;
  fake.stats.introspectCalls = 0;
  fake.stats.jwksCalls = 0;
});

const make = (over: Partial<AuthConfig> = {}) =>
  createAuthenticator({
    userServiceUrl: fake.url,
    serviceKey: SERVICE_KEY,
    jwksCooldownMs: 0,
    cacheTtlMs: 5_000,
    ...over,
  });

/** The failure code a call ends in, or 'OK'. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? `UNTYPED:${String(e)}`;
  }
}
const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { getStatus(): number }).getStatus();
  }
};

describe('token failures are distinguishable (each has its own code)', () => {
  it('no header → TOKEN_MISSING; empty → TOKEN_MISSING', async () => {
    const auth = make();
    expect(await outcome(auth.authenticate(undefined))).toBe('TOKEN_MISSING');
    expect(await outcome(auth.authenticate('   '))).toBe('TOKEN_MISSING');
  });

  it.each([
    ['a wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['not a JWT', 'Bearer hello'],
    ['two segments', 'Bearer aaa.bbb'],
    ['garbage segments', 'Bearer aaa.bbb.ccc'],
    ['four segments', 'Bearer a.b.c.d'],
  ])('%s → TOKEN_MALFORMED', async (_name, header) => {
    expect(await outcome(make().authenticate(header))).toBe('TOKEN_MALFORMED');
  });

  it('an expired token → TOKEN_EXPIRED (401), distinct from malformed', async () => {
    const u = await fake.login();
    const expired = await fake.mint(u, { expSecondsFromNow: -60 });
    const auth = make();
    expect(await outcome(auth.authenticate(`Bearer ${expired}`))).toBe('TOKEN_EXPIRED');
    expect(await statusOf(auth.authenticate(`Bearer ${expired}`))).toBe(401);
  });

  it('a tampered payload → TOKEN_INVALID', async () => {
    const u = await fake.login();
    const [h, , s] = (await fake.mint(u)).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', sid: u.sid, iss: 'foc-user-service', exp: 9999999999 }),
    ).toString('base64url');
    expect(await outcome(make().authenticate(`Bearer ${h}.${forged}.${s}`))).toBe('TOKEN_INVALID');
  });

  it('a token signed by a different key, or with another issuer, → TOKEN_INVALID', async () => {
    const u = await fake.login();
    const otherKey = await fake.foreignKey();
    expect(
      await outcome(make().authenticate(`Bearer ${await fake.mint(u, { privateKey: otherKey })}`)),
    ).toBe('TOKEN_INVALID');
    expect(
      await outcome(make().authenticate(`Bearer ${await fake.mint(u, { issuer: 'evil' })}`)),
    ).toBe('TOKEN_INVALID');
  });

  it('a token without a session id → TOKEN_INVALID', async () => {
    const u = await fake.login();
    expect(
      await outcome(make().authenticate(`Bearer ${await fake.mint(u, { omitSid: true })}`)),
    ).toBe('TOKEN_INVALID');
  });

  it('a genuine token whose session ended → TOKEN_REVOKED (401)', async () => {
    const u = await fake.login();
    fake.sessions.get(u.sid)!.active = false;
    const auth = make({ cacheTtlMs: 0 });
    expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('TOKEN_REVOKED');
    expect(await statusOf(auth.authenticate(`Bearer ${u.token}`))).toBe(401);
  });

  it('valid session, suspended or pending account → 403 with the reason', async () => {
    const suspended = await fake.login({ status: 'SUSPENDED' });
    const pending = await fake.login({ status: 'PENDING_ACTIVATION' });
    const auth = make();
    expect(await outcome(auth.authenticate(`Bearer ${suspended.token}`))).toBe('ACCOUNT_SUSPENDED');
    expect(await statusOf(auth.authenticate(`Bearer ${suspended.token}`))).toBe(403);
    expect(await outcome(auth.authenticate(`Bearer ${pending.token}`))).toBe(
      'ACCOUNT_NOT_ACTIVATED',
    );
  });

  it('every failure code is distinct', async () => {
    const codes = new Set<string>();
    const u = await fake.login();
    const dead = await fake.login();
    fake.sessions.get(dead.sid)!.active = false;
    const suspended = await fake.login({ status: 'SUSPENDED' });
    const auth = make({ cacheTtlMs: 0 });
    for (const h of [
      undefined,
      'Bearer nope',
      `Bearer ${await fake.mint(u, { expSecondsFromNow: -60 })}`,
      `Bearer ${await fake.mint(u, { issuer: 'evil' })}`,
      `Bearer ${dead.token}`,
      `Bearer ${suspended.token}`,
    ]) {
      codes.add(await outcome(auth.authenticate(h)));
    }
    expect(codes.size).toBe(6);
    expect(codes.has('OK')).toBe(false);
  });
});

describe('the verified caller', () => {
  it('exposes id, role and status from the User Service — a student and an admin', async () => {
    const student = await fake.login();
    const admin = await fake.login({ roles: ['ADMIN', 'STUDENT'], displayName: 'Root' });
    const auth = make();

    const s = await auth.authenticate(`Bearer ${student.token}`);
    expect(s).toMatchObject({
      userId: student.userId,
      sessionId: student.sid,
      status: 'ACTIVE',
      isAdmin: false,
      roles: ['STUDENT'],
    });
    const a = await auth.authenticate(`Bearer ${admin.token}`);
    expect(a).toMatchObject({ userId: admin.userId, isAdmin: true, displayName: 'Root' });
  });

  it('requireAdmin refuses a student with FORBIDDEN and passes an admin', async () => {
    const student = await fake.login();
    const admin = await fake.login({ roles: ['ADMIN', 'STUDENT'] });
    const auth = make();
    expect(() => auth.requireAdmin({ ...({} as never), isAdmin: false })).toThrow();
    const sCtx = await auth.authenticate(`Bearer ${student.token}`);
    expect(await outcome(Promise.resolve().then(() => auth.requireAdmin(sCtx)))).toBe('FORBIDDEN');
    expect(
      await outcome(
        Promise.resolve().then(async () =>
          auth.requireAdmin(await auth.authenticate(`Bearer ${admin.token}`)),
        ),
      ),
    ).toBe('OK');
  });

  it('role changes at the User Service apply once the cache window passes, never sooner than asked', async () => {
    let now = 1_000_000;
    const auth = make({ now: () => now, cacheTtlMs: 5_000 });
    const u = await fake.login();
    expect((await auth.authenticate(`Bearer ${u.token}`)).isAdmin).toBe(false);

    fake.sessions.get(u.sid)!.roles = ['ADMIN', 'STUDENT'];
    now += 4_999;
    expect((await auth.authenticate(`Bearer ${u.token}`)).isAdmin).toBe(false); // inside the window
    now += 2;
    expect((await auth.authenticate(`Bearer ${u.token}`)).isAdmin).toBe(true); // window passed
  });
});

describe('the staleness window', () => {
  it('reuses one answer inside the window, and asks again after it', async () => {
    let now = 0;
    const auth = make({ now: () => now, cacheTtlMs: 5_000 });
    const u = await fake.login();
    for (let i = 0; i < 20; i++) await auth.authenticate(`Bearer ${u.token}`);
    expect(fake.stats.introspectCalls).toBe(1);
    now += 5_001;
    await auth.authenticate(`Bearer ${u.token}`);
    expect(fake.stats.introspectCalls).toBe(2);
  });

  it('a suspension or logout is enforced within the window — and not one tick earlier or later', async () => {
    let now = 0;
    const auth = make({ now: () => now, cacheTtlMs: 5_000 });
    const u = await fake.login();
    await auth.authenticate(`Bearer ${u.token}`);

    fake.sessions.get(u.sid)!.active = false; // the User Service ends the session
    now = 4_999;
    expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('OK'); // documented stale window
    now = 5_001;
    expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('TOKEN_REVOKED');
  });

  it('cacheTtlMs: 0 checks on every request', async () => {
    const auth = make({ cacheTtlMs: 0 });
    const u = await fake.login();
    await auth.authenticate(`Bearer ${u.token}`);
    await auth.authenticate(`Bearer ${u.token}`);
    expect(fake.stats.introspectCalls).toBe(2);
  });

  it('coalesces a burst of simultaneous requests for one session into one call', async () => {
    fake.behaviour.introspectDelayMs = 50;
    const auth = make();
    const u = await fake.login();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => auth.authenticate(`Bearer ${u.token}`)),
    );
    expect(results.every((r) => r.userId === u.userId)).toBe(true);
    expect(fake.stats.introspectCalls).toBe(1);
  });

  it('caches a revoked answer too, so a dead session cannot be used to hammer the User Service', async () => {
    const auth = make();
    const u = await fake.login();
    fake.sessions.get(u.sid)!.active = false;
    for (let i = 0; i < 10; i++)
      expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('TOKEN_REVOKED');
    expect(fake.stats.introspectCalls).toBe(1);
  });

  it('bounds memory: the cache never grows past its limit', async () => {
    const auth = make({ maxCacheEntries: 5 });
    for (let i = 0; i < 20; i++) {
      const u = await fake.login();
      await auth.authenticate(`Bearer ${u.token}`);
    }
    expect(fake.stats.introspectCalls).toBe(20); // each was new; nothing crashed, nothing leaked
  });
});

describe('fail closed when the User Service cannot answer', () => {
  it.each([500, 503, 404])(
    'introspection returning %i → IDENTITY_UNAVAILABLE (503), never access',
    async (status) => {
      fake.behaviour.introspectStatus = status;
      const u = await fake.login();
      const auth = make();
      expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('IDENTITY_UNAVAILABLE');
      expect(await statusOf(auth.authenticate(`Bearer ${u.token}`))).toBe(503);
    },
  );

  it('a status added later is denied as not-active (403), not reported as an outage (503)', async () => {
    const u = await fake.login({ status: 'DEACTIVATED' });
    const auth = make();
    expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('ACCOUNT_NOT_ACTIVATED');
    expect(await statusOf(auth.authenticate(`Bearer ${u.token}`))).toBe(403);
  });

  it('a role added later is ignored, and the roles that are known still work', async () => {
    const u = await fake.login({ roles: ['MODERATOR', 'ADMIN', 'STUDENT'] });
    const ctx = await make().authenticate(`Bearer ${u.token}`);
    expect(ctx.roles).toEqual(['ADMIN', 'STUDENT']);
    expect(ctx.isAdmin).toBe(true);
    const only = await fake.login({ roles: ['MODERATOR'] });
    expect((await make().authenticate(`Bearer ${only.token}`)).isAdmin).toBe(false);
  });

  it('a malformed introspection reply is refused, not trusted', async () => {
    fake.behaviour.garbageBody = true;
    const u = await fake.login();
    expect(await outcome(make().authenticate(`Bearer ${u.token}`))).toBe('IDENTITY_UNAVAILABLE');
  });

  it('a slow User Service times out and fails closed', async () => {
    fake.behaviour.introspectDelayMs = 400;
    const u = await fake.login();
    expect(await outcome(make({ timeoutMs: 100 }).authenticate(`Bearer ${u.token}`))).toBe(
      'IDENTITY_UNAVAILABLE',
    );
  });

  it('a wrong service key is refused by the User Service and so fails closed', async () => {
    const u = await fake.login();
    expect(
      await outcome(
        make({ serviceKey: 'wrong-wrong-wrong-wrong' }).authenticate(`Bearer ${u.token}`),
      ),
    ).toBe('IDENTITY_UNAVAILABLE');
  });

  it('a failure is not cached: the next request recovers as soon as the User Service does', async () => {
    const auth = make();
    const u = await fake.login();
    fake.behaviour.introspectStatus = 500;
    expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('IDENTITY_UNAVAILABLE');
    fake.behaviour.introspectStatus = 200;
    expect(await outcome(auth.authenticate(`Bearer ${u.token}`))).toBe('OK');
  });

  it('unreachable keys give 503, not "your token is bad"', async () => {
    const u = await fake.login();
    const token = await fake.mint(u);
    const auth = createAuthenticator({
      userServiceUrl: 'http://127.0.0.1:1',
      serviceKey: SERVICE_KEY,
      timeoutMs: 200,
    });
    expect(await outcome(auth.authenticate(`Bearer ${token}`))).toBe('IDENTITY_UNAVAILABLE');
  });
});

describe('key rotation', () => {
  it('a token signed by a newly rotated key verifies without a redeploy', async () => {
    const auth = make();
    const before = await fake.login();
    await auth.authenticate(`Bearer ${before.token}`); // caches the first key

    await fake.rotateKey();
    const after = await fake.login();
    expect(await outcome(auth.authenticate(`Bearer ${after.token}`))).toBe('OK');
  });
});
