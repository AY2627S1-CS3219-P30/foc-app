import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { ContractValidator } from '@foc/test-harness';
import {
  asAdmin,
  asOther,
  asService,
  asStudent,
  createTestApp,
  http,
  issue,
  type TestApp,
} from './helpers/app.js';

/**
 * Provider contract check (TST-01, EI-NFR3.1.1): real responses from the running module must
 * satisfy contracts/credit-service.openapi.yaml, so the documented shape cannot drift from code.
 */
describe('credit-service honours its published contract', () => {
  const contract = ContractValidator.for('credit-service');
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
    await issue(app, 'student-1');
  });
  afterAll(async () => app.close());

  const expectContract = async (
    method: 'get',
    template: string,
    response: { status: number; body: unknown },
  ) => contract.assert(method, template, response);

  it('GET /health', async () => {
    await expectContract('get', '/health', await http(app).get('/health'));
  });

  it('GET /wallets/me (200, 401, 404)', async () => {
    await expectContract(
      'get',
      '/wallets/me',
      await http(app).get('/wallets/me').set('Authorization', asStudent),
    );
    await expectContract('get', '/wallets/me', await http(app).get('/wallets/me'));
    await expectContract(
      'get',
      '/wallets/me',
      await http(app).get('/wallets/me').set('Authorization', asOther),
    );
  });

  it('GET /wallets/me/ledger (200, 400)', async () => {
    const path = '/wallets/me/ledger';
    await expectContract('get', path, await http(app).get(path).set('Authorization', asStudent));
    await expectContract(
      'get',
      path,
      await http(app).get(`${path}?limit=0`).set('Authorization', asStudent),
    );
  });

  it('GET /admin/wallets/{userId} and its ledger (200, 403)', async () => {
    await expectContract(
      'get',
      '/admin/wallets/{userId}',
      await http(app).get('/admin/wallets/student-1').set('Authorization', asAdmin),
    );
    await expectContract(
      'get',
      '/admin/wallets/{userId}',
      await http(app).get('/admin/wallets/student-1').set('Authorization', asStudent),
    );
    await expectContract(
      'get',
      '/admin/wallets/{userId}/ledger',
      await http(app).get('/admin/wallets/student-1/ledger').set('Authorization', asAdmin),
    );
  });

  it('GET /internal/orders/{orderId}/credit-status (200, 401)', async () => {
    const path = `/internal/orders/${randomUUID()}/credit-status`;
    await expectContract(
      'get',
      '/internal/orders/{orderId}/credit-status',
      await http(app).get(path).set('X-Service-Key', asService),
    );
    await expectContract(
      'get',
      '/internal/orders/{orderId}/credit-status',
      await http(app).get(path),
    );
  });
});
