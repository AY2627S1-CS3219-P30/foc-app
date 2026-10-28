import { afterEach, describe, expect, it } from 'vitest';
import {
  asAdmin,
  asBystander,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  COURIER,
  SECRET,
  SEEDED_ORDER,
  advance,
  createPending,
  referTo,
  reservationReply,
} from './support/lifecycle.js';

/** GET /orders/mine: the caller's errands as requester or current courier */
describe('my errands', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  const mine = (auth: string) =>
    http(t!).get('/orders/mine').set('Authorization', auth).expect(200);

  it('shows the requester their pending and rejected errands, newest change first', async () => {
    t = await createTestApp();
    const pending = await createPending(t);
    const rejected = await createPending(t);
    await reservationReply(t, rejected, true);

    const { body } = await mine(asRequester);

    expect(body.items.map((item: { orderId: string }) => item.orderId)).toEqual([
      rejected,
      pending,
      SEEDED_ORDER,
    ]);
    expect(body.items).toMatchObject([
      {
        status: 'REJECTED',
        myRole: 'REQUESTER',
        rejection: { reason: 'INSUFFICIENT_CREDITS' },
      },
      {
        status: 'PENDING_CREDIT',
        myRole: 'REQUESTER',
        deliveryInstructions: SECRET.instructions,
      },
      { status: 'OPEN', myRole: 'REQUESTER' },
    ]);
  });

  it('shows the courier the errand they accepted, until they withdraw', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');

    const accepted = await mine(asStranger);
    expect(accepted.body.items).toMatchObject([{ orderId: SEEDED_ORDER, myRole: 'COURIER' }]);

    await http(t)
      .post(`/orders/${SEEDED_ORDER}/withdraw`)
      .set('Authorization', asStranger)
      .send({ expectedVersion: 3 })
      .expect(200);
    const withdrawn = await mine(asStranger);
    expect(withdrawn.body).toEqual({ items: [], nextCursor: null, truncated: false });
  });

  it('lets a student with an open errand of their own deliver someone else’s', async () => {
    t = await createTestApp();
    // The requester's seeded errand is open; another student posts one of their own.
    const theirs = await createPending(t, asStranger);
    await reservationReply(t, theirs, false, COURIER);

    await http(t)
      .post(`/orders/${theirs}/accept`)
      .set('Authorization', asRequester)
      .send({ expectedVersion: 2 })
      .expect(201);

    const { body } = await mine(asRequester);
    expect(body.items).toMatchObject([
      { orderId: theirs, status: 'ACCEPTED', myRole: 'COURIER' },
      { orderId: SEEDED_ORDER, status: 'OPEN', myRole: 'REQUESTER' },
    ]);
    // Each role keeps its own rules: they still may not accept their own errand.
    const own = await http(t)
      .post(`/orders/${SEEDED_ORDER}/accept`)
      .set('Authorization', asRequester)
      .send({ expectedVersion: 2 });
    expect([own.status, own.body.error.code]).toEqual([403, 'SELF_ACCEPTANCE_FORBIDDEN']);
    await http(t)
      .post(`/orders/${theirs}/pickup`)
      .set('Authorization', asRequester)
      .send({ expectedVersion: 3 })
      .expect(200);
  });

  it('filters by role and active status', async () => {
    t = await createTestApp();
    const theirs = await createPending(t, asStranger);
    await reservationReply(t, theirs, false, COURIER);
    await http(t)
      .post(`/orders/${theirs}/accept`)
      .set('Authorization', asRequester)
      .send({ expectedVersion: 2 })
      .expect(201);
    const rejected = await createPending(t);
    await reservationReply(t, rejected, true);

    const get = (query: string) =>
      http(t!).get(`/orders/mine${query}`).set('Authorization', asRequester).expect(200);
    expect(
      (await get('?role=REQUESTER&active=true')).body.items.map(
        (o: { orderId: string }) => o.orderId,
      ),
    ).toEqual([SEEDED_ORDER]);
    expect(
      (await get('?role=REQUESTER&active=false')).body.items.map(
        (o: { orderId: string }) => o.orderId,
      ),
    ).toEqual([rejected]);
    expect(
      (await get('?role=COURIER&active=true')).body.items.map(
        (o: { orderId: string }) => o.orderId,
      ),
    ).toEqual([theirs]);
    await http(t).get('/orders/mine?role=OTHER').set('Authorization', asRequester).expect(422);
  });

  it('shows an unrelated student nothing', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');

    const { body } = await mine(asBystander);
    expect(body).toEqual({ items: [], nextCursor: null, truncated: false });
  });

  it('shows an admin only their own errands, not ones referred to them', async () => {
    t = await createTestApp();
    const pending = await createPending(t);
    await referTo(t, 'admin-1', pending);
    // The referral lets the admin read the errand directly...
    await http(t).get(`/orders/${pending}`).set('Authorization', asAdmin).expect(200);

    // ...but it is not theirs, so it stays out of their list.
    const { body } = await mine(asAdmin);
    expect(body).toEqual({ items: [], nextCursor: null, truncated: false });
  });

  it('caps the list at 100 and says when older errands were left out', async () => {
    t = await createTestApp();
    await t.db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version, acceptance_deadline_at)
       SELECT gen_random_uuid(), requester_id, supplier_snapshot, items, delivery_zone,
              delivery_instructions, reward, status, version, acceptance_deadline_at
         FROM orders, generate_series(1, 100)
        WHERE order_id = $1`,
      [SEEDED_ORDER],
    );

    const { body } = await mine(asRequester);
    expect(body.items).toHaveLength(100);
    expect(body.truncated).toBe(true);
  });
});
