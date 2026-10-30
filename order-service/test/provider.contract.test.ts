import { randomUUID } from 'node:crypto';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTERS, createEnvelope, type DeadLetters } from '@foc/platform';
import { ContractValidator } from '@foc/test-harness';
import {
  asAdmin,
  asOtherAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  TRANSFER_RESULTS_QUEUE,
  advance,
  backdate,
  deliver,
  dispute,
  sweep,
  transferred,
} from './support/lifecycle.js';

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

  it('GET /internal/orders/{orderId}/chat (200, 400, 401, 404)', async () => {
    const template = '/internal/orders/{orderId}/chat';
    const lookup = (id: string, key = 'test-chat-key-0123456789') =>
      http(app).get(`/internal/orders/${id}/chat`).set('X-Service-Key', key);
    contract.assert('get', template, await lookup(SEEDED_ORDER));
    contract.assert('get', template, await lookup('not-a-uuid'));
    contract.assert('get', template, await http(app).get(`/internal/orders/${SEEDED_ORDER}/chat`));
    contract.assert('get', template, await lookup(randomUUID()));
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

  it('non-delivery and non-receipt reports, and the deadlines in the private view (200, 403, 409)', async () => {
    const pickedUp = await createTestApp();
    const delivered = await createTestApp();
    try {
      const call = (t: TestApp, path: string, auth: string, expectedVersion: number) =>
        http(t)
          .post(`/orders/${SEEDED_ORDER}/${path}`)
          .set('Authorization', auth)
          .send({ expectedVersion });
      const nonDelivery = '/orders/{orderId}/report-non-delivery';
      await advance(pickedUp, 'PICKED_UP');
      contract.assert(
        'post',
        nonDelivery,
        await call(pickedUp, 'report-non-delivery', asStranger, 4),
      );
      contract.assert(
        'post',
        nonDelivery,
        await call(pickedUp, 'report-non-delivery', asRequester, 4),
      );
      await backdate(pickedUp, 'non_delivery_report_at', 1);
      contract.assert(
        'post',
        nonDelivery,
        await call(pickedUp, 'report-non-delivery', asRequester, 4),
      );

      const nonReceipt = '/orders/{orderId}/report-non-receipt';
      await advance(delivered, 'DELIVERED');
      contract.assert(
        'get',
        '/orders/{orderId}',
        await http(delivered)
          .get(`/orders/${SEEDED_ORDER}?view=private`)
          .set('Authorization', asRequester),
      );
      contract.assert(
        'post',
        nonReceipt,
        await call(delivered, 'report-non-receipt', asStranger, 5),
      );
      contract.assert(
        'post',
        nonReceipt,
        await call(delivered, 'report-non-receipt', asRequester, 5),
      );
      contract.assert(
        'post',
        nonReceipt,
        await call(delivered, 'report-non-receipt', asRequester, 5),
      );
    } finally {
      await pickedUp.close();
      await delivered.close();
    }
  });

  it.each(['report-non-delivery', 'report-non-receipt'])(
    'POST /orders/{orderId}/%s (400, 401, 404, 422)',
    async (path) => {
      const template = `/orders/{orderId}/${path}`;
      const report = (id: string, body: object, auth?: string) => {
        const req = http(app).post(`/orders/${id}/${path}`);
        return (auth ? req.set('Authorization', auth) : req).send(body);
      };
      const valid = { expectedVersion: 1 };
      contract.assert('post', template, await report('not-a-uuid', valid, asRequester).expect(400));
      contract.assert('post', template, await report(SEEDED_ORDER, valid).expect(401));
      contract.assert('post', template, await report(randomUUID(), valid, asRequester).expect(404));
      contract.assert('post', template, await report(SEEDED_ORDER, {}, asRequester).expect(422));
    },
  );

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

  it('dispute referral, decision and decision log (200, 400, 401, 403, 404, 409, 422)', async () => {
    const lifecycle = await createTestApp();
    try {
      await dispute(lifecycle, 'PICKED_UP'); // version 5
      await sweep(lifecycle); // referred to admin-1, version 6
      const get = (path: string, auth?: string) => {
        const request = http(lifecycle).get(path);
        return auth ? request.set('Authorization', auth) : request;
      };
      const referred = '/admin/orders/referred';
      contract.assert('get', referred, await get(referred, asAdmin));
      contract.assert('get', referred, await get(referred, asOtherAdmin));
      contract.assert('get', referred, await get(referred, asStranger));
      contract.assert('get', referred, await get(referred));

      const template = '/admin/orders/{orderId}/resolve';
      const resolve = (auth: string | undefined, body: object, id = SEEDED_ORDER) => {
        const request = http(lifecycle).post(`/admin/orders/${id}/resolve`);
        return (auth ? request.set('Authorization', auth) : request).send(body);
      };
      const decision = { outcome: 'COURIER', reason: 'Handed over in person.', expectedVersion: 6 };
      contract.assert('post', template, await resolve(undefined, decision));
      contract.assert('post', template, await resolve(asAdmin, decision, 'not-a-uuid'));
      contract.assert('post', template, await resolve(asAdmin, { ...decision, reason: '' }));
      contract.assert('post', template, await resolve(asOtherAdmin, decision));
      contract.assert('post', template, await resolve(asAdmin, decision, randomUUID()));
      contract.assert('post', template, await resolve(asAdmin, decision));
      contract.assert('post', template, await resolve(asAdmin, decision));

      const decisions = '/admin/orders/decisions';
      contract.assert('get', decisions, await get(decisions, asOtherAdmin));
      contract.assert('get', decisions, await get(decisions, asStranger));
      contract.assert('get', decisions, await get(decisions));
      contract.assert(
        'get',
        '/orders/{orderId}/history',
        await get(`/orders/${SEEDED_ORDER}/history`, asAdmin),
      );
      // Completed by decision before any delivery was recorded: the receipt says so.
      await deliver(lifecycle, TRANSFER_RESULTS_QUEUE, transferred());
      contract.assert(
        'get',
        '/orders/{orderId}/receipt',
        await get(`/orders/${SEEDED_ORDER}/receipt`, asRequester),
      );
    } finally {
      await lifecycle.close();
    }
  });

  it('an unreferred dispute in the operator alerts and timeline (200)', async () => {
    const lifecycle = await createTestApp();
    try {
      // The only listed administrator is the errand's requester, so the dispute raises an alert.
      lifecycle.userService.admins.clear();
      lifecycle.userService.admins.add('seed-requester');
      await dispute(lifecycle, 'PICKED_UP');
      await sweep(lifecycle);
      const get = (path: string) => http(lifecycle).get(path).set('Authorization', asAdmin);

      const alerts = await get('/admin/orders/alerts');
      expect(alerts.body.items).toContainEqual(
        expect.objectContaining({ orderId: SEEDED_ORDER, kind: 'REFERRAL_UNASSIGNED' }),
      );
      contract.assert('get', '/admin/orders/alerts', alerts);
      contract.assert(
        'get',
        '/admin/orders/{orderId}/timeline',
        await get(`/admin/orders/${SEEDED_ORDER}/timeline`),
      );
    } finally {
      await lifecycle.close();
    }
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

  it("an administrator's view of one account's errands (200, 401, 403, 422)", async () => {
    const accounts = '/admin/orders';
    const get = (query: string, auth?: string) =>
      auth
        ? http(app).get(`${accounts}?${query}`).set('Authorization', auth)
        : http(app).get(`${accounts}?${query}`);
    contract.assert('get', accounts, await get('requesterId=seed-requester', asAdmin));
    contract.assert('get', accounts, await get('courierId=unrelated-student&page=2', asAdmin));
    contract.assert('get', accounts, await get('requesterId=seed-requester'));
    contract.assert('get', accounts, await get('requesterId=seed-requester', asStranger));
    contract.assert('get', accounts, await get('pageSize=5', asAdmin));
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
