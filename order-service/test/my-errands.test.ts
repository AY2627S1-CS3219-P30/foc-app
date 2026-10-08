import { afterEach, describe, expect, it } from 'vitest';
import {
  asBystander,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  SECRET,
  SEEDED_ORDER,
  advance,
  createPending,
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
    expect(withdrawn.body).toEqual({ items: [] });
  });

  it('shows an unrelated student nothing', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');

    const { body } = await mine(asBystander);
    expect(body).toEqual({ items: [] });
  });
});
