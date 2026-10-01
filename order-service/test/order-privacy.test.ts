import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@foc/platform';
import { LifecycleScheduler } from '../src/orders/lifecycle.scheduler.js';
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
  RELEASE_RESULTS_QUEUE,
  REQUESTER,
  SECRET,
  TRANSFER_RESULTS_QUEUE,
  backdate,
  createPending,
  deliver,
  referTo,
  released,
  reservationReply,
  transferred,
} from './support/lifecycle.js';

/**
 * OS-NFR5.1 privacy suite. At every lifecycle state, every viewer context is checked on every read
 * surface: the default projection, the explicit private view, the status history, the receipt and
 * the open list. Only the requester, the current courier and the administrator the errand was
 * referred to may see delivery instructions, item notes, participant identities or history.
 */
const STRANGER = 'unrelated-student';
const BYSTANDER = 'bystander-student';
const HIDDEN = new Set(['PENDING_CREDIT', 'REJECTED']);

interface Viewer {
  name: string;
  auth?: string;
  userId?: string;
}
const VIEWERS: Viewer[] = [
  { name: 'anonymous' },
  { name: 'requester', auth: asRequester, userId: REQUESTER },
  { name: 'stranger', auth: asStranger, userId: STRANGER },
  { name: 'bystander', auth: asBystander, userId: BYSTANDER },
  { name: 'referred admin', auth: asAdmin, userId: 'admin-1' },
  { name: 'other admin', auth: asOtherAdmin, userId: 'admin-2' },
];

const leaks = (body: unknown, forbidden: string[]) => {
  const text = JSON.stringify(body);
  return forbidden.filter((secret) => text.includes(secret));
};

async function checkPrivacy(
  t: TestApp,
  orderId: string,
  context: { courier: string | null; formerCouriers: string[]; referredAdmin: string | null },
) {
  const order = await t.orders.findById(orderId);
  const state = order!.status;
  const participants = [REQUESTER, context.courier, ...context.formerCouriers].filter(
    (id): id is string => id !== null,
  );
  const forbidden = [SECRET.instructions, SECRET.note, ...participants];

  for (const viewer of VIEWERS) {
    const where = `${viewer.name} @ ${state}`;
    const get = (path: string) => {
      const request = http(t).get(path);
      return viewer.auth ? request.set('Authorization', viewer.auth) : request;
    };
    const full =
      viewer.userId !== undefined &&
      (viewer.userId === REQUESTER ||
        viewer.userId === context.courier ||
        viewer.userId === context.referredAdmin);
    const hidden = HIDDEN.has(state) && !full;

    const surfaces = {
      detail: await get(`/orders/${orderId}`),
      private: await get(`/orders/${orderId}?view=private`),
      history: await get(`/orders/${orderId}/history`),
      receipt: await get(`/orders/${orderId}/receipt`),
      list: await get(`/orders`),
    };

    if (!viewer.auth) {
      for (const response of Object.values(surfaces)) expect(response.status, where).toBe(401);
      continue;
    }

    // The open list never carries private data, whoever asks.
    expect(surfaces.list.status, where).toBe(200);
    expect(leaks(surfaces.list.body, forbidden), `${where} list`).toEqual([]);

    if (full) {
      expect(surfaces.detail.status, where).toBe(200);
      expect(surfaces.detail.body.deliveryInstructions, where).toBe(SECRET.instructions);
      expect(surfaces.private.status, where).toBe(200);
      expect(surfaces.history.status, where).toBe(200);
      expect(surfaces.history.body.entries.length, where).toBeGreaterThan(0);
      expect(surfaces.receipt.status, where).toBe(state === 'COMPLETED' ? 200 : 404);
      continue;
    }

    const expected = hidden ? 404 : 403;
    expect(surfaces.detail.status, where).toBe(hidden ? 404 : 200);
    expect(surfaces.private.status, where).toBe(expected);
    expect(surfaces.history.status, where).toBe(expected);
    expect(surfaces.receipt.status, where).toBe(expected);
    for (const [surface, response] of Object.entries(surfaces)) {
      expect(leaks(response.body, forbidden), `${where} ${surface}`).toEqual([]);
    }
  }

  // Status events are public facts: no participant or delivery details, ever.
  const events = await t.db.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
    [orderId, EVENTS.ORDER_STATUS_CHANGED],
  );
  for (const { payload } of events.rows) {
    expect(Object.keys(payload).sort()).toEqual([
      'newStatus',
      'occurredAt',
      'orderId',
      'previousStatus',
    ]);
  }
}

const command = (t: TestApp, orderId: string, path: string, auth: string, version: number) =>
  http(t)
    .post(`/orders/${orderId}/${path}`)
    .set('Authorization', auth)
    .send({ expectedVersion: version })
    .expect((response) => {
      if (response.status >= 300) throw new Error(`${path}: ${JSON.stringify(response.body)}`);
    });

describe('privacy across the lifecycle (OS-NFR5.1, OS-FR2.1.2)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('leaks nothing to a former courier, an unrelated student or an unreferred administrator', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await referTo(t, 'admin-1', orderId);
    const context = {
      courier: null as string | null,
      formerCouriers: [] as string[],
      referredAdmin: 'admin-1',
    };
    await checkPrivacy(t, orderId, context);

    await reservationReply(t, orderId);
    await checkPrivacy(t, orderId, context); // OPEN

    await command(t, orderId, 'accept', asStranger, 2);
    context.courier = STRANGER;
    await checkPrivacy(t, orderId, context); // ACCEPTED

    await command(t, orderId, 'withdraw', asStranger, 3);
    context.courier = null;
    context.formerCouriers.push(STRANGER);
    await checkPrivacy(t, orderId, context); // OPEN again; the stranger withdrew

    await command(t, orderId, 'accept', asBystander, 4);
    context.courier = BYSTANDER;
    await checkPrivacy(t, orderId, context);
    await command(t, orderId, 'pickup', asBystander, 5);
    await checkPrivacy(t, orderId, context);
    await command(t, orderId, 'deliver', asBystander, 6);
    await checkPrivacy(t, orderId, context);
    await command(t, orderId, 'confirm-receipt', asRequester, 7);
    await checkPrivacy(t, orderId, context); // COMPLETION_PENDING_CREDIT
    await deliver(t, TRANSFER_RESULTS_QUEUE, transferred({ orderId, courierId: BYSTANDER }));
    await checkPrivacy(t, orderId, context); // COMPLETED
  });

  it('removes a timed-out courier from private access and keeps closed orders private', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await reservationReply(t, orderId);
    await command(t, orderId, 'accept', asStranger, 2);
    await backdate(t, 'accepted_at', 31 * 60_000, orderId);
    await new LifecycleScheduler(t.orders, {
      pickupTimeoutMs: 30 * 60_000,
      creditWaitTimeoutMs: 5 * 60_000,
      intervalMs: 10_000,
    }).sweep();
    const context = { courier: null, formerCouriers: [STRANGER], referredAdmin: null };
    await checkPrivacy(t, orderId, context); // OPEN; the stranger was removed

    await command(t, orderId, 'cancel', asRequester, 4);
    await checkPrivacy(t, orderId, context); // RELEASE_PENDING_CREDIT
    await deliver(t, RELEASE_RESULTS_QUEUE, released({ orderId }));
    await checkPrivacy(t, orderId, context); // CANCELLED
  });

  it('keeps a rejected request private to its requester, denying an unreferred administrator', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await reservationReply(t, orderId, true);
    await checkPrivacy(t, orderId, { courier: null, formerCouriers: [], referredAdmin: null });
  });
});
