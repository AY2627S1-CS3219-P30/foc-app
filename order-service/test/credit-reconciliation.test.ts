import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@foc/platform';
import { CreditReconciler } from '../src/orders/credit-reconciler.js';
import {
  CreditStatusClient,
  CreditUnavailableError,
  reconciliationDecision,
  type CreditStatus,
} from '../src/orders/credit-status.client.js';
import {
  asAdmin,
  asRequester,
  asStranger,
  createTestApp,
  http,
  type TestApp,
} from './helpers/app.js';
import {
  SEEDED_ORDER,
  advance,
  createPending,
  failAt,
  footprint,
  outboxOf,
} from './support/lifecycle.js';

const MINUTE = 60_000;
type Status = CreditStatus['status'];

/** A Credit stand-in that answers one fixed status, or is down. */
const credit = (status: Status | 'DOWN', detail: CreditStatus['detail'] = null) => ({
  calls: [] as string[],
  async status(orderId: string): Promise<CreditStatus> {
    this.calls.push(orderId);
    if (status === 'DOWN') throw new CreditUnavailableError('down');
    return { orderId, status, detail };
  },
});
const reconciler = (t: TestApp, reader: ReturnType<typeof credit>) =>
  new CreditReconciler(t.orders, reader, {
    staleAfterMs: 5 * MINUTE,
    retryAfterMs: 5 * MINUTE,
    intervalMs: 60_000,
  });

