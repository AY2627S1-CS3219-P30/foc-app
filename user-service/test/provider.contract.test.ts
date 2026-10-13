import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContractValidator } from '@foc/test-harness';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import {
  SERVICE_KEY,
  createTestApp,
  openLimiters,
  validRegistration,
  type TestApp,
} from './helpers/app.js';
import { ORIGIN, activeStudent, bearer, http, login, seededAdmin } from './helpers/actors.js';

/**
 * Provider contract check (TST-01, EI-NFR3.1.1): real responses from the running module must
 * satisfy contracts/user-service.openapi.yaml.
 */
describe('user-service honours its published contract', () => {
  const contract = ContractValidator.for('user-service');
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => app.close());

  /**
   * `contract.assert` accepts any status the operation documents. A case that exists for one
   * particular status pins it first, so it cannot pass on a different refusal.
   */
  const assertStatus = (
    method: string,
    path: string,
    status: number,
    response: { status: number; body: unknown },
  ) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    contract.assert(method, path, response);
  };

  it('GET /health and the JWKS document', async () => {
    contract.assert('get', '/health', await http(app).get('/health'));
    contract.assert('get', '/.well-known/jwks.json', await http(app).get('/.well-known/jwks.json'));
  });

  it('registration, activation and login with their error responses', async () => {
    const email = 'e0145001@u.nus.edu';
    contract.assert(
      'post',
      '/auth/register',
      await http(app).post('/auth/register').send(validRegistration(email)),
    );
    contract.assert(
      'post',
      '/auth/register',
      await http(app).post('/auth/register').send(validRegistration(email)),
    );
    contract.assert('post', '/auth/register', await http(app).post('/auth/register').send({}));

    const token = app.mailbox.latestFor(email)!.token;
    contract.assert(
      'post',
      '/auth/activate',
      await http(app).post('/auth/activate').send({ token }),
    );
    contract.assert(
      'post',
      '/auth/activate',
      await http(app).post('/auth/activate').send({ token: randomUUID() }),
    );

    const login = (password: string) =>
      http(app).post('/auth/login').set('Origin', ORIGIN).send({ email, password });
    contract.assert('post', '/auth/login', await login(validRegistration().password));
    contract.assert('post', '/auth/login', await login('wrong-password-123'));
  });

  it('profile, admin and internal reads', async () => {
    const student = await activeStudent(app, 'e0145002@u.nus.edu');
    contract.assert(
      'get',
      '/users/me',
      await http(app).get('/users/me').set('Authorization', bearer(student)),
    );
    contract.assert('get', '/users/me', await http(app).get('/users/me'));

    const admin = await seededAdmin(app, 'admin145@u.nus.edu');
    contract.assert(
      'get',
      '/admin/users',
      await http(app).get('/admin/users').set('Authorization', bearer(admin)),
    );
    contract.assert(
      'get',
      '/admin/users',
      await http(app).get('/admin/users').set('Authorization', bearer(student)),
    );
    contract.assert(
      'get',
      '/admin/users/{userId}',
      await http(app).get(`/admin/users/${student.id}`).set('Authorization', bearer(admin)),
    );

    contract.assert(
      'get',
      '/internal/users/{userId}',
      await http(app).get(`/internal/users/${student.id}`).set('X-Service-Key', SERVICE_KEY),
    );
    contract.assert(
      'get',
      '/internal/users/{userId}',
      await http(app).get(`/internal/users/${student.id}`),
    );
  });

  it('the controls on administrators (ADR 0008)', async () => {
    const root = await seededAdmin(app, 'root146@u.nus.edu');
    const second = await seededAdmin(app, 'second146@u.nus.edu');
    const target = await activeStudent(app, 'e0146001@u.nus.edu');
    const as = (a: { accessToken: string }) => ({
      post: (path: string, body: object) =>
        http(app).post(path).set('Authorization', bearer(a)).send(body),
      put: (path: string, body: object) =>
        http(app).put(path).set('Authorization', bearer(a)).send(body),
      get: (path: string) => http(app).get(path).set('Authorization', bearer(a)),
    });

    contract.assert(
      'post',
      '/auth/step-up',
      await as(root).post('/auth/step-up', { password: 'wrong-password-123' }),
    );
    contract.assert(
      'post',
      '/auth/step-up',
      await as(root).post('/auth/step-up', { password: validRegistration().password }),
    );

    const role = `/admin/users/${target.id}/role`;
    const asked = await as(root).put(role, { role: 'ADMIN', reason: 'contract' });
    contract.assert('put', '/admin/users/{userId}/role', asked);
    contract.assert(
      'put',
      '/admin/users/{userId}/role',
      await as(second).put(role, { role: 'ADMIN', reason: 'contract' }),
    );
    contract.assert(
      'get',
      '/admin/role-requests',
      await as(second).get('/admin/role-requests?status=PENDING'),
    );
    const id = asked.body.request.id as string;
    contract.assert(
      'post',
      '/admin/role-requests/{requestId}/approve',
      await as(root).post(`/admin/role-requests/${id}/approve`, { reason: 'contract' }),
    );
    contract.assert(
      'post',
      '/admin/role-requests/{requestId}/approve',
      await as(second).post(`/admin/role-requests/${id}/approve`, { reason: 'contract' }),
    );

    const demote = await as(root).put(role, { role: 'STUDENT', reason: 'contract' });
    const reject = () =>
      as(root).post(`/admin/role-requests/${demote.body.request.id}/reject`, {
        reason: 'withdrawn',
      });
    contract.assert('post', '/admin/role-requests/{requestId}/reject', await reject());
    // Already decided: ROLE_REQUEST_NOT_PENDING.
    assertStatus('post', '/admin/role-requests/{requestId}/reject', 409, await reject());

    contract.assert(
      'post',
      '/admin/users/{userId}/suspend',
      await as(await login(app, second.email)).post(`/admin/users/${root.id}/suspend`, {
        reason: 'contract',
      }),
    );
    await as(root).get(`/admin/users/${target.id}`).expect(200);
    contract.assert('get', '/admin/reads', await as(second).get(`/admin/reads?actorId=${root.id}`));
    contract.assert('get', '/admin/alerts', await as(second).get('/admin/alerts'));
    contract.assert('get', '/admin/directory', await as(second).get('/admin/directory?q=e0146'));
    contract.assert(
      'post',
      '/admin/users/{userId}/reactivate',
      await as(await login(app, second.email)).post(`/admin/users/${root.id}/reactivate`, {
        reason: 'contract',
      }),
    );
    contract.assert(
      'post',
      '/admin/users/{userId}/reactivate',
      await as(second).post(`/admin/users/${root.id}/reactivate`, { reason: 'contract' }),
    );
    contract.assert(
      'get',
      '/admin/audit-records',
      await as(second).get('/admin/audit-records?action=ROLE_CHANGE_REQUESTED'),
    );
  });

  it('the refusals and limits on suspending, reactivating and re-entering a password', async () => {
    // An app of its own: the shared one sets every limit out of a test's reach.
    const limited = await createTestApp({
      adminSettings: { suspensionsLimitPerHour: 1 },
      rateLimiters: { ...openLimiters(), stepUpPerUser: new RateLimiter(1, 60_000) },
    });
    try {
      // Seeding re-enters the password once, which is all this app allows.
      const admin = await seededAdmin(limited, 'limit146@u.nus.edu');
      const post = (path: string, body: object) =>
        http(limited).post(path).set('Authorization', bearer(admin)).send(body);
      assertStatus(
        'post',
        '/auth/step-up',
        429,
        await post('/auth/step-up', { password: validRegistration().password }),
      );

      const unactivated = await http(limited)
        .post('/auth/register')
        .send(validRegistration('e0146002@u.nus.edu'))
        .expect(201);
      const first = await activeStudent(limited, 'e0146003@u.nus.edu');
      const next = await activeStudent(limited, 'e0146004@u.nus.edu');
      const suspend = (userId: string) =>
        post(`/admin/users/${userId}/suspend`, { reason: 'contract' });

      // SELF_SUSPENSION_FORBIDDEN.
      assertStatus('post', '/admin/users/{userId}/suspend', 409, await suspend(admin.id));
      // ACCOUNT_NOT_ACTIVE: there is no suspension to lift.
      assertStatus(
        'post',
        '/admin/users/{userId}/reactivate',
        409,
        await post(`/admin/users/${unactivated.body.userId}/reactivate`, { reason: 'contract' }),
      );
      assertStatus('post', '/admin/users/{userId}/suspend', 200, await suspend(first.id));
      // One suspension an hour here, so the second is RATE_LIMITED.
      assertStatus('post', '/admin/users/{userId}/suspend', 429, await suspend(next.id));
    } finally {
      await limited.close();
    }
  });
});
