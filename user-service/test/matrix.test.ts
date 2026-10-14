import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SERVICE_KEY, type TestApp } from './helpers/app.js';
import {
  activeStudent,
  bearer,
  http,
  login,
  seededAdmin,
  ORIGIN,
  PASSWORD,
  type Actor,
} from './helpers/actors.js';

/**
 * The actor–resource–action matrix (US-NFR1.1.1). Every protected endpoint is
 * called as four actors — unauthenticated, active student, suspended student,
 * administrator — and any unauthorised success fails the suite.
 */

interface Endpoint {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch';
  path: (ids: { target: string; request: string }) => string;
  body?: object;
  /** Who is allowed a success (2xx). Everyone else must be refused (401/403). */
  allowed: 'student' | 'admin';
  /**
   * For an action on a record the matrix cannot set up, the status an administrator gets instead of
   * a success. It must still not be 401 or 403: authorization let them through.
   */
  adminStatus?: number;
}

/** A well-formed request id that matches nothing. */
const UNKNOWN_REQUEST = randomUUID();

const ENDPOINTS: Endpoint[] = [
  { name: 'read own account', method: 'get', path: () => '/users/me', allowed: 'student' },
  {
    name: 'edit own profile',
    method: 'patch',
    path: () => '/users/me',
    body: { displayName: 'Matrix' },
    allowed: 'student',
  },
  { name: 'list users', method: 'get', path: () => '/admin/users', allowed: 'admin' },
  { name: 'search the directory', method: 'get', path: () => '/admin/directory', allowed: 'admin' },
  {
    name: 'read a user',
    method: 'get',
    path: ({ target }) => `/admin/users/${target}`,
    allowed: 'admin',
  },
  {
    name: 'suspend',
    method: 'post',
    path: ({ target }) => `/admin/users/${target}/suspend`,
    body: { reason: 'matrix' },
    allowed: 'admin',
  },
  {
    name: 'reactivate',
    method: 'post',
    path: ({ target }) => `/admin/users/${target}/reactivate`,
    body: { reason: 'matrix' },
    allowed: 'admin',
  },
  {
    name: 'set role',
    method: 'put',
    path: ({ target }) => `/admin/users/${target}/role`,
    body: { role: 'ADMIN', reason: 'matrix' },
    allowed: 'admin',
  },
  {
    name: 'read audit records',
    method: 'get',
    path: () => '/admin/audit-records',
    allowed: 'admin',
  },
  {
    name: 're-enter password',
    method: 'post',
    path: () => '/auth/step-up',
    body: { password: PASSWORD },
    allowed: 'student',
  },
  {
    name: 'list role requests',
    method: 'get',
    path: () => '/admin/role-requests',
    allowed: 'admin',
  },
  {
    name: 'approve a role request',
    method: 'post',
    path: ({ request }) => `/admin/role-requests/${request}/approve`,
    body: { reason: 'matrix' },
    allowed: 'admin',
    adminStatus: 404,
  },
  {
    name: 'reject a role request',
    method: 'post',
    path: ({ request }) => `/admin/role-requests/${request}/reject`,
    body: { reason: 'matrix' },
    allowed: 'admin',
    adminStatus: 404,
  },
  { name: 'read admin reads', method: 'get', path: () => '/admin/reads', allowed: 'admin' },
  { name: 'read admin alerts', method: 'get', path: () => '/admin/alerts', allowed: 'admin' },
];

/** Service-only endpoints: a user token, of any kind, must never open them. */
const INTERNAL = [
  (id: string) => `/internal/users/${id}`,
  (id: string) => `/internal/users/${id}/permissions`,
  (id: string) => `/internal/introspect?sid=${id}&sub=${id}`,
];

/** Routes that are intentionally public, or that authenticate by their own credential (cookie, service key). */
const PUBLIC = new Set([
  'GET /health',
  // Prometheus metrics from @foc/platform (PLT-04): counts and timings, no personal data.
  'GET /metrics',
  'POST /auth/register',
  'POST /auth/activate',
  'POST /auth/login',
  'POST /auth/password',
  'POST /auth/refresh',
  'POST /auth/logout',
  'GET /.well-known/jwks.json',
  'GET /dev/mailbox',
]);

let t: TestApp;
let admin: Actor;
let student: Actor;
let suspended: Actor;
let target: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = await seededAdmin(t, 'root@u.nus.edu');
  student = await activeStudent(t, 'student@u.nus.edu');
  const victim = await activeStudent(t, 'victim@u.nus.edu');
  target = victim.id;
  suspended = await activeStudent(t, 'suspended@u.nus.edu');
  // suspended after login, so its token and session are still "live" until the status check
  await t.db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [suspended.id]);
});
afterAll(async () => {
  await t.close();
});

