import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@foc/platform';
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
  RELEASE_RESULTS_QUEUE,
  SECRET,
  SEEDED_ORDER,
  TRANSFER_RESULTS_QUEUE,
  createPending,
  deliver,
  dispute,
  footprint,
  outboxOf,
  released,
  reservationReply,
  sweep,
  transferred,
} from './support/lifecycle.js';

/**
 * ORD-11 (#171): a dispute is referred to one administrator, chosen by the scheduler from the
 * User Service's active admins, and only that administrator may decide it, with a reason.
 */
const resolve = (
  t: TestApp,
  auth: string,
  body: { outcome?: string; reason?: string; expectedVersion?: number },
  orderId = SEEDED_ORDER,
) => http(t).post(`/admin/orders/${orderId}/resolve`).set('Authorization', auth).send(body);

const referredAdmin = async (t: TestApp, orderId = SEEDED_ORDER) =>
  (await t.orders.findById(orderId))!.referredAdminId;

const lastHistory = async (t: TestApp, count = 1) =>
  (await t.orders.findHistory(SEEDED_ORDER)).slice(-count);

const alerts = async (t: TestApp) =>
  (
    await t.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM order_operator_alerts WHERE kind = 'REFERRAL_UNASSIGNED'`,
    )
  ).rows[0]!.n;

/** A second errand, created and opened through the API, for load-spreading cases. */
async function secondOrder(t: TestApp): Promise<string> {
  const orderId = await createPending(t);
  await reservationReply(t, orderId);
  return orderId;
}

describe('administrator referral (ORD-11)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('assigns a dispute on the next run, recorded in history without a status change or event', async () => {
    t = await createTestApp();
    await dispute(t, 'DELIVERED');
    const events = (await outboxOf(t, EVENTS.ORDER_STATUS_CHANGED)).length;
    expect(await referredAdmin(t)).toBeNull();

    expect(await sweep(t)).toMatchObject({ adminsAssigned: 1, adminsUnassigned: 0 });

    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      status: 'DISPUTED',
      referredAdminId: 'admin-1',
      version: 7,
    });
    expect(await lastHistory(t)).toMatchObject([
      {
        previousStatus: 'DISPUTED',
        newStatus: 'DISPUTED',
        action: 'ADMIN_ASSIGNED',
        actorType: 'SYSTEM',
        version: 7,
      },
    ]);
    expect(await outboxOf(t, EVENTS.ORDER_STATUS_CHANGED)).toHaveLength(events);
    // Already assigned: a later run changes nothing.
    expect(await sweep(t)).toMatchObject({ adminsAssigned: 0, adminsUnassigned: 0 });
    expect((await t.orders.findById(SEEDED_ORDER))!.version).toBe(7);
  });

  it('gives a new dispute to the admin with the fewest undecided referrals', async () => {
    t = await createTestApp();
    const other = await secondOrder(t);
    await dispute(t, 'DELIVERED');
    await sweep(t);
    expect(await referredAdmin(t)).toBe('admin-1');

    await dispute(t, 'DELIVERED', other);
    await sweep(t);
    expect(await referredAdmin(t, other)).toBe('admin-2');
  });

  it('never refers a dispute to, nor takes a decision from, an admin who was once its courier', async () => {
    t = await createTestApp();
    const step = (path: string, auth: string, expectedVersion: number) =>
      http(t!)
        .post(`/orders/${SEEDED_ORDER}/${path}`)
        .set('Authorization', auth)
        .send({ expectedVersion })
        .expect((response) => expect(response.status).toBeLessThan(300));
    // admin-1 accepts as a student and withdraws; the stranger then fulfils the errand.
    await step('accept', asAdmin, 2);
    await step('withdraw', asAdmin, 3);
    await step('accept', asStranger, 4);
    await step('pickup', asStranger, 5);
    await step('deliver', asStranger, 6);
    await t.orders.transition({
      orderId: SEEDED_ORDER,
      action: 'REPORT_NON_RECEIPT',
      actor: { kind: 'USER', id: 'seed-requester', isAdmin: false },
      expectedVersion: 7,
      correlationId: 'corr-dispute',
    });

    await sweep(t);
    expect(await referredAdmin(t)).toBe('admin-2'); // admin-1 has the lower ID but is conflicted

    const before = await footprint(t);
    const refused = await resolve(t, asAdmin, {
      outcome: 'REQUESTER',
      reason: 'I was the first courier.',
      expectedVersion: before.order!.version,
    }).expect(403);
    expect(refused.body.error.code).toBe('CONFLICT_OF_INTEREST');
    expect(await footprint(t)).toEqual(before);

    const decided = await resolve(t, asOtherAdmin, {
      outcome: 'REQUESTER',
      reason: 'No delivery photo.',
      expectedVersion: before.order!.version,
    }).expect(200);
    expect(decided.body.status).toBe('RELEASE_PENDING_CREDIT');
  });

  it('clears an admin who can no longer act and reassigns on the next run', async () => {
    t = await createTestApp();
    await dispute(t, 'DELIVERED');
    await sweep(t);
    expect(await referredAdmin(t)).toBe('admin-1');

    t.userService.admins.delete('admin-1'); // suspended or demoted in the User Service
    expect(await sweep(t)).toMatchObject({ adminsUnassigned: 1, adminsAssigned: 1 });
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({
      referredAdminId: 'admin-2',
      version: 9,
    });
    expect((await lastHistory(t, 2)).map((entry) => entry.action)).toEqual([
      'ADMIN_UNASSIGNED',
      'ADMIN_ASSIGNED',
    ]);

    // The replaced admin's decision is refused: stale if made from what they last saw,
    // and not theirs to make if made from the current version.
    const body = { outcome: 'COURIER', reason: 'Delivered as agreed.' };
    const stale = await resolve(t, asAdmin, { ...body, expectedVersion: 7 }).expect(409);
    expect(stale.body.error.code).toBe('ORDER_CHANGED');
    const replaced = await resolve(t, asAdmin, { ...body, expectedVersion: 9 }).expect(403);
    expect(replaced.body.error.code).toBe('NOT_REFERRED_ADMIN');
    expect(await outboxOf(t, EVENTS.ORDER_COMPLETION_REQUESTED)).toHaveLength(0);
  });

  it('leaves a dispute unassigned while the User Service is down, then assigns it', async () => {
    t = await createTestApp();
    await dispute(t, 'DELIVERED');
    t.userService.down = true;
    expect(await sweep(t)).toMatchObject({ adminsAssigned: 0, referralAlerts: 0 });
    expect(await referredAdmin(t)).toBeNull();
    expect(await alerts(t)).toBe(0);

    t.userService.down = false;
    await sweep(t);
    expect(await referredAdmin(t)).toBe('admin-1');
  });

  it('raises one REFERRAL_UNASSIGNED alert when no admin is eligible, however many runs', async () => {
    t = await createTestApp();
    t.userService.admins.clear();
    await dispute(t, 'DELIVERED');

    const runs = [await sweep(t), await sweep(t), await sweep(t)];
    expect(runs.map((run) => run.referralAlerts)).toEqual([1, 0, 0]);
    expect(await alerts(t)).toBe(1);
    expect(await referredAdmin(t)).toBeNull();
  });
});

describe('administrator decision (ORD-11)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('refuses a stale or repeated decision with 409 and requests the transfer once', async () => {
    t = await createTestApp();
    await dispute(t, 'DELIVERED');
    await sweep(t); // admin-1, version 7

    const blank = await resolve(t, asAdmin, {
      outcome: 'COURIER',
      reason: '   ',
      expectedVersion: 7,
    });
    expect(blank.status).toBe(422);
    const stale = await resolve(t, asAdmin, {
      outcome: 'REQUESTER',
      reason: 'Seen before assignment.',
      expectedVersion: 6,
    }).expect(409);
    expect(stale.body.error.code).toBe('ORDER_CHANGED');

    const decided = await resolve(t, asAdmin, {
      outcome: 'COURIER',
      reason: '  Photo shows the handover.  ',
      expectedVersion: 7,
    }).expect(200);
    expect(decided.body).toMatchObject({ status: 'COMPLETION_PENDING_CREDIT', version: 8 });

    const repeat = await resolve(t, asAdmin, {
      outcome: 'COURIER',
      reason: 'Again.',
      expectedVersion: 8,
    }).expect(409);
    expect(repeat.body.error.code).toBe('INVALID_ORDER_STATE');
    expect(await outboxOf(t, EVENTS.ORDER_COMPLETION_REQUESTED)).toHaveLength(1);
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toHaveLength(0);

    expect(await lastHistory(t)).toMatchObject([
      {
        action: 'RESOLVE_FOR_COURIER',
        actorType: 'ADMIN',
        actorId: 'admin-1',
        reason: 'Photo shows the handover.',
      },
    ]);
    const decisions = await http(t)
      .get('/admin/orders/decisions')
      .set('Authorization', asOtherAdmin)
      .expect(200);
    expect(decisions.body.items).toEqual([
      {
        orderId: SEEDED_ORDER,
        adminId: 'admin-1',
        outcome: 'COURIER',
        reason: 'Photo shows the handover.',
        decidedAt: expect.any(String),
      },
    ]);
  });

  it('refuses every admin but the assigned one, and requests one release for the requester', async () => {
    t = await createTestApp();
    await dispute(t, 'DELIVERED');
    await sweep(t);
    const body = { outcome: 'REQUESTER', reason: 'No delivery photo.', expectedVersion: 7 };

    const other = await resolve(t, asOtherAdmin, body).expect(403);
    expect(other.body.error.code).toBe('NOT_REFERRED_ADMIN');
    await resolve(t, asRequester, body).expect(403);

    const decided = await resolve(t, asAdmin, body).expect(200);
    expect(decided.body.status).toBe('RELEASE_PENDING_CREDIT');
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toHaveLength(1);
    await resolve(t, asAdmin, { ...body, expectedVersion: 8 }).expect(409);

    // The decision finalises only once the Credit Service confirms the release.
    await deliver(t, RELEASE_RESULTS_QUEUE, released());
    expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({ status: 'CANCELLED' });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toHaveLength(1);
  });

  it('completes a dispute raised before delivery with a receipt that records no delivery', async () => {
    t = await createTestApp();
    await dispute(t, 'PICKED_UP'); // version 5
    await sweep(t); // version 6

    await resolve(t, asAdmin, {
      outcome: 'COURIER',
      reason: 'Courier handed over in person.',
      expectedVersion: 6,
    }).expect(200);
    await deliver(t, TRANSFER_RESULTS_QUEUE, transferred());

    expect((await t.orders.findById(SEEDED_ORDER))!.status).toBe('COMPLETED');
    const receipt = await http(t)
      .get(`/orders/${SEEDED_ORDER}/receipt`)
      .set('Authorization', asRequester)
      .expect(200);
    // The stored receipt keeps the missing delivery; the published one says so and shows when
    // the administrator decided instead.
    expect(receipt.body.deliveryRecorded).toBe(false);
    expect(receipt.body.timestamps.deliveredAt).toBe(receipt.body.timestamps.completionRequestedAt);
    const stored = await t.db.query<{ delivered_at: unknown }>(
      `SELECT delivered_at FROM order_receipts WHERE order_id = $1`,
      [SEEDED_ORDER],
    );
    expect(stored.rows[0]!.delivered_at).toBeNull();
  });

  it('lists the caller’s assigned disputes in full and unassigned ones without private details', async () => {
    t = await createTestApp();
    const other = await secondOrder(t);
    await dispute(t, 'DELIVERED');
    await sweep(t); // SEEDED_ORDER → admin-1
    t.userService.down = true;
    await dispute(t, 'PICKED_UP', other); // stays unassigned

    const mine = await http(t)
      .get('/admin/orders/referred')
      .set('Authorization', asAdmin)
      .expect(200);
    const byId = Object.fromEntries(
      (mine.body.items as Array<{ orderId: string }>).map((item) => [item.orderId, item]),
    );
    expect(byId[SEEDED_ORDER]).toMatchObject({
      assignedToMe: true,
      referredBy: 'REPORT_NON_RECEIPT',
      requesterId: 'seed-requester',
    });
    expect(byId[other]).toMatchObject({ assignedToMe: false, referredBy: 'COURIER_SUSPENDED' });
    expect(JSON.stringify(byId[other])).not.toContain(SECRET.instructions);
    expect(byId[other]).not.toHaveProperty('requesterId');

    const theirs = await http(t)
      .get('/admin/orders/referred')
      .set('Authorization', asOtherAdmin)
      .expect(200);
    expect(theirs.body.items.map((item: { orderId: string }) => item.orderId)).toEqual([other]);

    await http(t).get('/admin/orders/referred').set('Authorization', asStranger).expect(403);
  });
});
