import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, UnparseableMessageError } from '@foc/platform';
import { LifecycleScheduler } from '../src/orders/lifecycle.scheduler.js';
import { ORDER_ACTIONS } from '../src/orders/order-state-machine.js';
import {
  asBystander,
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
  TRANSFER_RESULTS_QUEUE,
  advance,
  backdate,
  deliver,
  footprint,
  outboxOf,
  released,
  transferred,
} from './support/lifecycle.js';

const MINUTE = 60_000;
const post = (t: TestApp, path: string, auth: string, expectedVersion: number) =>
  http(t)
    .post(`/orders/${SEEDED_ORDER}/${path}`)
    .set('Authorization', auth)
    .send({ expectedVersion });
const scheduler = (t: TestApp, pickupTimeoutMs = 30 * MINUTE) =>
  new LifecycleScheduler(t.orders, {
    pickupTimeoutMs,
    creditWaitTimeoutMs: 5 * MINUTE,
    intervalMs: 10_000,
  });
const releaseRequest = { orderId: SEEDED_ORDER, requesterId: REQUESTER, amount: SEEDED_REWARD };

describe('cancellation, withdrawal and expiry (ORD-05)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('lets the requester cancel an OPEN order and finalises CANCELLED on the release, once', async () => {
    t = await createTestApp();
    const cancelled = await post(t, 'cancel', asRequester, 2).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'RELEASE_PENDING_CREDIT', version: 3 });
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({ releaseReason: 'CANCELLED' });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([releaseRequest]);

    const pending = await footprint(t);
    for (const wrong of [
      released({ amount: SEEDED_REWARD + 1 }),
      released({ requesterId: COURIER }),
      released({ aggregateId: randomUUID() }),
    ]) {
      await expect(deliver(t, RELEASE_RESULTS_QUEUE, wrong)).rejects.toBeInstanceOf(
        UnparseableMessageError,
      );
    }
    // A transfer can never close an order that is waiting for a release.
    await expect(deliver(t, TRANSFER_RESULTS_QUEUE, transferred())).rejects.toBeInstanceOf(
      UnparseableMessageError,
    );
    expect(await footprint(t)).toEqual(pending);

    const transactionId = randomUUID();
    const confirmation = released({ transactionId });
    for (let i = 0; i < 20; i++) await deliver(t, RELEASE_RESULTS_QUEUE, confirmation);
    await deliver(t, RELEASE_RESULTS_QUEUE, released({ transactionId }));
    const closed = await t.orders.findById(SEEDED_ORDER);
    expect(closed).toMatchObject({ status: 'CANCELLED', creditTransactionId: transactionId });
    expect(closed!.releasedAt).not.toBeNull();
    expect((await footprint(t)).history).toBe(pending.history + 1);
    await expect(
      deliver(t, RELEASE_RESULTS_QUEUE, released({ transactionId: randomUUID() })),
    ).rejects.toBeInstanceOf(UnparseableMessageError);
  });

  it('lets the requester cancel an ACCEPTED order before pickup, and never after', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    expect((await post(t, 'cancel', asStranger, 3)).status).toBe(403);
    expect((await post(t, 'cancel', asBystander, 3)).status).toBe(403);
    await post(t, 'cancel', asRequester, 3).expect(200);
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([releaseRequest]);

    await t.close();
    t = await createTestApp();
    await advance(t, 'PICKED_UP');
    const picked = await footprint(t);
    const refused = await post(t, 'cancel', asRequester, 4);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'INVALID_ORDER_STATE']);
    expect(await footprint(t)).toEqual(picked);
  });

  it('returns a withdrawn order to OPEN before its deadline and removes the courier', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const deadline = (await t.orders.findById(SEEDED_ORDER))!.acceptanceDeadlineAt;
    expect((await post(t, 'withdraw', asRequester, 3)).status).toBe(403);
    const reopened = await post(t, 'withdraw', asStranger, 3).expect(200);
    expect(reopened.body).toMatchObject({ status: 'OPEN', version: 4 });
    expect(reopened.body.deliveryInstructions).toBeUndefined();
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'OPEN',
      courierId: null,
      acceptedAt: null,
      acceptanceDeadlineAt: deadline,
    });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([]);
    // The former courier is now an unrelated student.
    await http(t)
      .get(`/orders/${SEEDED_ORDER}?view=private`)
      .set('Authorization', asStranger)
      .expect(403);
    // Another courier can take it.
    await http(t)
      .post(`/orders/${SEEDED_ORDER}/accept`)
      .set('Authorization', asBystander)
      .send({ expectedVersion: 4 })
      .expect(201);
  });

  it('expires a withdrawal after the deadline and returns the credits exactly once', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    await backdate(t, 'acceptance_deadline_at', 1_000);
    const withdrawn = await post(t, 'withdraw', asStranger, 3).expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'RELEASE_PENDING_CREDIT' });
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      releaseReason: 'EXPIRED',
      courierId: null,
    });
    await scheduler(t).sweep(); // nothing further is due
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([releaseRequest]);
    await deliver(t, RELEASE_RESULTS_QUEUE, released());
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({ status: 'EXPIRED' });
  });

  it('holds RELEASE_PENDING_CREDIT against every participant, administrator and timer action', async () => {
    t = await createTestApp();
    await post(t, 'cancel', asRequester, 2).expect(200);
    await backdate(t, 'acceptance_deadline_at', MINUTE);
    const pending = await footprint(t);
    for (const action of ORDER_ACTIONS) {
      for (const actor of [
        { kind: 'USER', id: REQUESTER, isAdmin: false },
        { kind: 'USER', id: COURIER, isAdmin: false },
        { kind: 'USER', id: 'admin-1', isAdmin: true },
        { kind: 'SYSTEM', id: null },
      ] as const) {
        const result = await t.orders.transition({
          orderId: SEEDED_ORDER,
          action,
          actor,
          correlationId: 'corr-hold',
        });
        expect(result.kind, `${action} by ${actor.kind}`).toBe('rejected');
      }
    }
    expect(await scheduler(t).sweep()).toMatchObject({ expired: 0, pickupTimedOut: 0 });
    expect(await footprint(t)).toEqual(pending);
  });

  it('refuses a release for a completed order (release after transfer)', async () => {
    t = await createTestApp();
    await advance(t, 'COMPLETION_PENDING_CREDIT');
    await deliver(t, TRANSFER_RESULTS_QUEUE, transferred());
    const completed = await footprint(t);
    await expect(deliver(t, RELEASE_RESULTS_QUEUE, released())).rejects.toBeInstanceOf(
      UnparseableMessageError,
    );
    expect(await footprint(t)).toEqual(completed);
  });
});

