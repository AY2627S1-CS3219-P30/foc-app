import { afterEach, describe, expect, it } from 'vitest';
import { LifecycleScheduler } from '../src/orders/lifecycle.scheduler.js';
import { decideTransition, type OrderAction } from '../src/orders/order-state-machine.js';
import type { OrderRow, OrderStatus } from '../src/orders/types.js';
import {
  asAdmin,
  asBystander,
  asRequester,
  asStranger,
  asSuspended,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  RELEASE_RESULTS_QUEUE,
  SEEDED_ORDER,
  TRANSFER_RESULTS_QUEUE,
  advance,
  backdate,
  createPending,
  deliver,
  footprint,
  released,
  reservationReply,
  transferred,
} from './support/lifecycle.js';

/**
 * OS-NFR5.1.2: every refused actor or invalid-state mutation returns 403 or 409 and changes
 * nothing. Generated from the transition table: for each reachable state, every command endpoint
 * is tried by every caller, and whatever the table refuses must be refused without a trace.
 */
const ENDPOINTS: Array<[string, OrderAction]> = [
  ['accept', 'ACCEPT'],
  ['pickup', 'RECORD_PICKUP'],
  ['deliver', 'RECORD_DELIVERY'],
  ['confirm-receipt', 'CONFIRM_RECEIPT'],
  ['cancel', 'CANCEL'],
  ['withdraw', 'WITHDRAW'],
];
const CALLERS = [
  { name: 'requester', auth: asRequester, userId: 'seed-requester', isAdmin: false },
  { name: 'stranger', auth: asStranger, userId: 'unrelated-student', isAdmin: false },
  { name: 'bystander', auth: asBystander, userId: 'bystander-student', isAdmin: false },
  { name: 'admin', auth: asAdmin, userId: 'admin-1', isAdmin: true },
];

type Setup = (t: TestApp) => Promise<string>;
const STATES: Array<[OrderStatus, Setup]> = [
  ['PENDING_CREDIT', (t) => createPending(t)],
  [
    'REJECTED',
    async (t) => {
      const id = await createPending(t);
      await reservationReply(t, id, true);
      return id;
    },
  ],
  ['OPEN', async () => SEEDED_ORDER],
  ['ACCEPTED', async (t) => (await advance(t, 'ACCEPTED'), SEEDED_ORDER)],
  ['PICKED_UP', async (t) => (await advance(t, 'PICKED_UP'), SEEDED_ORDER)],
  ['DELIVERED', async (t) => (await advance(t, 'DELIVERED'), SEEDED_ORDER)],
  [
    'COMPLETION_PENDING_CREDIT',
    async (t) => (await advance(t, 'COMPLETION_PENDING_CREDIT'), SEEDED_ORDER),
  ],
  [
    'COMPLETED',
    async (t) => {
      await advance(t, 'COMPLETION_PENDING_CREDIT');
      await deliver(t, TRANSFER_RESULTS_QUEUE, transferred());
      return SEEDED_ORDER;
    },
  ],
  [
    'RELEASE_PENDING_CREDIT',
    async (t) => {
      await http(t)
        .post(`/orders/${SEEDED_ORDER}/cancel`)
        .set('Authorization', asRequester)
        .send({ expectedVersion: 2 })
        .expect(200);
      return SEEDED_ORDER;
    },
  ],
  [
    'CANCELLED',
    async (t) => {
      await http(t)
        .post(`/orders/${SEEDED_ORDER}/cancel`)
        .set('Authorization', asRequester)
        .send({ expectedVersion: 2 })
        .expect(200);
      await deliver(t, RELEASE_RESULTS_QUEUE, released());
      return SEEDED_ORDER;
    },
  ],
  [
    'EXPIRED',
    async (t) => {
      await backdate(t, 'acceptance_deadline_at', 1_000);
      await new LifecycleScheduler(t.orders, {
        pickupTimeoutMs: 1_800_000,
        creditWaitTimeoutMs: 300_000,
        intervalMs: 10_000,
      }).sweep();
      await deliver(t, RELEASE_RESULTS_QUEUE, released());
      return SEEDED_ORDER;
    },
  ],
];

/** The table's verdict for this caller, resolved the way the service resolves roles. */
function permitted(order: OrderRow, action: OrderAction, userId: string, isAdmin: boolean) {
  if (action === 'ACCEPT') {
    // Any active non-requester student (administrators are students too) may accept.
    return (
      userId !== order.requesterId &&
      decideTransition(order.status, 'ACCEPT', 'OTHER_STUDENT') !== null
    );
  }
  const role =
    userId === order.requesterId
      ? 'REQUESTER'
      : userId === order.courierId
        ? 'ASSIGNED_COURIER'
        : isAdmin
          ? 'ADMIN'
          : 'OTHER_STUDENT';
  return (
    decideTransition(order.status, action, role, {
      acceptanceDeadlinePassed: new Date(order.acceptanceDeadlineAt ?? 0) <= new Date(),
      releaseReason: order.releaseReason ?? undefined,
    }) !== null
  );
}

describe('rejected mutations change nothing (OS-NFR5.1.2)', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it.each(STATES)(
    'in %s, every refused command is 403/409 and leaves no trace',
    async (state, setup) => {
      t = await createTestApp();
      const orderId = await setup(t);
      const before = await footprint(t, orderId);
      expect(before.order!.status).toBe(state);
      const hiddenFrom = (userId: string) =>
        (state === 'PENDING_CREDIT' || state === 'REJECTED') &&
        userId !== before.order!.requesterId;

      let refused = 0;
      for (const [path, action] of ENDPOINTS) {
        for (const caller of CALLERS) {
          if (permitted(before.order!, action, caller.userId, caller.isAdmin)) continue;
          const response = await http(t)
            .post(`/orders/${orderId}/${path}`)
            .set('Authorization', caller.auth)
            .send({ expectedVersion: before.order!.version });
          const where = `${caller.name} ${path} in ${state}`;
          // An order whose existence is private to its requester answers 404 (non-enumeration).
          const allowed = hiddenFrom(caller.userId) ? [404] : [403, 409];
          expect(
            allowed,
            `${where}: ${response.status} ${JSON.stringify(response.body)}`,
          ).toContain(response.status);
          refused += 1;
        }
        const suspended = await http(t)
          .post(`/orders/${orderId}/${path}`)
          .set('Authorization', asSuspended)
          .send({ expectedVersion: before.order!.version });
        expect(suspended.status, `suspended ${path} in ${state}`).toBe(403);
        refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
      expect(await footprint(t, orderId)).toEqual(before);
    },
  );
});
