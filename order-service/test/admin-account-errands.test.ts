import { afterEach, describe, expect, it } from 'vitest';
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
  REQUESTER,
  SECRET,
  SEEDED_ORDER,
  advance,
  createPending,
  referTo,
  reservationReply,
} from './support/lifecycle.js';

/** ORD-15 (#233): GET /admin/orders, an administrator's view of one account's errands. */
describe("an administrator's view of one account's errands", () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  const list = (query: string, auth = asAdmin) =>
    http(t!).get(`/admin/orders?${query}`).set('Authorization', auth);

  const expectPublicOnly = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      for (const field of ['requesterId', 'courierId', 'deliveryInstructions', 'rejection']) {
        expect(item).not.toHaveProperty(field);
      }
    }
    expect(JSON.stringify(items)).not.toContain(SECRET.instructions);
    expect(JSON.stringify(items)).not.toContain(SECRET.note);
  };

  it('lists every errand a requester posted, newest first, and nothing private', async () => {
    t = await createTestApp();
    const pending = await createPending(t);
    const rejected = await createPending(t);
    await reservationReply(t, rejected, true);
    // Even the errand referred to this administrator is listed without its private details.
    await referTo(t, 'admin-1', pending);

    const { body } = await list(`requesterId=${REQUESTER}`).expect(200);

    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(body.items).toMatchObject([
      { orderId: rejected, status: 'REJECTED' },
      { orderId: pending, status: 'PENDING_CREDIT' },
      { orderId: SEEDED_ORDER, status: 'OPEN' },
    ]);
    expectPublicOnly(body.items);
  });

  it("lists a courier's current errands, and combines both filters", async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');

    const asCourier = await list(`courierId=${COURIER}`).expect(200);
    expect(asCourier.body).toMatchObject({
      total: 1,
      items: [{ orderId: SEEDED_ORDER, status: 'ACCEPTED' }],
    });
    expectPublicOnly(asCourier.body.items);

    const both = await list(`requesterId=${REQUESTER}&courierId=${COURIER}`).expect(200);
    expect(both.body.items.map((item: { orderId: string }) => item.orderId)).toEqual([
      SEEDED_ORDER,
    ]);
    const swapped = await list(`requesterId=${COURIER}`).expect(200);
    expect(swapped.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });

  it('pages through the list', async () => {
    t = await createTestApp();
    const older = await createPending(t);
    const newer = await createPending(t);

    const first = await list(`requesterId=${REQUESTER}&pageSize=2`).expect(200);
    const second = await list(`requesterId=${REQUESTER}&pageSize=2&page=2`).expect(200);

    expect(first.body.items.map((item: { orderId: string }) => item.orderId)).toEqual([
      newer,
      older,
    ]);
    expect(second.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(second.body.items.map((item: { orderId: string }) => item.orderId)).toEqual([
      SEEDED_ORDER,
    ]);
  });

  it('refuses students, anonymous callers and a query naming no account', async () => {
    t = await createTestApp();
    await list(`requesterId=${REQUESTER}`, asRequester).expect(403);
    await list(`requesterId=${REQUESTER}`, asStranger).expect(403);
    await http(t).get(`/admin/orders?requesterId=${REQUESTER}`).expect(401);
    for (const query of [
      '',
      'requesterId=',
      `requesterId=${REQUESTER}&pageSize=101`,
      `requesterId=${REQUESTER}&page=0`,
      `requesterId=${REQUESTER}&status=OPEN`,
    ]) {
      const refused = await list(query);
      expect([refused.status, refused.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
  });
});