describe('lifecycle scheduler (OS-FR6.1.2, OS-FR6.1.3, OS-NFR3.1)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('expires an overdue OPEN order once, even when sweeps overlap', async () => {
    t = await createTestApp();
    await backdate(t, 'acceptance_deadline_at', 5_000);
    const results = await Promise.all([scheduler(t).sweep(), scheduler(t).sweep()]);
    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    await scheduler(t).sweep();
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'RELEASE_PENDING_CREDIT',
      releaseReason: 'EXPIRED',
    });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([releaseRequest]);
    const history = await t.db.query<{ action: string; actor_type: string }>(
      `SELECT action, actor_type FROM order_status_history WHERE order_id = $1 AND new_status = 'RELEASE_PENDING_CREDIT'`,
      [SEEDED_ORDER],
    );
    expect(history.rows).toEqual([{ action: 'ACCEPTANCE_DEADLINE_PASSED', actor_type: 'SYSTEM' }]);
  });

  it('leaves an OPEN order alone before its deadline', async () => {
    t = await createTestApp();
    const before = await footprint(t);
    expect(await scheduler(t).sweep()).toEqual({
      expired: 0,
      pickupTimedOut: 0,
      skipped: 0,
      creditWaitAlerts: 0,
    });
    expect(await footprint(t)).toEqual(before);
  });

  it('removes a courier who has not picked up within the configured timeout', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    await backdate(t, 'accepted_at', 29 * MINUTE);
    expect((await scheduler(t).sweep()).pickupTimedOut).toBe(0);
    // Adjustable per deployment: a 20-minute timeout is already overdue.
    expect((await scheduler(t, 20 * MINUTE).sweep()).pickupTimedOut).toBe(1);
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'OPEN',
      courierId: null,
    });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([]);
  });

  it('expires a timed-out pickup after the deadline and requests one release', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    await backdate(t, 'accepted_at', 31 * MINUTE);
    await backdate(t, 'acceptance_deadline_at', MINUTE);
    await Promise.all([scheduler(t).sweep(), scheduler(t).sweep()]);
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'RELEASE_PENDING_CREDIT',
      releaseReason: 'EXPIRED',
      courierId: null,
    });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toEqual([releaseRequest]);
  });

  it('applies a timer that fell due during downtime as soon as the service is ready', async () => {
    t = await createTestApp();
    await backdate(t, 'acceptance_deadline_at', 3_600_000);
    const started = Date.now();
    const running = scheduler(t);
    running.onApplicationBootstrap();
    try {
      await expect
        .poll(async () => (await t!.orders.findById(SEEDED_ORDER))!.status, { timeout: 5_000 })
        .toBe('RELEASE_PENDING_CREDIT');
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      await running.onApplicationShutdown();
    }
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toHaveLength(1);
  });
});