/** Ages an order's wait and marks its requests as relayed, so only reconciliation can help it. */
async function stale(t: TestApp, orderId: string) {
  await t.db.query(
    `UPDATE orders SET created_at = created_at - interval '1 hour',
            completion_requested_at = completion_requested_at - interval '1 hour',
            release_requested_at = release_requested_at - interval '1 hour'
      WHERE order_id = $1`,
    [orderId],
  );
  await t.db.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`);
}

const attempts = (t: TestApp, orderId: string) =>
  t.db
    .query<{ action: string; credit_status: string | null; reissued_event_id: string | null }>(
      `SELECT action, credit_status, reissued_event_id FROM order_reconciliation_attempts WHERE order_id = $1`,
      [orderId],
    )
    .then((result) => result.rows);

describe('reconciliation decision table', () => {
  it.each([
    ['PENDING_CREDIT', 'NONE', 'REISSUE'],
    ['PENDING_CREDIT', 'RESERVED', 'REISSUE'],
    ['PENDING_CREDIT', 'TRANSFERRED', 'ALERT'],
    ['PENDING_CREDIT', 'RELEASED', 'ALERT'],
    ['COMPLETION_PENDING_CREDIT', 'RESERVED', 'REISSUE'],
    ['COMPLETION_PENDING_CREDIT', 'TRANSFERRED', 'REISSUE'],
    ['COMPLETION_PENDING_CREDIT', 'RELEASED', 'ALERT'],
    ['COMPLETION_PENDING_CREDIT', 'NONE', 'ALERT'],
    ['RELEASE_PENDING_CREDIT', 'RESERVED', 'REISSUE'],
    ['RELEASE_PENDING_CREDIT', 'RELEASED', 'REISSUE'],
    ['RELEASE_PENDING_CREDIT', 'TRANSFERRED', 'ALERT'],
    ['RELEASE_PENDING_CREDIT', 'NONE', 'ALERT'],
  ] as const)('%s with Credit %s → %s', (order, creditStatus, expected) => {
    expect(reconciliationDecision(order, creditStatus)).toBe(expected);
  });
});

describe('credit reconciliation job (CRD-07)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  it('re-issues a stale reservation request once and changes nothing else', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await stale(t, orderId);
    const before = await footprint(t, orderId);
    const reader = credit('NONE', 'UNKNOWN');

    const run = await reconciler(t, reader).run();
    expect(run).toMatchObject({ candidates: 1, reissued: 1, alerted: 0 });
    expect(await outboxOf(t, EVENTS.CREDIT_RESERVATION_REQUESTED, orderId)).toEqual([
      { orderId, requesterId: 'seed-requester', amount: 2 },
      { orderId, requesterId: 'seed-requester', amount: 2 },
    ]);
    const after = await footprint(t, orderId);
    expect(after.order).toEqual(before.order); // the order itself never moves
    expect(after.history).toBe(before.history);
    expect(await attempts(t, orderId)).toEqual([
      { action: 'REISSUED', credit_status: 'NONE', reissued_event_id: expect.any(String) },
    ]);

    // Within the retry window, and while the re-issued request is unpublished, nothing repeats.
    expect((await reconciler(t, reader).run()).candidates).toBe(0);
    await t.db.query(`UPDATE outbox_events SET published_at = now()`);
    expect((await reconciler(t, reader).run()).candidates).toBe(0);
  });

  it('re-issues completion and release requests Credit can answer, and alerts on contradictions', async () => {
    t = await createTestApp();
    await advance(t, 'COMPLETION_PENDING_CREDIT');
    await stale(t, SEEDED_ORDER);
    await reconciler(t, credit('TRANSFERRED')).run();
    expect(await outboxOf(t, EVENTS.ORDER_COMPLETION_REQUESTED)).toHaveLength(2);

    await t.close();
    t = await createTestApp();
    await http(t)
      .post(`/orders/${SEEDED_ORDER}/cancel`)
      .set('Authorization', asRequester)
      .send({ expectedVersion: 2 })
      .expect(200);
    await stale(t, SEEDED_ORDER);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const before = await footprint(t);
    const run = await reconciler(t, credit('TRANSFERRED')).run();
    expect(run).toMatchObject({ reissued: 0, alerted: 1 });
    expect(await outboxOf(t, EVENTS.CREDIT_RELEASE_REQUESTED)).toHaveLength(1);
    expect(warn.mock.calls.map((call) => (call[0] as { alert?: string }).alert)).toContain(
      'CREDIT_STATE_CONFLICT',
    );
    const alerts = await t.db.query(
      `SELECT kind, detail FROM order_operator_alerts WHERE order_id = $1`,
      [SEEDED_ORDER],
    );
    expect(alerts.rows).toEqual([
      {
        kind: 'CREDIT_STATE_CONFLICT',
        detail: { orderStatus: 'RELEASE_PENDING_CREDIT', creditStatus: 'TRANSFERRED' },
      },
    ]);
    expect((await footprint(t)).order).toEqual(before.order);
  });

  it('repairs nothing when Credit is unavailable, and records that it tried', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await stale(t, orderId);
    const run = await reconciler(t, credit('DOWN')).run();
    expect(run).toMatchObject({ reissued: 0, creditUnavailable: 1 });
    expect(await outboxOf(t, EVENTS.CREDIT_RESERVATION_REQUESTED, orderId)).toHaveLength(1);
    expect(await attempts(t, orderId)).toEqual([
      { action: 'CREDIT_UNAVAILABLE', credit_status: null, reissued_event_id: null },
    ]);
  });

  it('acts once when runs overlap', async () => {
    t = await createTestApp();
    const ids = [await createPending(t), await createPending(t), await createPending(t)];
    for (const id of ids) await stale(t, id);
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => reconciler(t!, credit('RESERVED')).run()),
    );
    expect(runs.reduce((sum, run) => sum + run.reissued, 0)).toBe(3);
    for (const id of ids) {
      expect(await attempts(t, id)).toHaveLength(1);
      expect(await outboxOf(t, EVENTS.CREDIT_RESERVATION_REQUESTED, id)).toHaveLength(2);
    }
  });

  it.each([/INSERT INTO outbox_events/, /INSERT INTO order_reconciliation_attempts/])(
    'a crash at %s records nothing, and the next run repairs',
    async (boundary) => {
      t = await createTestApp();
      const orderId = await createPending(t);
      await stale(t, orderId);
      const restore = failAt(t, boundary);
      await expect(reconciler(t, credit('NONE')).run()).rejects.toThrow(/injected fault/);
      restore();
      expect(await attempts(t, orderId)).toEqual([]);
      expect(await outboxOf(t, EVENTS.CREDIT_RESERVATION_REQUESTED, orderId)).toHaveLength(1);
      expect((await reconciler(t, credit('NONE')).run()).reissued).toBe(1);
    },
  );

  it('leaves fresh orders and orders whose request is still in the outbox to the relay', async () => {
    t = await createTestApp();
    const fresh = await createPending(t);
    const unrelayed = await createPending(t);
    await t.db.query(
      `UPDATE orders SET created_at = now() - interval '1 hour' WHERE order_id = $1`,
      [unrelayed],
    );
    const reader = credit('NONE');
    expect((await reconciler(t, reader).run()).candidates).toBe(0);
    expect(reader.calls).toEqual([]);
    expect(await attempts(t, fresh)).toEqual([]);
  });

  it('shows recorded attempts to administrators only', async () => {
    t = await createTestApp();
    const orderId = await createPending(t);
    await stale(t, orderId);
    await reconciler(t, credit('NONE')).run();
    const view = await http(t)
      .get('/admin/orders/reconciliation-attempts')
      .set('Authorization', asAdmin)
      .expect(200);
    expect(view.body.items).toEqual([
      expect.objectContaining({
        orderId,
        action: 'REISSUED',
        creditStatus: 'NONE',
        orderStatus: 'PENDING_CREDIT',
      }),
    ]);
    await http(t)
      .get('/admin/orders/reconciliation-attempts')
      .set('Authorization', asStranger)
      .expect(403);
    await expect(t.db.query(`DELETE FROM order_reconciliation_attempts`)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('Credit status client', () => {
  const orderId = randomUUID();
  const respond = (status: number, body: unknown) => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { client: new CreditStatusClient(fetchFn), calls };
  };

  it("sends the reconciliation run's correlation ID, so Credit logs the read under it", async () => {
    const { client, calls } = respond(200, { orderId, status: 'RESERVED', detail: null });
    await client.status(orderId, 'reconcile-run-1');
    expect((calls[0]![1]!.headers as Record<string, string>)['x-correlation-id']).toBe(
      'reconcile-run-1',
    );
  });

  it('reads the status with this service credential', async () => {
    const { client, calls } = respond(200, { orderId, status: 'RESERVED', detail: null, extra: 1 });
    expect(await client.status(orderId)).toEqual({ orderId, status: 'RESERVED', detail: null });
    expect(calls[0]![0]).toBe(
      `http://credit-service.test/internal/orders/${orderId}/credit-status`,
    );
    expect((calls[0]![1]!.headers as Record<string, string>)['x-correlation-id']).toBeUndefined();
    expect((calls[0]![1]!.headers as Record<string, string>)['X-Service-Key']).toBe(
      'test-internal-key-0123456789',
    );
  });

  it.each([
    [401, { error: {} }],
    [500, { error: {} }],
    [200, { orderId: 'someone-else', status: 'RESERVED', detail: null }],
    [200, { orderId, status: 'MAYBE', detail: null }],
  ])('treats %s %j as unavailable', async (status, body) => {
    await expect(respond(status, body).client.status(orderId)).rejects.toBeInstanceOf(
      CreditUnavailableError,
    );
  });

  it('treats a network failure as unavailable', async () => {
    const client = new CreditStatusClient((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(client.status(orderId)).rejects.toBeInstanceOf(CreditUnavailableError);
  });
});
