import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { ContractValidator } from '@foc/test-harness';
import { asRequester, asStranger, createTestApp, http, type TestApp } from './helpers/app.js';

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
});
