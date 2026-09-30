import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The same wire-level User Service double auth-client's own suite uses: a real JWKS endpoint, real
// Ed25519-signed tokens and `/internal/introspect` over HTTP. Imported by path, as auth-client
// itself imports the User Service's helpers (decisions.md K9).
import {
  SERVICE_KEY,
  startFakeUserService,
  type FakeUserService,
} from '../../auth-client/test/helpers/fake-user-service.js';
import { createTestApp, http, validSupplier, type TestApp } from './helpers/app.js';

/**
 * USR-06 acceptance: Supplier's admin endpoints reject a student token and accept an admin token
 * using only `@foc/auth-client` — no authenticator double, no token parsing in this service.
 */
let fake: FakeUserService;
let t: TestApp;

beforeAll(async () => {
  fake = await startFakeUserService();
  t = await createTestApp({
    auth: {
      userServiceUrl: fake.url,
      serviceKey: SERVICE_KEY,
      // Ask the User Service on every request, so a change to a session shows on the very next
      // call. Production keeps the default: identity is cached for up to 5 s, so a suspension,
      // demotion or logout is enforced there within that staleness window (auth-client README).
      cacheTtlMs: 0,
    },
  });
});
afterAll(async () => {
  // Close the fake even if the app fails to (or never started), so its socket never leaks.
  try {
    await t?.close();
  } finally {
    await fake?.close();
  }
});

const bearer = (token: string) => `Bearer ${token}`;

const countSuppliers = async (): Promise<number> =>
  Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM suppliers')).rows[0]!.n);

