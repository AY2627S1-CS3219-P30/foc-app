import { afterEach, describe, expect, it } from 'vitest';
import {
  asAdmin,
  asOtherAdmin,
  asRequester,
  asStranger,
  asSuspended,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';

const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';

describe('open-order discovery and atomic acceptance', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('lists only unexpired OPEN orders through a privacy-safe summary', async () => {
    t = await createTestApp();
    const response = await http(t).get('/orders').set('Authorization', asStranger).expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      orderId: SEEDED_ORDER,
      supplier: { name: 'The Deck' },
      itemSummary: [{ name: 'Chicken rice', quantity: 1 }],
      deliveryZone: 'COM2 Lobby',
      reward: 2,
      status: 'OPEN',
      version: 2,
    });
    expect(response.body[0].timeRemainingSeconds).toBeGreaterThan(0);
    expect(response.body[0]).not.toHaveProperty('deliveryInstructions');
    expect(response.body[0]).not.toHaveProperty('requesterId');

    await t.db.query(`UPDATE orders SET status = 'PENDING_CREDIT' WHERE order_id = $1`, [
      SEEDED_ORDER,
    ]);
    expect(
      (await http(t).get('/orders').set('Authorization', asStranger).expect(200)).body,
    ).toEqual([]);
  });

  it('gives private detail only to participants or the specifically referred administrator', async () => {
    t = await createTestApp();
    await t.db.query(
      `UPDATE orders SET items = '[{"name":"Chicken rice","quantity":1,"note":"No chilli"}]'::jsonb WHERE order_id = $1`,
      [SEEDED_ORDER],
    );
    const publicView = await http(t)
      .get(`/orders/${SEEDED_ORDER}`)
      .set('Authorization', asStranger)
      .expect(200);
    expect(publicView.body.items).toEqual([{ name: 'Chicken rice', quantity: 1 }]);
    await http(t)
      .get(`/orders/${SEEDED_ORDER}?view=private`)
      .set('Authorization', asStranger)
      .expect(403);
    await http(t)
      .get(`/orders/${SEEDED_ORDER}?view=private`)
      .set('Authorization', asAdmin)
      .expect(403);
    const requester = await http(t)
      .get(`/orders/${SEEDED_ORDER}?view=private`)
      .set('Authorization', asRequester)
      .expect(200);
    expect(requester.body.items[0].note).toBe('No chilli');

    await t.db.query(`UPDATE orders SET referred_admin_id = 'admin-1' WHERE order_id = $1`, [
      SEEDED_ORDER,
    ]);
    const referred = await http(t)
      .get(`/orders/${SEEDED_ORDER}?view=private`)
      .set('Authorization', asAdmin)
      .expect(200);
    expect(referred.body.deliveryInstructions).toBe('Meet beside the security desk');
    await http(t)
      .get(`/orders/${SEEDED_ORDER}?view=private`)
      .set('Authorization', asOtherAdmin)
      .expect(403);
  });

  it('lets exactly one repeated attempt accept without a Credit balance check', async () => {
    t = await createTestApp();
    const attempts = [];
    for (let index = 0; index < 2; index++) {
      attempts.push(
        await http(t)
          .post(`/orders/${SEEDED_ORDER}/accept`)
          .set('Authorization', asStranger)
          .send({ expectedVersion: 2 }),
      );
    }
    expect(
      attempts.filter((response) => response.status === 201 || response.status === 200),
    ).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(1);

    const order = await t.orders.findById(SEEDED_ORDER);
    expect(order).toMatchObject({
      status: 'ACCEPTED',
      courierId: 'unrelated-student',
      version: 3,
    });
    expect(
      (
        await t.db.query(
          `SELECT * FROM order_status_history WHERE order_id = $1 AND new_status = 'ACCEPTED'`,
          [SEEDED_ORDER],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await t.db.query(
          `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'order.status-changed'`,
          [SEEDED_ORDER],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('refuses self, suspended, stale-version, expired and non-OPEN acceptance', async () => {
    t = await createTestApp();
    expect(
      (
        await http(t)
          .post(`/orders/${SEEDED_ORDER}/accept`)
          .set('Authorization', asRequester)
          .send({ expectedVersion: 2 })
          .expect(403)
      ).body.error.code,
    ).toBe('SELF_ACCEPTANCE_FORBIDDEN');
    expect(
      (
        await http(t)
          .post(`/orders/${SEEDED_ORDER}/accept`)
          .set('Authorization', asSuspended)
          .send({ expectedVersion: 2 })
          .expect(403)
      ).body.error.code,
    ).toBe('ACCOUNT_SUSPENDED');
    expect(
      (
        await http(t)
          .post(`/orders/${SEEDED_ORDER}/accept`)
          .set('Authorization', asStranger)
          .send({ expectedVersion: 1 })
          .expect(409)
      ).body.error.code,
    ).toBe('ORDER_CHANGED');

    await t.db.query(
      `UPDATE orders SET acceptance_deadline_at = now() - interval '1 second' WHERE order_id = $1`,
      [SEEDED_ORDER],
    );
    expect(
      (
        await http(t)
          .post(`/orders/${SEEDED_ORDER}/accept`)
          .set('Authorization', asStranger)
          .send({ expectedVersion: 2 })
          .expect(409)
      ).body.error.code,
    ).toBe('ACCEPTANCE_DEADLINE_PASSED');

    await t.db.query(
      `UPDATE orders SET status = 'PENDING_CREDIT', acceptance_deadline_at = NULL WHERE order_id = $1`,
      [SEEDED_ORDER],
    );
    expect(
      (
        await http(t)
          .post(`/orders/${SEEDED_ORDER}/accept`)
          .set('Authorization', asStranger)
          .send({ expectedVersion: 2 })
          .expect(404)
      ).body.error.code,
    ).toBe('NOT_FOUND');
  });

  it('answers a pending or rejected order as missing, revealing neither existence nor status', async () => {
    t = await createTestApp();
    for (const status of ['PENDING_CREDIT', 'REJECTED']) {
      await t.db.query(
        `UPDATE orders SET status = $2, acceptance_deadline_at = NULL,
                rejection_reason = CASE WHEN $2 = 'REJECTED' THEN 'INSUFFICIENT_CREDITS' END
          WHERE order_id = $1`,
        [SEEDED_ORDER, status],
      );
      const refused = await http(t)
        .post(`/orders/${SEEDED_ORDER}/accept`)
        .set('Authorization', asStranger)
        .send({ expectedVersion: 2 })
        .expect(404);
      expect(refused.body.error.details).toBeUndefined();
      expect(JSON.stringify(refused.body)).not.toContain(status);
    }
  });
});
