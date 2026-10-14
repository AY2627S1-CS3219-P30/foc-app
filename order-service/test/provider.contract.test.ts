import { randomUUID } from 'node:crypto';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { DEAD_LETTERS, createEnvelope, type DeadLetters } from '@foc/platform';
import { ContractValidator } from '@foc/test-harness';
import {
  asAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';

const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';
const order = {
  supplierId: '00000000-0000-4000-8000-000000000125',
  items: [{ name: 'Chicken rice', quantity: 1 }],
  deliveryZone: 'COM2 Lobby',
  deliveryInstructions: 'Meet beside the security desk',
  reward: 2,
};

/**
 * Provider contract check (TST-01, EI-NFR3.1.1): real responses from the running module must
 * satisfy contracts/order-service.openapi.yaml.
 */
describe('order-service honours its published contract', () => {
  const contract = ContractValidator.for('order-service');
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => app.close());

  it('GET /health', async () => {
    contract.assert('get', '/health', await http(app).get('/health'));
  });

  it('GET /orders/{orderId} (200, 400, 401, 404)', async () => {
    const template = '/orders/{orderId}';
    contract.assert(
      'get',
      template,
      await http(app).get(`/orders/${SEEDED_ORDER}`).set('Authorization', asStranger),
    );
    contract.assert(
      'get',
      template,
      await http(app).get('/orders/not-a-uuid').set('Authorization', asStranger),
    );
    contract.assert('get', template, await http(app).get(`/orders/${SEEDED_ORDER}`));
    contract.assert(
      'get',
      template,
      await http(app).get(`/orders/${randomUUID()}`).set('Authorization', asStranger),
    );
  });

  it('GET /orders/mine (200, 401)', async () => {
    contract.assert(
      'get',
      '/orders/mine',
      await http(app).get('/orders/mine').set('Authorization', asRequester),
    );
    contract.assert('get', '/orders/mine', await http(app).get('/orders/mine'));
  });

  it('POST /orders (201, 200 replay, 400, 422)', async () => {
    const key = randomUUID();
    const create = () =>
      http(app)
        .post('/orders')
        .set('Authorization', asRequester)
        .set('Idempotency-Key', key)
        .send(order);
    contract.assert('post', '/orders', await create());
    contract.assert('post', '/orders', await create());
    contract.assert(
      'post',
      '/orders',
      await http(app).post('/orders').set('Authorization', asRequester).send(order),
    );
    contract.assert(
      'post',
      '/orders',
      await http(app)
        .post('/orders')
        .set('Authorization', asRequester)
        .set('Idempotency-Key', randomUUID())
        .send({ ...order, reward: 0 }),
    );
  });

  it('GET /orders and POST /orders/{orderId}/accept (201, 403, 404, 409)', async () => {
    contract.assert(
      'get',
      '/orders',
      await http(app).get('/orders').set('Authorization', asStranger),
    );
    const accept = (auth: string, id = SEEDED_ORDER, expectedVersion = 2) =>
      http(app).post(`/orders/${id}/accept`).set('Authorization', auth).send({ expectedVersion });
    const template = '/orders/{orderId}/accept';
    contract.assert('post', template, await accept(asRequester));
    contract.assert('post', template, await accept(asStranger, randomUUID()));
    contract.assert('post', template, await accept(asStranger));
    contract.assert('post', template, await accept(asStranger));
  });

  it('fulfilment commands and the receipt (200, 403, 404, 409)', async () => {
    const lifecycle = await createTestApp();
    try {
      const call = (path: string, auth: string, expectedVersion: number) =>
        http(lifecycle)
          .post(`/orders/${SEEDED_ORDER}/${path}`)
          .set('Authorization', auth)
          .send({ expectedVersion });
      await call('accept', asStranger, 2);
      contract.assert('post', '/orders/{orderId}/pickup', await call('pickup', asRequester, 3));
      contract.assert('post', '/orders/{orderId}/deliver', await call('deliver', asStranger, 3));
      contract.assert('post', '/orders/{orderId}/pickup', await call('pickup', asStranger, 3));
      contract.assert('post', '/orders/{orderId}/deliver', await call('deliver', asStranger, 4));
      contract.assert(
        'post',
        '/orders/{orderId}/confirm-receipt',
        await call('confirm-receipt', asRequester, 5),
      );
      contract.assert(
        'get',
        '/orders/{orderId}/receipt',
        await http(lifecycle)
          .get(`/orders/${SEEDED_ORDER}/receipt`)
          .set('Authorization', asRequester),
      );
    } finally {
      await lifecycle.close();
    }
  });

  it('cancel and withdraw (200, 403, 409)', async () => {
    const lifecycle = await createTestApp();
    try {
      const call = (path: string, auth: string, expectedVersion: number) =>
        http(lifecycle)
          .post(`/orders/${SEEDED_ORDER}/${path}`)
          .set('Authorization', auth)
          .send({ expectedVersion });
      contract.assert('post', '/orders/{orderId}/withdraw', await call('withdraw', asStranger, 2));
      contract.assert('post', '/orders/{orderId}/cancel', await call('cancel', asStranger, 2));
      await call('accept', asStranger, 2);
      contract.assert('post', '/orders/{orderId}/withdraw', await call('withdraw', asStranger, 3));
      contract.assert('post', '/orders/{orderId}/cancel', await call('cancel', asRequester, 4));
      contract.assert('post', '/orders/{orderId}/cancel', await call('cancel', asRequester, 5));
    } finally {
      await lifecycle.close();
    }
  });

  it('history and the operator pending-credit view (200, 401, 403)', async () => {
    const history = '/orders/{orderId}/history';
    contract.assert(
      'get',
      history,
      await http(app).get(`/orders/${SEEDED_ORDER}/history`).set('Authorization', asRequester),
    );
    contract.assert(
      'get',
      history,
      await http(app).get(`/orders/${SEEDED_ORDER}/history`).set('Authorization', asStranger),
    );
    const view = '/admin/orders/pending-credit';
    contract.assert('get', view, await http(app).get(view).set('Authorization', asAdmin));
    contract.assert('get', view, await http(app).get(view).set('Authorization', asStranger));
    contract.assert('get', view, await http(app).get(view));
  });

  it('the operator timeline and alerts (200, 400, 401, 403, 404)', async () => {
    const timeline = '/admin/orders/{orderId}/timeline';
    const get = (path: string, auth?: string) =>
      auth ? http(app).get(path).set('Authorization', auth) : http(app).get(path);
    const at = `/admin/orders/${SEEDED_ORDER}/timeline`;
    contract.assert('get', timeline, await get(at, asAdmin));
    contract.assert('get', timeline, await get('/admin/orders/not-a-uuid/timeline', asAdmin));
    contract.assert('get', timeline, await get(at));
    contract.assert('get', timeline, await get(at, asStranger));
    contract.assert('get', timeline, await get(`/admin/orders/${randomUUID()}/timeline`, asAdmin));
    const alerts = '/admin/orders/alerts';
    contract.assert('get', alerts, await get(alerts, asAdmin));
    contract.assert('get', alerts, await get(alerts, asStranger));
  });

  it('dead letters: find, inspect, redrive (200, 401, 403, 404, 422, 503)', async () => {
    const channel = { ack: () => undefined, nack: () => undefined } as unknown as ConfirmChannel;
    const reply = createEnvelope({
      eventType: 'credit.reserved',
      schemaVersion: 1,
      aggregateId: SEEDED_ORDER,
      producer: 'credit-service',
      correlationId: 'contract-trace',
      payload: { orderId: SEEDED_ORDER },
    });
    await app.app.get<DeadLetters>(DEAD_LETTERS).park(channel, 'foc.order.reservation-results', {
      content: Buffer.from(JSON.stringify(reply)),
      fields: { routingKey: 'foc.order.reservation-results' },
      properties: { headers: { 'x-foc-attempt': 5, 'x-foc-failure-reason': 'contract check' } },
    } as unknown as ConsumeMessage);

    const list = '/admin/dead-letters';
    const found = await http(app).get(`${list}?q=contract-trace`).set('Authorization', asAdmin);
    contract.assert('get', list, found);
    contract.assert('get', list, await http(app).get(list).set('Authorization', asStranger));
    contract.assert('get', list, await http(app).get(list));
    contract.assert(
      'get',
      list,
      await http(app).get(`${list}?status=LOST`).set('Authorization', asAdmin),
    );

    const id = (found.body as { items: Array<{ id: string }> }).items[0]!.id;
    const one = '/admin/dead-letters/{id}';
    contract.assert('get', one, await http(app).get(`${list}/${id}`).set('Authorization', asAdmin));
    contract.assert(
      'get',
      one,
      await http(app).get(`${list}/${randomUUID()}`).set('Authorization', asAdmin),
    );

    const redrive = '/admin/dead-letters/{id}/redrive';
    const post = (target: string, body: unknown, auth = asAdmin) =>
      http(app)
        .post(`${list}/${target}/redrive`)
        .set('Authorization', auth)
        .send(body as object);
    contract.assert('post', redrive, await post(id, { reason: 'no broker in this test' }));
    contract.assert('post', redrive, await post(id, {}));
    contract.assert('post', redrive, await post(randomUUID(), { reason: 'unknown' }));
    contract.assert('post', redrive, await post(id, { reason: 'student' }, asStranger));
  });
});
