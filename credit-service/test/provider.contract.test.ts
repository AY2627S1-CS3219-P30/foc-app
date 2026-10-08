import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerConnection, DLX, EVENTS, createEnvelope } from '@foc/platform';
import { ContractValidator, createMemoryBroker } from '@foc/test-harness';
import { CREDIT_ECONOMIC_SUBSCRIPTIONS } from '../src/closed-economy.js';
import { WALLET_QUEUE } from '../src/wallet-provisioning.js';
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
    method: 'get' | 'post',
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

  it('the operator credit trace and alerts (200, 400, 401, 403)', async () => {
    const orderId = randomUUID();
    await app.db.transaction((tx) =>
      app.credits.reserve(tx, {
        orderId,
        requesterId: 'student-1',
        amount: 2,
        correlationId: 'contract-trace',
        causationId: 'contract-reserve',
      }),
    );
    const trace = '/admin/orders/{orderId}/credit';
    const get = (target: string, auth?: string) =>
      auth ? http(app).get(target).set('Authorization', auth) : http(app).get(target);
    await expectContract('get', trace, await get(`/admin/orders/${orderId}/credit`, asAdmin));
    await expectContract('get', trace, await get('/admin/orders/order-1/credit', asAdmin));
    await expectContract('get', trace, await get(`/admin/orders/${orderId}/credit`));
    await expectContract('get', trace, await get(`/admin/orders/${orderId}/credit`, asStudent));
    await expectContract('get', '/admin/credit-alerts', await get('/admin/credit-alerts', asAdmin));
    await expectContract('get', '/admin/credit-alerts', await get('/admin/credit-alerts', asOther));
  });

  it('GET /admin/activity-alerts (200 with an alert, 401, 403)', async () => {
    // ADM-04: a threshold of one wallet, so a single read raises BULK_WALLET_READS.
    const watched = await createTestApp({ walletReadsAlertPerHour: 1 });
    try {
      await issue(watched, 'student-1');
      await http(watched).get('/admin/wallets/student-1').set('Authorization', asAdmin).expect(200);
      const template = '/admin/activity-alerts';
      const raised = await http(watched).get(template).set('Authorization', asAdmin);
      expect(raised.body.items).toHaveLength(1);
      await expectContract('get', template, raised);
      await expectContract('get', template, await http(watched).get(template));
      await expectContract(
        'get',
        template,
        await http(watched).get(template).set('Authorization', asStudent),
      );
    } finally {
      await watched.close();
    }
  });

  it('dead letters: find, inspect, redrive (200, 401, 403, 404, 409, 422, 503)', async () => {
    const memory = createMemoryBroker();
    const broker = new BrokerConnection(
      'amqp://memory',
      'credit-service',
      CREDIT_ECONOMIC_SUBSCRIPTIONS.map(({ queue, routingKeys }) => ({
        queue,
        routingKeys: [...routingKeys],
      })),
      [5],
      { connect: memory.connect },
    );
    const withBroker = await createTestApp({ broker });
    try {
      await broker.connect();
      memory.publish(
        DLX,
        WALLET_QUEUE,
        createEnvelope({
          eventType: EVENTS.USER_ACTIVATED,
          schemaVersion: 1,
          aggregateId: 'student-7',
          producer: 'user-service',
          correlationId: 'contract-activation',
          payload: { userId: 'student-7', activatedAt: new Date().toISOString() },
        }),
        { headers: { 'x-foc-attempt': 5, 'x-foc-failure-reason': 'contract check' } },
      );
      const list = '/admin/dead-letters';
      const find = () =>
        http(withBroker).get(`${list}?q=contract-activation`).set('Authorization', asAdmin);
      await expect.poll(async () => (await find()).body.total).toBe(1);
      const found = await find();
      await expectContract('get', list, found);
      await expectContract(
        'get',
        list,
        await http(withBroker).get(list).set('Authorization', asStudent),
      );
      await expectContract('get', list, await http(withBroker).get(list));
      await expectContract(
        'get',
        list,
        await http(withBroker).get(`${list}?page=0`).set('Authorization', asAdmin),
      );

      const id = (found.body as { items: Array<{ id: string }> }).items[0]!.id;
      const one = '/admin/dead-letters/{id}';
      await expectContract(
        'get',
        one,
        await http(withBroker).get(`${list}/${id}`).set('Authorization', asAdmin),
      );
      await expectContract(
        'get',
        one,
        await http(withBroker).get(`${list}/${randomUUID()}`).set('Authorization', asAdmin),
      );

      const redrive = '/admin/dead-letters/{id}/redrive';
      const post = (target: string, body: object, on: TestApp = withBroker) =>
        http(on).post(`${list}/${target}/redrive`).set('Authorization', asAdmin).send(body);
      await expectContract('post', redrive, await post(id, {}));
      await expectContract('post', redrive, await post(id, { reason: 'contract' }));
      await expectContract('post', redrive, await post(id, { reason: 'again' }));
      await expectContract('post', redrive, await post(randomUUID(), { reason: 'unknown' }));
      // No broker at all: nothing can be sent.
      await expectContract('post', redrive, await post(randomUUID(), { reason: 'x' }, app));
    } finally {
      await broker.close();
      await withBroker.close();
    }
  });
});
