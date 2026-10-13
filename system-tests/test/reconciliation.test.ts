import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@foc/platform';
import { TEST_POSTGRES_URL } from '@foc/test-harness';
import { Stack } from '../src/stack.js';
import { createOrder, deliverAndConfirm, command } from '../src/scenario.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const REQUESTER = 'requester-1';
const COURIER = 'courier-1';
const REWARD = 2;

/**
 * CRD-07: a repair re-issues an idempotent request, so however a message was lost, duplicated or
 * re-issued — and however many reconciliation runs overlap — Credit records at most one economic
 * effect per operation and the two services converge.
 */
suite('reconciliation repairs with at most one economic effect', () => {
  let stack: Stack | undefined;
  afterEach(async () => stack?.stop());

  const start = async (label: string) => {
    stack = await Stack.start(TEST_POSTGRES_URL!, label);
    await stack.issueWallet(REQUESTER);
    await stack.issueWallet(COURIER);
    return stack;
  };
  const dropOnce = (s: Stack, eventType: string) => {
    let dropped = false;
    s.bus.fault = (envelope) => {
      if (!dropped && envelope.eventType === eventType) {
        dropped = true;
        return 'drop';
      }
      return 'deliver';
    };
  };
  const repair = async (s: Stack) => {
    s.bus.fault = () => 'deliver';
    const runs = await Promise.all(Array.from({ length: 4 }, () => s.reconciler().run()));
    await s.settle();
    return runs.reduce((sum, run) => sum + run.reissued, 0);
  };

  it.each([
    ['the reservation request', EVENTS.CREDIT_RESERVATION_REQUESTED],
    ['the reservation reply', EVENTS.CREDITS_RESERVED],
  ])('converges after losing %s', async (_name, lost) => {
    const s = await start('reserve');
    const orderId = await createOrder(s, REQUESTER, REWARD);
    dropOnce(s, lost);
    await s.settle();
    expect((await s.orders.findById(orderId))!.status).toBe('PENDING_CREDIT');

    expect(await repair(s)).toBe(1);
    expect((await s.orders.findById(orderId))!.status).toBe('OPEN');
    expect(await s.transactionsFor(orderId)).toEqual(['RESERVE']);
    expect(await s.wallet(REQUESTER)).toEqual({ available: 10 - REWARD, reserved: REWARD });
  });

  it.each([
    ['the completion request', EVENTS.ORDER_COMPLETION_REQUESTED],
    ['the transfer reply', EVENTS.CREDITS_TRANSFERRED],
  ])('converges after losing %s', async (_name, lost) => {
    const s = await start('transfer');
    const orderId = await createOrder(s, REQUESTER, REWARD);
    await s.settle();
    dropOnce(s, lost);
    await deliverAndConfirm(s, orderId, REQUESTER, COURIER);
    await s.settle();
    expect((await s.orders.findById(orderId))!.status).toBe('COMPLETION_PENDING_CREDIT');

    expect(await repair(s)).toBe(1);
    const order = await s.orders.findById(orderId);
    expect(order!.status).toBe('COMPLETED');
    expect(await s.transactionsFor(orderId)).toEqual(['RESERVE', 'TRANSFER']);
    expect(await s.wallet(REQUESTER)).toEqual({ available: 10 - REWARD, reserved: 0 });
    expect(await s.wallet(COURIER)).toEqual({ available: 10 + REWARD, reserved: 0 });
  });

  it.each([
    ['the release request', EVENTS.CREDIT_RELEASE_REQUESTED],
    ['the release reply', EVENTS.CREDITS_RELEASED],
  ])('converges after losing %s', async (_name, lost) => {
    const s = await start('release');
    const orderId = await createOrder(s, REQUESTER, REWARD);
    await s.settle();
    dropOnce(s, lost);
    await command(s, orderId, 'CANCEL', REQUESTER);
    await s.settle();
    expect((await s.orders.findById(orderId))!.status).toBe('RELEASE_PENDING_CREDIT');

    expect(await repair(s)).toBe(1);
    expect((await s.orders.findById(orderId))!.status).toBe('CANCELLED');
    expect(await s.transactionsFor(orderId)).toEqual(['RESERVE', 'RELEASE']);
    expect(await s.wallet(REQUESTER)).toEqual({ available: 10, reserved: 0 });
  });

  it('stays at one effect when every message is also duplicated and repairs repeat', async () => {
    const s = await start('duplicates');
    const orderId = await createOrder(s, REQUESTER, REWARD);
    dropOnce(s, EVENTS.CREDITS_RESERVED);
    await s.settle();
    s.bus.fault = () => 'duplicate';
    for (let pass = 0; pass < 3; pass++) {
      await Promise.all(Array.from({ length: 3 }, () => s.reconciler({ retryAfterMs: 0 }).run()));
      await s.settle();
    }
    await deliverAndConfirm(s, orderId, REQUESTER, COURIER);
    await s.settle();
    for (let pass = 0; pass < 3; pass++) {
      await s.reconciler({ retryAfterMs: 0 }).run();
      await s.settle();
    }
    expect((await s.orders.findById(orderId))!.status).toBe('COMPLETED');
    expect(await s.transactionsFor(orderId)).toEqual(['RESERVE', 'TRANSFER']);
    expect(await s.wallet(COURIER)).toEqual({ available: 10 + REWARD, reserved: 0 });
  });

  it('alerts instead of repairing when Order and Credit contradict each other', async () => {
    const s = await start('conflict');
    const orderId = await createOrder(s, REQUESTER, REWARD);
    await s.settle();
    dropOnce(s, EVENTS.CREDITS_TRANSFERRED);
    await deliverAndConfirm(s, orderId, REQUESTER, COURIER);
    await s.settle();
    // Simulate a corrupted Order record: it believes a release is pending for transferred money.
    await s.orderDb.db.query(
      `UPDATE orders SET status = 'RELEASE_PENDING_CREDIT', release_reason = 'CANCELLED',
              release_requested_at = now() WHERE order_id = $1`,
      [orderId],
    );
    const run = await s.reconciler().run();
    await s.settle();
    expect(run, JSON.stringify(run)).toMatchObject({ reissued: 0, alerted: 1 });
    expect(await s.transactionsFor(orderId)).toEqual(['RESERVE', 'TRANSFER']);
    const alerts = await s.orderDb.db.query(
      `SELECT kind FROM order_operator_alerts WHERE order_id = $1`,
      [orderId],
    );
    expect(alerts.rows).toEqual([{ kind: 'CREDIT_STATE_CONFLICT' }]);
  });
});