describe('Supplier Service with the real @foc/auth-client (USR-06)', () => {
  it('rejects a student token on create and accepts an admin token', async () => {
    const student = await fake.login();
    const admin = await fake.login({ roles: ['ADMIN', 'STUDENT'] });
    const before = await countSuppliers();

    const denied = await http(t)
      .post('/suppliers')
      .set('Authorization', bearer(student.token))
      .send(validSupplier())
      .expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(await countSuppliers()).toBe(before);

    const created = await http(t)
      .post('/suppliers')
      .set('Authorization', bearer(admin.token))
      .send(validSupplier())
      .expect(201);
    expect(created.body.name).toBe('Test Kopitiam');
  });

  it('lets a student read, and refuses a student on update and deactivate', async () => {
    const student = await fake.login();
    const admin = await fake.login({ roles: ['ADMIN', 'STUDENT'] });
    const created = await http(t)
      .post('/suppliers')
      .set('Authorization', bearer(admin.token))
      .send(validSupplier({ name: 'Read Only Cafe' }))
      .expect(201);
    const id = created.body.supplierId as string;

    await http(t).get(`/suppliers/${id}`).set('Authorization', bearer(student.token)).expect(200);
    const put = await http(t)
      .put(`/suppliers/${id}`)
      .set('Authorization', bearer(student.token))
      .set('If-Match', `"${created.body.version}"`)
      .send({ name: 'Hijacked' })
      .expect(403);
    const del = await http(t)
      .delete(`/suppliers/${id}`)
      .set('Authorization', bearer(student.token))
      .set('If-Match', `"${created.body.version}"`)
      .expect(403);
    expect(put.body.error.code).toBe('FORBIDDEN');
    expect(del.body.error.code).toBe('FORBIDDEN');

    // Neither refused write landed: the supplier is exactly as created, and still active.
    const after = await http(t)
      .get(`/suppliers/${id}`)
      .set('Authorization', bearer(student.token))
      .expect(200);
    expect(after.body).toEqual(created.body);
    expect(after.body.active).toBe(true);
  });

  it('reports an expired and a malformed token as distinct codes in the shared envelope', async () => {
    const who = fake.addSession({ roles: ['ADMIN', 'STUDENT'] });
    const expired = await fake.mint(who, { expSecondsFromNow: -60 });

    const a = await http(t).get('/suppliers').set('Authorization', bearer(expired)).expect(401);
    const b = await http(t).get('/suppliers').set('Authorization', 'Bearer not.a-jwt').expect(401);
    expect(a.body.error.code).toBe('TOKEN_EXPIRED');
    expect(b.body.error.code).toBe('TOKEN_MALFORMED');
    for (const res of [a, b]) {
      expect(res.body.error).toEqual(
        expect.objectContaining({ message: expect.any(String), correlationId: expect.any(String) }),
      );
    }
  });

  it('refuses an admin token with a forged signature or a foreign issuer', async () => {
    // A live admin session: only the token's signature or issuer can be wrong here.
    const admin = fake.addSession({ roles: ['ADMIN', 'STUDENT'] });
    const forged = await fake.mint(admin, { privateKey: await fake.foreignKey() });
    const foreign = await fake.mint(admin, { issuer: 'not-foc-user-service' });
    const before = await countSuppliers();

    for (const token of [forged, foreign]) {
      const res = await http(t)
        .post('/suppliers')
        .set('Authorization', bearer(token))
        .send(validSupplier({ name: 'Forged Cafe' }))
        .expect(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    }
    expect(await countSuppliers()).toBe(before);

    // Control: a genuine token for the same session is accepted.
    await http(t)
      .post('/suppliers')
      .set('Authorization', bearer(await fake.mint(admin)))
      .send(validSupplier({ name: 'Genuine Cafe' }))
      .expect(201);
  });

  it('refuses a suspended admin and a revoked session, whatever the token still says', async () => {
    const suspended = await fake.login({ roles: ['ADMIN', 'STUDENT'], status: 'SUSPENDED' });
    const s = await http(t)
      .post('/suppliers')
      .set('Authorization', bearer(suspended.token))
      .send(validSupplier({ name: 'Suspended Cafe' }))
      .expect(403);
    expect(s.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const loggedOut = await fake.login({ roles: ['ADMIN', 'STUDENT'] });
    fake.sessions.get(loggedOut.sid)!.active = false;
    const r = await http(t)
      .post('/suppliers')
      .set('Authorization', bearer(loggedOut.token))
      .send(validSupplier({ name: 'Revoked Cafe' }))
      .expect(401);
    expect(r.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('refuses an admin suspended, demoted or logged out after a successful write', async () => {
    const admin = await fake.login({ roles: ['ADMIN', 'STUDENT'] });
    const session = fake.sessions.get(admin.sid)!;
    // The same, still-unexpired token throughout; only the User Service's answer changes.
    const create = (name: string) =>
      http(t)
        .post('/suppliers')
        .set('Authorization', bearer(admin.token))
        .send(validSupplier({ name }));

    await create('Before Cafe').expect(201);
    const before = await countSuppliers();

    session.status = 'SUSPENDED';
    expect((await create('Suspended Later Cafe').expect(403)).body.error.code).toBe(
      'ACCOUNT_SUSPENDED',
    );
    session.status = 'ACTIVE';

    session.roles = ['STUDENT'];
    expect((await create('Demoted Cafe').expect(403)).body.error.code).toBe('FORBIDDEN');
    session.roles = ['ADMIN', 'STUDENT'];

    session.active = false;
    expect((await create('Logged Out Cafe').expect(401)).body.error.code).toBe('TOKEN_REVOKED');

    expect(await countSuppliers()).toBe(before);
  });

  it('ignores any role a client claims in a header or body', async () => {
    const student = await fake.login();
    const before = await countSuppliers();
    for (const h of ['x-role', 'x-user-role', 'x-user-roles', 'x-roles', 'x-admin', 'role']) {
      const res = await http(t)
        .post('/suppliers')
        .set('Authorization', bearer(student.token))
        .set(h, 'ADMIN')
        .send({ ...validSupplier({ name: 'Header Cafe' }), role: 'ADMIN', isAdmin: true })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(await countSuppliers()).toBe(before);
  });
});
