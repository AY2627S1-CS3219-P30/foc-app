import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, createEnvelope } from '@foc/platform';
import {
  USER_SUSPENSIONS_QUEUE,
  UserSuspensionsConsumer,
} from '../src/user-suspensions.consumer.js';
import { UserDirectoryUnavailableError } from '../src/orders/user-directory.client.js';
import {
  asAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  COURIER,
  RELEASE_RESULTS_QUEUE,
  REQUESTER,
  SEEDED_ORDER,
  SEEDED_REWARD,
  advance,
  backdate,
  createPending,
  deliver,
  dispute,
  footprint,
  outboxOf,
  released,
  reservationReply,
  subscriptionsOf,
  sweep,
} from './support/lifecycle.js';

/**
 * ORD-06 (#149): when the User Service suspends a participant, each of their errands is reopened,
 * cancelled, referred or left to finish, by who they are on it and how far it has got.
 */
const suspension = (userId: string, eventId = randomUUID()) =>
  createEnvelope({
    eventId,
    eventType: EVENTS.USER_SUSPENDED,
    schemaVersion: 1,
    aggregateId: userId,
    producer: 'user-service',
    correlationId: 'corr-suspension',
    payload: { userId, status: 'SUSPENDED', occurredAt: new Date().toISOString() },
  });

/** Suspends the user in the fake User Service, then delivers the message it would publish. */
async function suspend(t: TestApp, userId: string, envelope = suspension(userId)) {
  t.userService.suspended.add(userId);
  await deliverSuspension(t, envelope);
}

async function deliverSuspension(t: TestApp, envelope: unknown) {
  const subscriptions = await subscriptionsOf(
    (broker) => new UserSuspensionsConsumer(broker, t.db, t.orders, t.directory),
  );
  await subscriptions[USER_SUSPENSIONS_QUEUE]!.handler(envelope as never, {
    attempt: 1,
    queue: USER_SUSPENSIONS_QUEUE,
  });
}

const lastAction = async (t: TestApp, orderId = SEEDED_ORDER) =>
  (await t.orders.findHistory(orderId)).at(-1);

/** Every credit request ever written for the errand, of either kind. */
const creditRequests = async (t: TestApp, orderId = SEEDED_ORDER) => ({
  releases: (await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED, orderId)).length,
  transfers: (await outboxOf(t, EVENTS.ORDER_COMPLETION_REQUESTED, orderId)).length,
});

