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

  it('refuses students, anonymous callers and an invalid query', async () => {
    t = await createTestApp();
    await list(`requesterId=${REQUESTER}`, asRequester).expect(403);
    await list(`requesterId=${REQUESTER}`, asStranger).expect(403);
    await list('', asRequester).expect(403);
    await http(t).get(`/admin/orders?requesterId=${REQUESTER}`).expect(401);
    for (const query of [
      'requesterId=',
      `requesterId=${REQUESTER}&pageSize=101`,
      `requesterId=${REQUESTER}&page=0`,
      'status=',
      'status=NOPE',
      'status=OPEN,',
      'sort=oldest',
    ]) {
      const refused = await list(query);
      expect([refused.status, refused.body.error.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
  });
});

/** ADM-06 (#279): the same endpoint with no account named lists every errand, live and past. */
describe('an administrator listing every errand', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  const list = (query: string) =>
    http(t!).get(`/admin/orders?${query}`).set('Authorization', asAdmin);
  const ids = (body: { items: Array<{ orderId: string }> }) =>
    body.items.map((item) => item.orderId);

  it('lists every account’s errands when no account is named, newest first, public fields only', async () => {
    t = await createTestApp();
    const mine = await createPending(t);
    const theirs = await createPending(t, asBystander);

    const { body } = await list('').expect(200);

    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(ids(body)).toEqual([theirs, mine, SEEDED_ORDER]);
    for (const item of body.items) {
      for (const field of ['requesterId', 'courierId', 'deliveryInstructions']) {
        expect(item).not.toHaveProperty(field);
      }
    }
    expect(JSON.stringify(body.items)).not.toContain(SECRET.instructions);
  });

  it('filters by one or more statuses, on its own or with an account', async () => {
    t = await createTestApp();
    const pending = await createPending(t);
    const rejected = await createPending(t, asBystander);
    await reservationReply(t, rejected, true, 'bystander-student');

    const open = await list('status=OPEN').expect(200);
    expect(open.body).toMatchObject({ total: 1 });
    expect(ids(open.body)).toEqual([SEEDED_ORDER]);

    const waitingOrRejected = await list('status=PENDING_CREDIT,REJECTED').expect(200);
    expect(waitingOrRejected.body).toMatchObject({ total: 2 });
    expect(ids(waitingOrRejected.body)).toEqual([rejected, pending]);

    const oneAccount = await list(`requesterId=${REQUESTER}&status=PENDING_CREDIT,OPEN`).expect(
      200,
    );
    expect(ids(oneAccount.body)).toEqual([pending, SEEDED_ORDER]);
  });

  it('pages through every errand', async () => {
    t = await createTestApp();
    const older = await createPending(t);
    const newer = await createPending(t, asBystander);

    const first = await list('pageSize=2').expect(200);
    const second = await list('pageSize=2&page=2').expect(200);

    expect(ids(first.body)).toEqual([newer, older]);
    expect(second.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(ids(second.body)).toEqual([SEEDED_ORDER]);
  });
});
