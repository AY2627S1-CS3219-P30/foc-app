import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, StaleEventError, UnparseableMessageError, createEnvelope } from '@foc/platform';
import { RESERVATION_RESULTS_QUEUE } from '../src/reservation-results.consumer.js';
import { asRequester, asStranger, createTestApp, http, type TestApp } from './helpers/app.js';
import { reservationSubscription as subscription } from './support/lifecycle.js';

const supplierId = '00000000-0000-4000-8000-000000000125';

async function pendingOrder(t: TestApp): Promise<string> {
  const response = await http(t)
    .post('/orders')
    .set('Authorization', asRequester)
    .set('Idempotency-Key', randomUUID())
    .send({
      supplierId,
      items: [{ name: 'Coffee', quantity: 1 }],
      deliveryZone: 'COM2 Lobby',
      deliveryInstructions: 'Call on arrival',
      reward: 3,
    })
    .expect(201);
  return response.body.orderId as string;
}

describe('Credit reservation result handling', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('trusts only Credit and accepts both catalogue result shapes', async () => {
    t = await createTestApp();
    const sub = await subscription(t);
    expect(sub).toMatchObject({
      queue: RESERVATION_RESULTS_QUEUE,
      eventType: [EVENTS.CREDITS_RESERVED, EVENTS.CREDIT_RESERVATION_REJECTED],
      expectedProducer: 'credit-service',
    });
    expect(
      sub.payloadSchema.safeParse({
        orderId: randomUUID(),
        requesterId: 'seed-requester',
        amount: 3,
      }).success,
    ).toBe(true);
  });

  it('keeps every field of both reply shapes through the subscription schema the broker applies', async () => {
    t = await createTestApp();
    const sub = await subscription(t);
    const base = { orderId: randomUUID(), requesterId: 'seed-requester', amount: 3 };
    expect(sub.payloadSchema.parse(base)).toEqual(base);
    const rejected = { ...base, reason: 'INSUFFICIENT_CREDITS', available: 1 };
    expect(sub.payloadSchema.parse(rejected)).toEqual(rejected);
  });

  it('rejects an order when the rejection arrives through the schema, as from the broker', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const payload = sub.payloadSchema.parse({
      orderId,
      requesterId: 'seed-requester',
      amount: 3,
      reason: 'INSUFFICIENT_CREDITS',
      available: 1,
    });
    await sub.handler(
      createEnvelope({
        eventId: randomUUID(),
        eventType: EVENTS.CREDIT_RESERVATION_REJECTED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-parsed-rejection',
        payload,
      }),
      { attempt: 1, queue: RESERVATION_RESULTS_QUEUE },
    );
    expect(await t.orders.findById(orderId)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_CREDITS',
      availableAtRejection: 1,
    });
  });

  it('moves a pending order to OPEN once and starts its acceptance deadline', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const envelope = createEnvelope({
      eventId: randomUUID(),
      eventType: EVENTS.CREDITS_RESERVED,
      schemaVersion: 1,
      aggregateId: orderId,
      producer: 'credit-service',
      correlationId: 'corr-reserved',
      payload: { orderId, requesterId: 'seed-requester', amount: 3 },
    });
    for (let delivery = 1; delivery <= 100; delivery++) {
      await sub.handler(envelope, { attempt: delivery, queue: RESERVATION_RESULTS_QUEUE });
    }
    const order = await t.orders.findById(orderId);
    expect(order).toMatchObject({ status: 'OPEN', version: 2 });
    expect(new Date(order!.acceptanceDeadlineAt!).getTime()).toBeGreaterThan(Date.now());
    const history = await t.db.query(
      `SELECT * FROM order_status_history WHERE order_id = $1 AND new_status = 'OPEN'`,
      [orderId],
    );
    expect(history.rows).toHaveLength(1);
  });

  it('moves a refusal to REJECTED with its actionable insufficient-credit details', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    await sub.handler(
      createEnvelope({
        eventId: randomUUID(),
        eventType: EVENTS.CREDIT_RESERVATION_REJECTED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-rejected',
        payload: {
          orderId,
          requesterId: 'seed-requester',
          amount: 3,
          reason: 'INSUFFICIENT_CREDITS',
          available: 1,
        },
      }),
      { attempt: 1, queue: RESERVATION_RESULTS_QUEUE },
    );
    expect(await t.orders.findById(orderId)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_CREDITS',
      availableAtRejection: 1,
    });
  });

  it('ignores a repeated confirmation that arrives after the errand has moved on, and changes nothing', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const context = { attempt: 1, queue: RESERVATION_RESULTS_QUEUE };
    // Credit replays its recorded reply under a new event id when a request is sent again.
    const reserved = () =>
      createEnvelope({
        eventId: randomUUID(),
        eventType: EVENTS.CREDITS_RESERVED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-reserved',
        payload: { orderId, requesterId: 'seed-requester', amount: 3 },
      });
    await sub.handler(reserved(), context);
    await http(t)
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', asStranger)
      .send({ expectedVersion: 2 })
      .expect(201);
    const before = {
      order: await t.orders.findById(orderId),
      history: (await t.db.query('SELECT count(*)::int AS n FROM order_status_history')).rows,
      outbox: (await t.db.query('SELECT count(*)::int AS n FROM outbox_events')).rows,
    };
    expect(before.order).toMatchObject({ status: 'ACCEPTED', version: 3 });

    await expect(sub.handler(reserved(), context)).rejects.toBeInstanceOf(StaleEventError);

    expect(await t.orders.findById(orderId)).toEqual(before.order);
    expect((await t.db.query('SELECT count(*)::int AS n FROM order_status_history')).rows).toEqual(
      before.history,
    );
    expect((await t.db.query('SELECT count(*)::int AS n FROM outbox_events')).rows).toEqual(
      before.outbox,
    );
  });

  it('still sets aside a confirmation that contradicts a recorded rejection', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const context = { attempt: 1, queue: RESERVATION_RESULTS_QUEUE };
    const result = (eventType: string, extra: object = {}) =>
      createEnvelope({
        eventId: randomUUID(),
        eventType,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-contradiction',
        payload: { orderId, requesterId: 'seed-requester', amount: 3, ...extra },
      });
    await sub.handler(
      result(EVENTS.CREDIT_RESERVATION_REJECTED, { reason: 'INSUFFICIENT_CREDITS', available: 1 }),
      context,
    );

    // Credit cannot have both refused and reserved the same request: a person must look.
    await expect(sub.handler(result(EVENTS.CREDITS_RESERVED), context)).rejects.toBeInstanceOf(
      UnparseableMessageError,
    );
    expect(await t.orders.findById(orderId)).toMatchObject({ status: 'REJECTED', version: 2 });
  });

  it('sends each status change with the errand version it produced', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    await sub.handler(
      createEnvelope({
        eventId: randomUUID(),
        eventType: EVENTS.CREDITS_RESERVED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-versions',
        payload: { orderId, requesterId: 'seed-requester', amount: 3 },
      }),
      { attempt: 1, queue: RESERVATION_RESULTS_QUEUE },
    );
    await http(t)
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', asStranger)
      .send({ expectedVersion: 2 })
      .expect(201);

    const sent = await t.db.query<{ payload: { newStatus: string; orderVersion?: number } }>(
      `SELECT payload FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'order.status-changed' ORDER BY seq`,
      [orderId],
    );
    expect(sent.rows.map((r) => [r.payload.newStatus, r.payload.orderVersion])).toEqual([
      ['PENDING_CREDIT', 1],
      ['OPEN', 2],
      ['ACCEPTED', 3],
    ]);
  });

  it('rejects a conflicting replay of an already-recorded refusal', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const rejection = (eventId: string, available: number) =>
      createEnvelope({
        eventId,
        eventType: EVENTS.CREDIT_RESERVATION_REJECTED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-conflicting-rejection',
        payload: {
          orderId,
          requesterId: 'seed-requester',
          amount: 3,
          reason: 'INSUFFICIENT_CREDITS' as const,
          available,
        },
      });

    await sub.handler(rejection(randomUUID(), 1), {
      attempt: 1,
      queue: RESERVATION_RESULTS_QUEUE,
    });
    await expect(
      sub.handler(rejection(randomUUID(), 2), {
        attempt: 1,
        queue: RESERVATION_RESULTS_QUEUE,
      }),
    ).rejects.toBeInstanceOf(UnparseableMessageError);

    expect(await t.orders.findById(orderId)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_CREDITS',
      availableAtRejection: 1,
      version: 2,
    });
    expect((await t.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(1);
  });

  it('rejects an aggregate or request-fact mismatch without mutation or inbox commit', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const envelope = createEnvelope({
      eventId: randomUUID(),
      eventType: EVENTS.CREDITS_RESERVED,
      schemaVersion: 1,
      aggregateId: orderId,
      producer: 'credit-service',
      correlationId: 'corr-mismatch',
      payload: { orderId, requesterId: 'someone-else', amount: 3 },
    });
    await expect(
      sub.handler(envelope, { attempt: 1, queue: RESERVATION_RESULTS_QUEUE }),
    ).rejects.toBeInstanceOf(UnparseableMessageError);
    expect(await t.orders.findById(orderId)).toMatchObject({ status: 'PENDING_CREDIT' });
    expect((await t.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(0);
  });
});
