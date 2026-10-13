import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelay, createEnvelope } from '@foc/platform';
import type { CreationBoundary } from '../src/orders/orders.repository.js';
import type { CreateOrderInput } from '../src/orders/validation.js';
import { asRequester, createTestApp, http, type TestApp } from './helpers/app.js';

const supplierId = '00000000-0000-4000-8000-000000000125';
const validInput: CreateOrderInput = {
  supplierId,
  items: [{ name: 'Chicken rice', quantity: 1 }],
  deliveryZone: 'COM2 Lobby',
  deliveryInstructions: 'Meet beside the security desk',
  reward: 3,
};
const validOrder = (overrides: Record<string, unknown> = {}) => ({
  ...validInput,
  ...overrides,
});

const post = (t: TestApp, key: string, body: unknown = validOrder()) =>
  http(t)
    .post('/orders')
    .set('Authorization', asRequester)
    .set('Idempotency-Key', key)
    .set('X-Correlation-Id', `corr-${key}`)
    .send(body as object);

describe('asynchronous order creation (ORD-02)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('commits PENDING_CREDIT and both outbox facts while Credit is absent', async () => {
    t = await createTestApp();
    const response = await post(t, 'create-1').expect(201);
    expect(response.body).toMatchObject({
      requesterId: 'seed-requester',
      status: 'PENDING_CREDIT',
      supplier: { supplierId, name: 'The Deck' },
      reward: 3,
    });
    const rows = await t.db.query<
      { event_type: string; correlation_id: string } & Record<string, unknown>
    >(
      `SELECT event_type, correlation_id FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY seq`,
      [response.body.orderId],
    );
    expect(rows.rows).toEqual([
      { event_type: 'order.status-changed', correlation_id: 'corr-create-1' },
      { event_type: 'order.reservation-requested', correlation_id: 'corr-create-1' },
    ]);
  });

  it('returns the original result for repeated requests without rechecking Supplier', async () => {
    const supplierFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        supplierId,
        name: 'The Deck',
        type: 'FOOD',
        building: 'COM2',
        floor: '1',
        locationDescription: 'Level 1 canteen',
        active: true,
      }),
    );
    t = await createTestApp(supplierFetch);
    const first = await post(t, 'repeat-1').expect(201);
    for (let replay = 0; replay < 100; replay++) {
      const repeated = await post(t, 'repeat-1').expect(200);
      expect(repeated.body).toEqual(first.body);
    }
    expect(supplierFetch).toHaveBeenCalledTimes(1);
    const count = await t.db.query<{ count: number } & Record<string, unknown>>(
      `SELECT count(*)::int AS count FROM orders WHERE requester_id = 'seed-requester' AND order_id <> '00000000-0000-4000-8000-000000000129'`,
    );
    expect(count.rows[0]!.count).toBe(1);
  });

  it('rejects invalid input before contacting Supplier or entering the saga', async () => {
    const supplierFetch = vi.fn<typeof fetch>();
    t = await createTestApp(supplierFetch);
    const result = await post(t, 'invalid-1', validOrder({ reward: 0, items: [] })).expect(422);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
    expect(supplierFetch).not.toHaveBeenCalled();
    expect((await t.db.query(`SELECT * FROM outbox_events`)).rows).toHaveLength(0);
  });

  it('requires an idempotency key before contacting Supplier', async () => {
    const supplierFetch = vi.fn<typeof fetch>();
    t = await createTestApp(supplierFetch);
    const response = await http(t)
      .post('/orders')
      .set('Authorization', asRequester)
      .send(validOrder())
      .expect(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(supplierFetch).not.toHaveBeenCalled();
  });

  it('rejects an inactive supplier without writing an order', async () => {
    t = await createTestApp(async () =>
      Response.json({
        supplierId,
        name: 'Closed shop',
        type: 'FOOD',
        building: 'COM2',
        floor: '1',
        locationDescription: 'Level 1',
        active: false,
      }),
    );
    expect((await post(t, 'inactive-1').expect(422)).body.error.code).toBe('INVALID_SUPPLIER');
    expect((await t.db.query(`SELECT * FROM outbox_events`)).rows).toHaveLength(0);
  });

  it('fails closed when Supplier cannot be verified', async () => {
    t = await createTestApp(async () => {
      throw new Error('supplier down');
    });
    expect((await post(t, 'supplier-down').expect(503)).body.error.code).toBe(
      'SUPPLIER_SERVICE_UNAVAILABLE',
    );
    expect((await t.db.query(`SELECT * FROM outbox_events`)).rows).toHaveLength(0);
  });

  it('refuses an idempotency key reused with different facts', async () => {
    t = await createTestApp();
    await post(t, 'reuse-1').expect(201);
    const response = await post(t, 'reuse-1', validOrder({ reward: 4 })).expect(422);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each<CreationBoundary>([
    'order-written',
    'history-written',
    'idempotency-written',
    'status-outbox-written',
    'reservation-outbox-written',
  ])('rolls back every write when creation fails after %s', async (failedBoundary) => {
    t = await createTestApp();
    await expect(
      t.orders.createPending(
        {
          ...validInput,
          requesterId: 'fault-user',
          supplierSnapshot: {
            supplierId,
            name: 'The Deck',
            type: 'FOOD',
            building: 'COM2',
            floor: '1',
            locationDescription: 'Level 1 canteen',
          },
          idempotencyKey: `fault-${failedBoundary}`,
          requestHash: 'hash',
          correlationId: 'corr-fault',
        },
        (boundary) => {
          if (boundary === failedBoundary) throw new Error(`fault at ${boundary}`);
        },
      ),
    ).rejects.toThrow(`fault at ${failedBoundary}`);
    expect(
      (await t.db.query(`SELECT * FROM orders WHERE requester_id = 'fault-user'`)).rows,
    ).toHaveLength(0);
    expect((await t.db.query(`SELECT * FROM outbox_events`)).rows).toHaveLength(0);
  });

  it('delivers committed outbox rows after a simulated crash-before-publish restart', async () => {
    t = await createTestApp();
    const created = await post(t, 'restart-1').expect(201);
    const published: unknown[] = [];
    const relay = new OutboxRelay({
      db: t.db,
      publisher: {
        publish: async (input) => {
          published.push(input);
          return createEnvelope({ ...input, producer: 'order-service' });
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    expect(await relay.tick()).toBe(2);
    expect(published).toHaveLength(2);
    const remaining = await t.db.query(
      `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND published_at IS NULL`,
      [created.body.orderId],
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it('discovers old pending rows for reconciliation without rejecting them', async () => {
    t = await createTestApp();
    const created = await post(t, 'stale-1').expect(201);
    await t.db.query(
      `UPDATE orders SET created_at = now() - interval '6 minutes' WHERE order_id = $1`,
      [created.body.orderId],
    );
    const stale = await t.orders.findStalePendingCredit(new Date(Date.now() - 5 * 60_000));
    expect(stale.map((row) => row.orderId)).toContain(created.body.orderId);
    expect(await t.orders.findById(created.body.orderId)).toMatchObject({
      status: 'PENDING_CREDIT',
    });
  });
});