describe('participant suspension (ORD-06)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('reopens an errand whose courier is suspended before pickup, extending its deadline by the time they held it', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    // Held for 10 minutes, with 20 left on the deadline.
    await t.db.query(
      `UPDATE orders SET accepted_at = now() - interval '10 minutes',
                         acceptance_deadline_at = now() + interval '20 minutes'
        WHERE order_id = $1`,
      [SEEDED_ORDER],
    );
    const before = (await t.orders.findById(SEEDED_ORDER))!;

    await suspend(t, COURIER);

    const after = (await t.orders.findById(SEEDED_ORDER))!;
    expect(after).toMatchObject({ status: 'OPEN', courierId: null, acceptedAt: null, version: 4 });
    const extendedBy =
      Date.parse(after.acceptanceDeadlineAt!) - Date.parse(before.acceptanceDeadlineAt!);
    expect(extendedBy).toBeGreaterThanOrEqual(10 * 60_000);
    expect(extendedBy).toBeLessThan(11 * 60_000);
    expect(await lastAction(t)).toMatchObject({
      previousStatus: 'ACCEPTED',
      newStatus: 'OPEN',
      action: 'COURIER_SUSPENDED',
      reason: 'courier suspended',
      actorType: 'SYSTEM',
    });
    expect(await creditRequests(t)).toEqual({ releases: 0, transfers: 0 });
  });

  it('refers an errand whose courier is suspended after pickup, keeping them on it', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');

    await suspend(t, COURIER);

    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'DISPUTED',
      courierId: COURIER,
    });
    expect(await lastAction(t)).toMatchObject({
      previousStatus: 'PICKED_UP',
      action: 'COURIER_SUSPENDED',
      reason: 'courier suspended',
      actorType: 'SYSTEM',
    });
    expect(await creditRequests(t)).toEqual({ releases: 0, transfers: 0 });
    // The suspended courier took part, so the dispute goes to an administrator who did not.
    await sweep(t);
    expect((await t.orders.findById(SEEDED_ORDER))!.referredAdminId).toBe('admin-1');
  });

  for (const status of ['OPEN', 'ACCEPTED'] as const) {
    it(`cancels an errand still ${status} when its requester is suspended, returning the reserved credits`, async () => {
      t = await createTestApp();
      if (status === 'ACCEPTED') await advance(t, 'ACCEPTED');

      await suspend(t, REQUESTER);

      expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
        status: 'RELEASE_PENDING_CREDIT',
        releaseReason: 'CANCELLED',
      });
      expect(await lastAction(t)).toMatchObject({
        previousStatus: status,
        action: 'REQUESTER_SUSPENDED',
        reason: 'requester suspended',
        actorType: 'SYSTEM',
      });
      expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([
        { orderId: SEEDED_ORDER, requesterId: REQUESTER, amount: SEEDED_REWARD },
      ]);
      expect(await creditRequests(t)).toEqual({ releases: 1, transfers: 0 });

      await deliver(t, RELEASE_RESULTS_QUEUE, released());
      expect((await t.orders.findById(SEEDED_ORDER))!.status).toBe('CANCELLED');
    });
  }

  it('leaves a delivered errand to be confirmed whoever is suspended, and auto-confirms it', async () => {
    t = await createTestApp();
    await advance(t, 'DELIVERED');
    const before = await footprint(t);

    await suspend(t, REQUESTER);
    await suspend(t, COURIER);
    expect(await footprint(t)).toEqual(before);

    await backdate(t, 'auto_confirm_at', 1_000);
    expect(await sweep(t)).toMatchObject({ autoConfirmed: 1 });
    expect((await t.orders.findById(SEEDED_ORDER))!.status).toBe('COMPLETION_PENDING_CREDIT');
    expect(await creditRequests(t)).toEqual({ releases: 0, transfers: 1 });
  });

  it('changes nothing more for a repeated message, or another suspension of the same user', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const message = suspension(COURIER);
    await suspend(t, COURIER, message);
    const once = await footprint(t);

    await deliverSuspension(t, message);
    await deliverSuspension(t, suspension(COURIER));

    expect(await footprint(t)).toEqual(once);
  });

  it('changes nothing for a user the User Service says is active again', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const before = await footprint(t);

    // Suspended and reactivated before the message was handled: the User Service has the last word.
    await deliverSuspension(t, suspension(COURIER));

    expect(await footprint(t)).toEqual(before);
  });

  it('retries a suspension while the User Service is down, changing nothing until it answers', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const before = await footprint(t);
    const message = suspension(COURIER);
    t.userService.suspended.add(COURIER);
    t.userService.down = true;

    await expect(deliverSuspension(t, message)).rejects.toBeInstanceOf(
      UserDirectoryUnavailableError,
    );
    expect(await footprint(t)).toEqual(before);
    // Not recorded as handled, so the retry is applied.
    expect((await t.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(0);

    t.userService.down = false;
    await deliverSuspension(t, message);
    expect((await t.orders.findById(SEEDED_ORDER))!.status).toBe('OPEN');
  });

  it('cancels an errand whose requester was suspended while it waited for its reservation', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    const waiting = await footprint(t, orderId);
    // Locked, but left to the reservation reply: no rule moves an errand still waiting for it.
    await suspend(t, REQUESTER);
    expect(await footprint(t, orderId)).toEqual(waiting);

    await reservationReply(t, orderId);

    expect(await t.orders.findById(orderId)).toMatchObject({
      status: 'RELEASE_PENDING_CREDIT',
      releaseReason: 'CANCELLED',
    });
    expect(await lastAction(t, orderId)).toMatchObject({
      previousStatus: 'PENDING_CREDIT',
      action: 'CREDIT_RESERVED',
      reason: 'requester suspended',
      actorType: 'CREDIT_SERVICE',
    });
    expect(await creditRequests(t, orderId)).toEqual({ releases: 1, transfers: 0 });
    await deliver(t, RELEASE_RESULTS_QUEUE, released({ orderId }));
    expect((await t.orders.findById(orderId))!.status).toBe('CANCELLED');
  });

  it('retries a reservation while the User Service is down, never assuming the requester is active', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    const before = await footprint(t, orderId);
    t.userService.down = true;

    await expect(reservationReply(t, orderId)).rejects.toBeInstanceOf(
      UserDirectoryUnavailableError,
    );
    expect(await footprint(t, orderId)).toEqual(before);
    expect((await t.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(0);

    t.userService.down = false;
    await reservationReply(t, orderId);
    expect((await t.orders.findById(orderId))!.status).toBe('OPEN');
  });

  it('lets a picked-up errand continue when its requester is suspended within the delivery period', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    const before = await footprint(t);

    await suspend(t, REQUESTER);

    expect(await footprint(t)).toEqual(before);
  });

  it('refers a picked-up errand at once when its requester is suspended after the delivery period', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    await backdate(t, 'non_delivery_report_at', 1_000);

    await suspend(t, REQUESTER);

    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'DISPUTED',
      courierId: COURIER,
    });
    expect(await lastAction(t)).toMatchObject({
      previousStatus: 'PICKED_UP',
      action: 'DELIVERY_PERIOD_PASSED',
      reason: 'requester suspended',
      actorType: 'SYSTEM',
    });
    expect(await creditRequests(t)).toEqual({ releases: 0, transfers: 0 });
  });

  it('refers a picked-up errand when the delivery period ends after its requester was suspended', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    await suspend(t, REQUESTER);
    expect(await sweep(t)).toMatchObject({ undeliveredReferred: 0 });

    await backdate(t, 'non_delivery_report_at', 1_000);
    expect(await sweep(t)).toMatchObject({ undeliveredReferred: 1, adminsAssigned: 1 });

    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'DISPUTED',
      referredAdminId: 'admin-1',
    });
    expect((await t.orders.findHistory(SEEDED_ORDER)).at(-2)).toMatchObject({
      previousStatus: 'PICKED_UP',
      action: 'DELIVERY_PERIOD_PASSED',
      reason: 'requester suspended',
      actorType: 'SYSTEM',
    });
    expect(await creditRequests(t)).toEqual({ releases: 0, transfers: 0 });
  });

  it('never asks about the requester of a picked-up errand unless they were suspended within its delivery period', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    await backdate(t, 'non_delivery_report_at', 1_000);

    for (let run = 0; run < 3; run++) {
      expect(await sweep(t)).toMatchObject({ undeliveredReferred: 0 });
    }
    expect(t.userService.lookups).toEqual([]);
  });

  it('leaves a picked-up errand to a requester active again when its delivery period ends, asking once', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    await suspend(t, REQUESTER);
    t.userService.suspended.delete(REQUESTER);
    await backdate(t, 'non_delivery_report_at', 1_000);
    const before = await footprint(t);
    t.userService.lookups.length = 0;

    for (let run = 0; run < 3; run++) {
      expect(await sweep(t)).toMatchObject({ undeliveredReferred: 0 });
    }
    expect(t.userService.lookups).toEqual([REQUESTER]);
    expect(await footprint(t)).toEqual(before);
  });

  it('asks again on the next run while the User Service is down', async () => {
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    await suspend(t, REQUESTER);
    await backdate(t, 'non_delivery_report_at', 1_000);
    const before = await footprint(t);

    t.userService.down = true;
    expect(await sweep(t)).toMatchObject({ undeliveredReferred: 0 });
    expect(await footprint(t)).toEqual(before);

    t.userService.down = false;
    expect(await sweep(t)).toMatchObject({ undeliveredReferred: 1 });
  });

  it('still refers disputes when the lookup for a suspended requester fails', async () => {
    t = await createTestApp();
    const disputed = await createPending(t);
    await reservationReply(t, disputed);
    await dispute(t, 'DELIVERED', disputed);
    await advance(t, 'PICKED_UP');
    await suspend(t, REQUESTER);
    await backdate(t, 'non_delivery_report_at', 1_000);
    t.userService.failing.add(REQUESTER);

    expect(await sweep(t)).toMatchObject({ undeliveredReferred: 0, adminsAssigned: 1 });
    expect((await t.orders.findById(disputed))!.referredAdminId).not.toBeNull();
    expect((await t.orders.findById(SEEDED_ORDER))!.status).toBe('PICKED_UP');
  });

  it('changes nothing when a suspension is replayed after the user was reactivated and took the errand again', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const message = suspension(COURIER);
    await suspend(t, COURIER, message);
    t.userService.suspended.delete(COURIER);
    await http(t)
      .post(`/orders/${SEEDED_ORDER}/accept`)
      .set('Authorization', asStranger)
      .send({ expectedVersion: 4 })
      .expect(201);
    const accepted = await footprint(t);

    // The same message again, and a copy under a new ID, as a redriven dead letter would be.
    await deliverSuspension(t, message);
    await deliverSuspension(t, suspension(COURIER));

    expect(await footprint(t)).toEqual(accepted);
  });

  it('treats a second reservation reply as a repeat once a suspension has cancelled the errand', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await suspend(t, REQUESTER);
    await reservationReply(t, orderId);
    const cancelled = await footprint(t, orderId);

    await reservationReply(t, orderId);

    expect(await footprint(t, orderId)).toEqual(cancelled);
  });

  describe('the history, read by someone other than the referred administrator', () => {
    const entryAt = async (auth: string, version: number) => {
      const { body } = await http(t!)
        .get(`/orders/${SEEDED_ORDER}/history`)
        .set('Authorization', auth)
        .expect(200);
      return (body.entries as Array<{ version: number }>).find((e) => e.version === version);
    };

    it("shows the courier the requester's suspension only as a system outcome", async () => {
      t = await createTestApp();
      await advance(t, 'ACCEPTED');
      await suspend(t, REQUESTER);

      expect(await entryAt(asStranger, 4)).toMatchObject({
        previousStatus: 'ACCEPTED',
        newStatus: 'RELEASE_PENDING_CREDIT',
        action: 'SYSTEM_OUTCOME',
        actorType: 'SYSTEM',
        actorId: null,
        reason: null,
      });
    });

    it("shows the requester the courier's suspension only as a system outcome, and the referred administrator all of it", async () => {
      t = await createTestApp();
      await advance(t, 'PICKED_UP');
      await suspend(t, COURIER);
      await sweep(t);
      expect((await t.orders.findById(SEEDED_ORDER))!.referredAdminId).toBe('admin-1');

      expect(await entryAt(asRequester, 5)).toMatchObject({
        action: 'SYSTEM_OUTCOME',
        actorId: null,
        reason: null,
      });
      expect(await entryAt(asAdmin, 5)).toMatchObject({
        action: 'COURIER_SUSPENDED',
        actorId: 'user-suspensions',
        reason: 'courier suspended',
      });
    });
  });
});