const call = (e: Endpoint, actor?: Actor) => {
  const req = http(t)[e.method](e.path({ target, request: UNKNOWN_REQUEST }));
  if (actor) req.set('Authorization', bearer(actor));
  return e.body ? req.send(e.body) : req;
};

describe('actor–resource–action matrix', () => {
  for (const e of ENDPOINTS) {
    describe(`${e.method.toUpperCase()} ${e.path({ target: ':id', request: ':id' })} — ${e.name}`, () => {
      it('unauthenticated → 401', async () => {
        expect((await call(e)).status).toBe(401);
      });

      it('suspended student → refused, never a success', async () => {
        const res = await call(e, suspended);
        expect([401, 403]).toContain(res.status);
      });

      it(`active student → ${e.allowed === 'student' ? 'allowed' : '403'}`, async () => {
        const res = await call(e, student);
        if (e.allowed === 'student') expect(res.status).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });

      it('administrator → succeeds (a crash or a refusal both fail this)', async () => {
        const res = await call(e, admin);
        const detail = `${e.name} returned ${res.status}: ${res.text.slice(0, 120)}`;
        if (e.adminStatus) expect(res.status, detail).toBe(e.adminStatus);
        else expect(res.status, detail).toBeLessThan(400);
      });
    });
  }

  it.each(INTERNAL.map((p, i) => [i, p] as const))(
    'internal endpoint %i refuses every user token, including an administrator’s',
    async (_i, path) => {
      for (const actor of [admin, student, suspended]) {
        const res = await http(t).get(path(target)).set('Authorization', bearer(actor));
        expect(res.status).toBe(401);
      }
      await http(t).get(path(target)).expect(401);
      await http(t).get(path(target)).set('x-service-key', SERVICE_KEY).expect(200);
    },
  );

  it('no client-supplied role, header or body field changes an outcome (US-NFR1.1.2)', async () => {
    for (const e of ENDPOINTS.filter((x) => x.allowed === 'admin')) {
      const res = await call(e, student)
        .set('x-role', 'ADMIN')
        .set('x-user-role', 'ADMIN')
        .set('x-user-id', admin.id)
        .set('x-admin', 'true');
      expect(res.status, e.name).toBe(403);
    }
  });

  it('a token for a user who was later demoted stops working as admin immediately', async () => {
    const other = await activeStudent(t, 'later@u.nus.edu');
    const second = await seededAdmin(t, 'second@u.nus.edu');
    const roleChange = async (role: string) => {
      const asked = await http(t)
        .put(`/admin/users/${other.id}/role`)
        .set('Authorization', bearer(admin))
        .send({ role, reason: 'temp' })
        .expect(202);
      await http(t)
        .post(`/admin/role-requests/${asked.body.request.id}/approve`)
        .set('Authorization', bearer(second))
        .send({ reason: 'temp' })
        .expect(200);
    };
    await roleChange('ADMIN');
    await http(t).get('/admin/users').set('Authorization', bearer(other)).expect(200);
    await roleChange('STUDENT');
    await http(t).get('/admin/users').set('Authorization', bearer(other)).expect(403);
  });

  it('deny by default: every registered route is either in the matrix or explicitly public', async () => {
    const instance = t.app.getHttpAdapter().getInstance() as {
      router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      _router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    };
    const stack = (instance.router ?? instance._router)?.stack ?? [];
    const routes = stack
      .filter((l) => l.route)
      .flatMap((l) =>
        Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`),
      );
    expect(routes.length).toBeGreaterThan(10); // the enumeration itself works

    const normalise = (p: string) => p.replace(/:[A-Za-z]+/g, ':id');
    const covered = new Set([
      ...ENDPOINTS.map(
        (e) => `${e.method.toUpperCase()} ${e.path({ target: ':id', request: ':id' })}`,
      ),
      ...INTERNAL.map((p) => `GET ${p(':id').split('?')[0]}`),
      ...PUBLIC,
    ]);
    const uncovered = routes.filter((r) => !covered.has(normalise(r)));
    expect(
      uncovered,
      'routes with no matrix coverage — add them to ENDPOINTS, INTERNAL or PUBLIC',
    ).toEqual([]);
  });

  it('a well-formed but unknown id is refused before it is looked up, for a non-admin', async () => {
    const res = await http(t)
      .get(`/admin/users/${randomUUID()}`)
      .set('Authorization', bearer(student));
    expect(res.status).toBe(403); // not 404: a non-admin learns nothing about who exists
  });

  it('a fresh login by a suspended student is refused', async () => {
    await expect(login(t, suspended.email)).rejects.toThrow();
  });
});

void ORIGIN;
