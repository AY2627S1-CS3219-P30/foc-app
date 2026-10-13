import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, UnparseableMessageError } from '@foc/platform';
import { ORDER_ACTIONS } from '../src/orders/order-state-machine.js';
import {
  asAdmin,
  asBystander,
  asOtherAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  COURIER,
  REQUESTER,
  SEEDED_ORDER,
  SEEDED_REWARD,
  TRANSFER_RESULTS_QUEUE,
  advance,
  deliver,
  footprint,
  terminalSubscriptions,
  transferred,
} from './support/lifecycle.js';

const post = (t: TestApp, path: string, auth: string, expectedVersion: number) =>
  http(t)
    .post(`/orders/${SEEDED_ORDER}/${path}`)
    .set('Authorization', auth)
    .send({ expectedVersion });

describe('fulfilment, completion saga and receipt (ORD-04)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('moves courier pickup and delivery, then requester confirmation, into COMPLETION_PENDING_CREDIT', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');

    const picked = await post(t, 'pickup', asStranger, 3).expect(200);
    expect(picked.body).toMatchObject({ status: 'PICKED_UP', version: 4 });
    const delivered = await post(t, 'deliver', asStranger, 4).expect(200);
    expect(delivered.body).toMatchObject({ status: 'DELIVERED', version: 5 });
    const confirmed = await post(t, 'confirm-receipt', asRequester, 5).expect(200);
    expect(confirmed.body).toMatchObject({ status: 'COMPLETION_PENDING_CREDIT', version: 6 });

    const requests = await t.db.query<{ payload: unknown }>(
      `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
      [SEEDED_ORDER, EVENTS.ORDER_COMPLETION_REQUESTED],
    );
    expect(requests.rows.map((row) => row.payload)).toEqual([
      { orderId: SEEDED_ORDER, requesterId: REQUESTER, courierId: COURIER, amount: SEEDED_REWARD },
    ]);
    const history = await t.db.query<{ action: string; actor_type: string; new_status: string }>(
      `SELECT action, actor_type, new_status FROM order_status_history
        WHERE order_id = $1 ORDER BY order_version`,
      [SEEDED_ORDER],
    );
    expect(history.rows.slice(-3)).toEqual([
      { action: 'RECORD_PICKUP', actor_type: 'COURIER', new_status: 'PICKED_UP' },
      { action: 'RECORD_DELIVERY', actor_type: 'COURIER', new_status: 'DELIVERED' },
      {
        action: 'CONFIRM_RECEIPT',
        actor_type: 'REQUESTER',
        new_status: 'COMPLETION_PENDING_CREDIT',
      },
    ]);
  });

  it('refuses every invalid actor or source state without mutating anything', async () => {
    t = await createTestApp();
    // Not yet assigned: nobody may record pickup.
    const before = await footprint(t);
    expect((await post(t, 'pickup', asStranger, 2)).status).toBe(403);
    expect((await post(t, 'deliver', asRequester, 2)).status).toBe(403);
    expect((await post(t, 'confirm-receipt', asRequester, 2)).status).toBe(409);
    expect(await footprint(t)).toEqual(before);

    await advance(t, 'ACCEPTED');
    const accepted = await footprint(t);
    const attempts: Array<() => ReturnType<typeof post>> = [
      () => post(t, 'pickup', asRequester, 3),
      () => post(t, 'pickup', asBystander, 3),
      () => post(t, 'pickup', asAdmin, 3),
      () => post(t, 'deliver', asStranger, 3),
      () => post(t, 'confirm-receipt', asStranger, 3),
      () => post(t, 'confirm-receipt', asRequester, 3),
      () => post(t, 'pickup', asStranger, 2),
    ];
    const refusals = [];
    for (const attempt of attempts) refusals.push(await attempt());
    expect(refusals.map((response) => [response.status, response.body.error.code])).toEqual([
      [403, 'ACTION_FORBIDDEN'],
      [403, 'ACTION_FORBIDDEN'],
      [403, 'ACTION_FORBIDDEN'],
      [409, 'INVALID_ORDER_STATE'],
      [403, 'ACTION_FORBIDDEN'],
      [409, 'INVALID_ORDER_STATE'],
      [409, 'ORDER_CHANGED'],
    ]);
    for (const refusal of refusals) {
      expect(refusal.body.error.details).toEqual({ status: 'ACCEPTED', version: 3 });
    }
    expect(await footprint(t)).toEqual(accepted);
  });

  it('holds COMPLETION_PENDING_CREDIT against every participant, administrator and timer action', async () => {
    t = await createTestApp();
    await advance(t, 'COMPLETION_PENDING_CREDIT');
    const pending = await footprint(t);

    const actors = [
      { kind: 'USER', id: REQUESTER, isAdmin: false },
      { kind: 'USER', id: COURIER, isAdmin: false },
      { kind: 'USER', id: 'bystander-student', isAdmin: false },
      { kind: 'USER', id: 'admin-1', isAdmin: true },
      { kind: 'SYSTEM', id: null },
    ] as const;
    for (const action of ORDER_ACTIONS) {
      for (const actor of actors) {
        const result = await t.orders.transition({
          orderId: SEEDED_ORDER,
          action,
          actor,
          correlationId: 'corr-hold',
        });
        expect(result.kind, `${action} by ${actor.kind}:${actor.id}`).toBe('rejected');
      }
    }
    for (const [path, auth] of [
      ['pickup', asStranger],
      ['deliver', asStranger],
      ['confirm-receipt', asRequester],
      ['accept', asBystander],
    ] as const) {
      expect((await post(t, path, auth, 6)).status).toBeGreaterThanOrEqual(403);
    }
    expect(await footprint(t)).toEqual(pending);
  });

  it('completes only on a matching transfer, once, and writes the immutable receipt', async () => {
    t = await createTestApp();
    await advance(t, 'COMPLETION_PENDING_CREDIT');
    const pending = await footprint(t);

    // Mismatched facts or a misaddressed envelope change nothing and dead-letter.
    for (const wrong of [
      transferred({ amount: SEEDED_REWARD + 1 }),
      transferred({ courierId: 'someone-else' }),
      transferred({ requesterId: 'someone-else' }),
      transferred({ aggregateId: randomUUID() }),
    ]) {
      await expect(deliver(t, TRANSFER_RESULTS_QUEUE, wrong)).rejects.toBeInstanceOf(
        UnparseableMessageError,
      );
    }
    expect(await footprint(t)).toEqual(pending);

    // 100 deliveries of one confirmation, and Credit re-emitting it under new event IDs.
    const transactionId = randomUUID();
    const subs = await terminalSubscriptions(t);
    const confirmation = transferred({ transactionId });
    for (let attempt = 1; attempt <= 100; attempt++) {
      await subs[TRANSFER_RESULTS_QUEUE]!.handler(confirmation, {
        attempt,
        queue: TRANSFER_RESULTS_QUEUE,
      });
    }
    for (let replay = 0; replay < 5; replay++) {
      await deliver(t, TRANSFER_RESULTS_QUEUE, transferred({ transactionId }));
    }

    const completed = await t.orders.findById(SEEDED_ORDER);
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      version: pending.order!.version + 1,
      creditTransactionId: transactionId,
    });
    expect(completed!.completedAt).not.toBeNull();
    const counts = await footprint(t);
    expect(counts.history).toBe(pending.history + 1);
    expect(counts.outbox).toBe(pending.outbox + 1);

    // A conflicting confirmation for an already completed order is refused, not applied.
    await expect(
      deliver(t, TRANSFER_RESULTS_QUEUE, transferred({ transactionId: randomUUID() })),
    ).rejects.toBeInstanceOf(UnparseableMessageError);

    const receipt = await http(t)
      .get(`/orders/${SEEDED_ORDER}/receipt`)
      .set('Authorization', asRequester)
      .expect(200);
    expect(receipt.body).toMatchObject({
      orderId: SEEDED_ORDER,
      requesterId: REQUESTER,
      courierId: COURIER,
      reward: SEEDED_REWARD,
      creditTransactionId: transactionId,
      supplier: { supplierId: '00000000-0000-4000-8000-000000000125' },
    });
    expect(Object.values(receipt.body.timestamps).every((value) => typeof value === 'string')).toBe(
      true,
    );
    await http(t)
      .get(`/orders/${SEEDED_ORDER}/receipt`)
      .set('Authorization', asStranger)
      .expect(200);
    await http(t)
      .get(`/orders/${SEEDED_ORDER}/receipt`)
      .set('Authorization', asBystander)
      .expect(403);
    await http(t)
      .get(`/orders/${SEEDED_ORDER}/receipt`)
      .set('Authorization', asOtherAdmin)
      .expect(403);

    await expect(
      t.db.query(`UPDATE order_receipts SET reward = 5 WHERE order_id = $1`, [SEEDED_ORDER]),
    ).rejects.toThrow(/append-only/);
    await expect(
      t.db.query(`DELETE FROM order_status_history WHERE order_id = $1`, [SEEDED_ORDER]),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a transfer for an order that is not waiting for one', async () => {
    t = await createTestApp();
    await advance(t, 'DELIVERED');
    const delivered = await footprint(t);
    await expect(deliver(t, TRANSFER_RESULTS_QUEUE, transferred())).rejects.toBeInstanceOf(
      UnparseableMessageError,
    );
    await expect(
      deliver(t, TRANSFER_RESULTS_QUEUE, transferred({ orderId: randomUUID() })),
    ).rejects.toBeInstanceOf(UnparseableMessageError);
    expect(await footprint(t)).toEqual(delivered);
    await http(t)
      .get(`/orders/${SEEDED_ORDER}/receipt`)
      .set('Authorization', asRequester)
      .expect(404);
  });

  it('trusts only the Credit Service for transfer confirmations', async () => {
    t = await createTestApp();
    const subs = await terminalSubscriptions(t);
    expect(subs[TRANSFER_RESULTS_QUEUE]).toMatchObject({
      eventType: EVENTS.CREDITS_TRANSFERRED,
      expectedProducer: 'credit-service',
    });
    expect(
      subs[TRANSFER_RESULTS_QUEUE]!.payloadSchema.safeParse({ orderId: SEEDED_ORDER }).success,
    ).toBe(false);
  });
});
