import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { ContractValidator } from '@foc/test-harness';
import { SERVICE_KEY, createTestApp, validRegistration, type TestApp } from './helpers/app.js';
import { ORIGIN, activeStudent, bearer, http, seededAdmin } from './helpers/actors.js';

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
});
