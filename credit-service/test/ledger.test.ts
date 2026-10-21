import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerItem } from '../src/credits/types.js';
import {
  asAdmin,
  asOther,
  asStudent,
  createTestApp,
  http,
  issue,
  type TestApp,
} from './helpers/app.js';

describe('wallet ledger API (CRD-05)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    for (let n = 1; n <= 3; n++) {
      await testApp.db.transaction((tx) =>
        testApp.credits.reserve(tx, {
          orderId: `order-${n}`,
          requesterId: 'student-1',
          amount: 1,
          correlationId: `corr-${n}`,
          causationId: `event-${n}`,
        }),
      );
    }
  });

  afterAll(async () => testApp.close());

  it('returns immutable activity with resulting balances and a stable cursor', async () => {
    const first = await http(testApp)
      .get('/wallets/me/ledger?limit=2')
      .set('Authorization', asStudent)
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.items[0]).toMatchObject({
      type: 'RESERVE',
      amount: 1,
      resultingTotal: 10,
    });

    const second = await http(testApp)
      .get(`/wallets/me/ledger?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Authorization', asStudent)
      .expect(200);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((item) => item.transactionId);
    expect(new Set(ids).size).toBe(4);
  });

  it('rejects malformed pagination input with stable codes', async () => {
    const limit = await http(testApp)
      .get('/wallets/me/ledger?limit=0')
      .set('Authorization', asStudent)
      .expect(400);
    expect(limit.body.error.code).toBe('INVALID_PAGE_SIZE');
    const cursor = await http(testApp)
      .get('/wallets/me/ledger?cursor=not-a-cursor')
      .set('Authorization', asStudent)
      .expect(400);
    expect(cursor.body.error.code).toBe('INVALID_CURSOR');
  });

  it('audits administrator ledger reads', async () => {
    await http(testApp)
      .get('/admin/wallets/student-1/ledger')
      .set('Authorization', asAdmin)
      .set('X-Correlation-ID', 'admin-ledger-read')
      .expect(200);
    const rows = await testApp.db.query(
      `SELECT resource, correlation_id FROM admin_wallet_reads WHERE resource = 'LEDGER'`,
    );
    expect(rows.rows).toContainEqual({
      resource: 'LEDGER',
      correlation_id: 'admin-ledger-read',
    });
  });
});

describe('ledger total change', () => {
  let testApp: TestApp;

  const reserve = (orderId: string) =>
    testApp.db.transaction((tx) =>
      testApp.credits.reserve(tx, {
        orderId,
        requesterId: 'student-1',
        amount: 3,
        correlationId: `corr-${orderId}`,
        causationId: `reserve-${orderId}`,
      }),
    );

  async function ledger(authorization: string): Promise<LedgerItem[]> {
    const items: LedgerItem[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await http(testApp)
        .get(`/wallets/me/ledger?limit=2${query}`)
        .set('Authorization', authorization)
        .expect(200);
      items.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor);
    return items;
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await issue(testApp, 'student-2');
    await reserve('order-1');
    await testApp.db.transaction((tx) =>
      testApp.credits.release(tx, {
        orderId: 'order-1',
        requesterId: 'student-1',
        amount: 3,
        correlationId: 'corr-order-1',
        causationId: 'release-order-1',
      }),
    );
    await reserve('order-2');
    await testApp.db.transaction((tx) =>
      testApp.credits.transfer(tx, {
        orderId: 'order-2',
        requesterId: 'student-1',
        courierId: 'student-2',
        amount: 3,
        correlationId: 'corr-order-2',
        causationId: 'transfer-order-2',
      }),
    );
  });

  afterAll(async () => testApp.close());

  it('signs each row by how it moved the wallet total', async () => {
    const requester = await ledger(asStudent);
    expect(requester.map(({ type, totalChange }) => [type, totalChange])).toEqual([
      ['TRANSFER', -3],
      ['RESERVE', 0],
      ['RELEASE', 0],
      ['RESERVE', 0],
      ['ISSUE', 10],
    ]);
    const courier = await ledger(asOther);
    expect(courier.map(({ type, totalChange }) => [type, totalChange])).toEqual([
      ['TRANSFER', 3],
      ['ISSUE', 10],
    ]);
  });

  it('matches the difference in resultingTotal across page boundaries', async () => {
    for (const items of [await ledger(asStudent), await ledger(asOther)]) {
      items.forEach((item, n) => {
        expect(item.totalChange).toBe(item.resultingTotal - (items[n + 1]?.resultingTotal ?? 0));
      });
    }
  });
});
