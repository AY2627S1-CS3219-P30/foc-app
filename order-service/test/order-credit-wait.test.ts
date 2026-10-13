import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LifecycleScheduler } from '../src/orders/lifecycle.scheduler.js';
import {
  asAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import { createPending, footprint, reservationReply } from './support/lifecycle.js';

const MINUTE = 60_000;
const sweeper = (t: TestApp) =>
  new LifecycleScheduler(t.orders, {
    pickupTimeoutMs: 30 * MINUTE,
    creditWaitTimeoutMs: 5 * MINUTE,
    intervalMs: 10_000,
  });

describe('credit-wait surfacing (OS-FR1.1.3, OS-NFR4.1.2)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  it('surfaces an order waiting over 5 minutes to an operator once, and it still opens later', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    const fresh = await createPending(t);

    // Credit has been down for 6 minutes.
    await t.db.query(
      `UPDATE orders SET created_at = now() - interval '6 minutes' WHERE order_id = $1`,
      [orderId],
    );
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const before = await footprint(t, orderId);

    expect((await sweeper(t).sweep()).creditWaitAlerts).toBe(1);
    expect((await sweeper(t).sweep()).creditWaitAlerts).toBe(0); // raised once
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ orderId, alert: 'CREDIT_WAIT_EXCEEDED' });
    // Surfaced, not rejected: the order is untouched.
    expect(await footprint(t, orderId)).toEqual(before);

    const view = await http(t)
      .get('/admin/orders/pending-credit')
      .set('Authorization', asAdmin)
      .expect(200);
    expect(view.body.items).toHaveLength(1);
    expect(view.body.items[0]).toMatchObject({ orderId, alertRaisedAt: expect.any(String) });
    expect(view.body.items[0].waitingMs).toBeGreaterThanOrEqual(6 * MINUTE - 1_000);
    expect(view.body.items.map((item: { orderId: string }) => item.orderId)).not.toContain(fresh);

    await http(t).get('/admin/orders/pending-credit').set('Authorization', asStranger).expect(403);
    await http(t).get('/admin/orders/pending-credit').expect(401);

    // Credit comes back: the late reservation still opens the order.
    await reservationReply(t, orderId);
    expect(await t.orders.findById(orderId)).toMatchObject({ status: 'OPEN' });
    const after = await http(t)
      .get('/admin/orders/pending-credit')
      .set('Authorization', asAdmin)
      .expect(200);
    expect(after.body.items).toEqual([]);
    // The alert record itself is permanent.
    await expect(
      t.db.query(`DELETE FROM order_operator_alerts WHERE order_id = $1`, [orderId]),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps a pending order queryable by its requester however long it waits', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await t.db.query(
      `UPDATE orders SET created_at = now() - interval '2 hours' WHERE order_id = $1`,
      [orderId],
    );
    await sweeper(t).sweep();
    const view = await http(t)
      .get(`/orders/${orderId}`)
      .set('Authorization', asRequester)
      .expect(200);
    expect(view.body.status).toBe('PENDING_CREDIT');
  });
});
