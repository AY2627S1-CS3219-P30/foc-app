import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';

const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe('Order schema and projections', () => {
  it('retrieves the migrated seed and keeps exact instructions from unrelated students', async () => {
    const response = await http(t)
      .get(`/orders/${SEEDED_ORDER}`)
      .set('Authorization', asStranger)
      .expect(200);
    expect(response.body).toMatchObject({
      orderId: SEEDED_ORDER,
      status: 'OPEN',
      supplier: { name: 'The Deck', building: 'COM2' },
      items: [{ name: 'Chicken rice', quantity: 1 }],
      reward: 2,
    });
    expect(response.body).not.toHaveProperty('deliveryInstructions');
    expect(response.body).not.toHaveProperty('requesterId');
  });

  it('shows participant fields to the requester and an administrator', async () => {
    for (const token of [asRequester, asAdmin]) {
      const response = await http(t)
        .get(`/orders/${SEEDED_ORDER}`)
        .set('Authorization', token)
        .expect(200);
      expect(response.body).toMatchObject({
        requesterId: 'seed-requester',
        deliveryInstructions: 'Meet beside the security desk',
      });
    }
  });

  it('hides pending and rejected errands from non-participants as not found', async () => {
    await t.db.query(`UPDATE orders SET status = 'PENDING_CREDIT' WHERE order_id = $1`, [
      SEEDED_ORDER,
    ]);
    await http(t).get(`/orders/${SEEDED_ORDER}`).set('Authorization', asStranger).expect(404);
    await http(t).get(`/orders/${SEEDED_ORDER}`).set('Authorization', asRequester).expect(200);
  });

  it('records who or what changed a status, the transition, version and timestamp', async () => {
    const history = await t.db.query<{
      previous_status: string;
      new_status: string;
      actor_type: string;
      order_version: number;
      occurred_at: Date;
    }>(
      `SELECT previous_status, new_status, actor_type, order_version, occurred_at
         FROM order_status_history WHERE order_id = $1 ORDER BY order_version`,
      [SEEDED_ORDER],
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows[0]).toMatchObject({
      previous_status: null,
      new_status: 'PENDING_CREDIT',
      actor_type: 'REQUESTER',
      order_version: 1,
    });
    expect(history.rows[1]).toMatchObject({
      previous_status: 'PENDING_CREDIT',
      new_status: 'OPEN',
      actor_type: 'CREDIT_SERVICE',
      order_version: 2,
    });
    expect(new Date(history.rows[1]!.occurred_at).toISOString()).toBeTruthy();
  });

  it('rejects unauthenticated and malformed reads with the shared envelope', async () => {
    expect((await http(t).get(`/orders/${SEEDED_ORDER}`).expect(401)).body.error.code).toBe(
      'TOKEN_MISSING',
    );
    expect(
      (await http(t).get('/orders/not-a-uuid').set('Authorization', asRequester).expect(400)).body
        .error.code,
    ).toBe('INVALID_ORDER_ID');
  });
});
