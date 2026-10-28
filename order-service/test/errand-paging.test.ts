import { afterEach, describe, expect, it } from 'vitest';
import {
  asBystander,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import { REQUESTER, SEEDED_ORDER } from './support/lifecycle.js';

const BYSTANDER = 'bystander-student';
const STRANGER = 'unrelated-student';

/**
 * Copies of the seeded errand, posted by `requesterId`: every third from UTown, rewards 1 to 5.
 * Deadlines and last changes differ by microseconds and repeat, so a page boundary falls between
 * values a millisecond can't tell apart, and on ties only the ID can break.
 */
async function seed(t: TestApp, count: number, requesterId: string, deadlineFrom = '1 hour') {
  const result = await t.db.query<{ order_id: string }>(
    `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                         delivery_instructions, reward, status, version, acceptance_deadline_at,
                         updated_at)
     SELECT gen_random_uuid(), $2,
            CASE WHEN n % 3 = 0 THEN jsonb_set(supplier_snapshot, '{building}', '"UTown"')
                 ELSE supplier_snapshot END,
            items, delivery_zone, delivery_instructions, 1 + n % 5, status, version,
            now() + $4::interval + (n / 4) * interval '1 microsecond',
            now() - (n / 3) * interval '1 microsecond'
       FROM orders, generate_series(1, $3) AS n
      WHERE order_id = $1
     RETURNING order_id`,
    [SEEDED_ORDER, requesterId, count, deadlineFrom],
  );
  return result.rows.map((row) => row.order_id);
}

const ids = (body: Array<{ orderId: string }>) => body.map((order) => order.orderId);

/** Every open errand the caller can see, in the list's order, as the database orders them. */
async function openInOrder(t: TestApp, callerId: string, where = 'true') {
  const result = await t.db.query<{ order_id: string }>(
    `SELECT order_id FROM orders
      WHERE status = 'OPEN' AND acceptance_deadline_at > now() AND requester_id <> $1 AND ${where}
      ORDER BY acceptance_deadline_at, created_at, order_id`,
    [callerId],
  );
  return result.rows.map((row) => row.order_id);
}

async function openPage(t: TestApp, auth: string, query: Record<string, string | number> = {}) {
  const response = await http(t).get('/orders').query(query).set('Authorization', auth).expect(200);
  return { ids: ids(response.body), cursor: response.headers['next-cursor'] as string | undefined };
}

async function minePage(t: TestApp, auth: string, query: Record<string, string | number> = {}) {
  const { body } = await http(t)
    .get('/orders/mine')
    .query(query)
    .set('Authorization', auth)
    .expect(200);
  return {
    ids: ids(body.items),
    cursor: body.nextCursor as string | null,
    truncated: body.truncated,
  };
}

/** Follows the cursor from the first page to the last, and returns every errand on the way. */
async function walk(
  read: (cursor?: string) => Promise<{ ids: string[]; cursor?: string | null }>,
): Promise<{ seen: string[]; pages: number }> {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await read(cursor);
    seen.push(...page.ids);
    cursor = page.cursor ?? undefined;
    pages++;
  } while (cursor);
  return { seen, pages };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('paging open errands', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('reaches every one of 150 open errands, in order and once each', async () => {
    t = await createTestApp();
    await seed(t, 150, BYSTANDER);

    const { seen, pages } = await walk((cursor) =>
      openPage(t!, asStranger, cursor ? { cursor } : {}),
    );

    expect(pages).toBe(2);
    expect(seen).toEqual(await openInOrder(t, STRANGER));
    expect(seen).toHaveLength(151);
  });

  it('answers without a cursor as before: the first 100 as a bare array', async () => {
    t = await createTestApp();
    await seed(t, 150, BYSTANDER);

    const response = await http(t).get('/orders').set('Authorization', asStranger).expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(ids(response.body)).toEqual((await openInOrder(t, STRANGER)).slice(0, 100));
    expect(response.headers['next-cursor']).toEqual(expect.any(String));
    const short = await http(t).get('/orders').set('Authorization', asBystander).expect(200);
    expect(ids(short.body)).toEqual([SEEDED_ORDER]);
    expect(short.headers).not.toHaveProperty('next-cursor');
  });

  it('neither repeats nor skips an errand when others are posted between pages', async () => {
    t = await createTestApp();
    await seed(t, 30, BYSTANDER, '2 hours');
    const before = await openInOrder(t, STRANGER);

    const first = await openPage(t, asStranger, { limit: 10 });
    // One sorts ahead of the cursor, the other past every errand already there.
    await seed(t, 1, BYSTANDER, '30 minutes');
    const [later] = await seed(t, 1, BYSTANDER, '3 hours');
    const rest = await walk((cursor) =>
      openPage(t!, asStranger, { limit: 10, cursor: cursor ?? first.cursor! }),
    );

    const seen = [...first.ids, ...rest.seen];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...before, later]);
  });

  it("narrows to a pickup building in any case and a minimum reward, never the caller's own", async () => {
    t = await createTestApp();
    await seed(t, 60, BYSTANDER);
    await seed(t, 30, STRANGER);
    const matching = await openInOrder(
      t,
      STRANGER,
      `lower(supplier_snapshot->>'building') = 'utown' AND reward >= 4`,
    );

    const { seen, pages } = await walk((cursor) =>
      openPage(t!, asStranger, {
        pickupBuilding: 'utown',
        minReward: 4,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      }),
    );

    expect(matching.length).toBeGreaterThan(3);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(matching);
    const { rows } = await t.db.query<{ requester_id: string }>(
      `SELECT DISTINCT requester_id FROM orders WHERE order_id = ANY($1::uuid[])`,
      [seen],
    );
    expect(rows).toEqual([{ requester_id: BYSTANDER }]);
    expect((await openPage(t, asStranger, { pickupBuilding: 'Nowhere' })).ids).toEqual([]);
  });

  it('refuses a malformed cursor with 400, and a bad limit or reward with 422', async () => {
    t = await createTestApp();
    const mine = encode({ updatedAt: '2026-10-29T00:00:00.000000Z', orderId: SEEDED_ORDER });
    for (const cursor of [
      '',
      'not-a-cursor',
      'x'.repeat(501),
      encode({ deadline: 'soon' }),
      mine,
    ]) {
      const { body } = await http(t)
        .get('/orders')
        .query({ cursor })
        .set('Authorization', asStranger)
        .expect(400);
      expect(body.error).toMatchObject({ code: 'INVALID_CURSOR', message: expect.any(String) });
      expect(body.error.correlationId).toEqual(expect.any(String));
    }
    for (const query of [{ limit: 0 }, { limit: 101 }, { minReward: 'many' }]) {
      const { body } = await http(t)
        .get('/orders')
        .query(query)
        .set('Authorization', asStranger)
        .expect(422);
      expect(body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('paging my errands', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('reaches every one of 150 errands, most recently changed first, once each', async () => {
    t = await createTestApp();
    await seed(t, 150, REQUESTER);
    const { rows } = await t.db.query<{ order_id: string }>(
      `SELECT order_id FROM orders WHERE requester_id = $1 ORDER BY updated_at DESC, order_id`,
      [REQUESTER],
    );

    const first = await minePage(t, asRequester);
    const { seen, pages } = await walk((cursor) =>
      minePage(t!, asRequester, cursor ? { cursor } : {}),
    );

    expect(first).toMatchObject({ truncated: true, cursor: expect.any(String) });
    expect(first.ids).toHaveLength(100);
    expect(pages).toBe(2);
    expect(seen).toEqual(rows.map((row) => row.order_id));
  });

  it('moves an errand changed between pages to the first page, and no later page repeats it', async () => {
    t = await createTestApp();
    await seed(t, 30, REQUESTER);
    const everything = await walk((cursor) =>
      minePage(t!, asRequester, { limit: 10, ...(cursor ? { cursor } : {}) }),
    );

    const first = await minePage(t, asRequester, { limit: 10 });
    // One already shown and one not yet reached change while the student reads.
    const [shown, ahead] = [first.ids[3]!, everything.seen.at(-1)!];
    await t.db.query(`UPDATE orders SET updated_at = clock_timestamp() WHERE order_id = ANY($1)`, [
      [shown, ahead],
    ]);
    const rest = await walk((cursor) =>
      minePage(t!, asRequester, { limit: 10, cursor: cursor ?? first.cursor! }),
    );
    const refreshed = await minePage(t, asRequester, { limit: 10 });

    expect(rest.seen).not.toContain(shown);
    expect(rest.seen).not.toContain(ahead);
    expect(new Set(rest.seen).size).toBe(rest.seen.length);
    expect(refreshed.ids.slice(0, 2).sort()).toEqual([shown, ahead].sort());
    expect(new Set([...refreshed.ids, ...first.ids, ...rest.seen])).toEqual(
      new Set(everything.seen),
    );
  });

  it('keeps the response it gave before for a short list, with no next page', async () => {
    t = await createTestApp();
    const { body } = await http(t)
      .get('/orders/mine')
      .set('Authorization', asBystander)
      .expect(200);
    expect(body).toEqual({ items: [], nextCursor: null, truncated: false });
  });

  it('refuses a malformed cursor, or one from the open list, with 400', async () => {
    t = await createTestApp();
    const open = encode({
      deadline: '2026-10-29T00:00:00.000000Z',
      createdAt: '2026-10-29T00:00:00.000000Z',
      orderId: SEEDED_ORDER,
    });
    for (const cursor of ['%%%', open]) {
      const { body } = await http(t)
        .get('/orders/mine')
        .query({ cursor })
        .set('Authorization', asRequester)
        .expect(400);
      expect(body.error.code).toBe('INVALID_CURSOR');
    }
  });
});
