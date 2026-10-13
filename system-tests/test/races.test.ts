import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, createEnvelope } from '@foc/platform';
import { TEST_POSTGRES_URL } from '@foc/test-harness';
import { COMPLETION_QUEUE, RELEASE_QUEUE } from '../../credit-service/src/terminal-consumers.js';
import { agreementViolations, economyViolations } from '../src/invariants.js';
import { command, createOrder } from '../src/scenario.js';
import { Stack } from '../src/stack.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;

/** Real-PostgreSQL races across both services (CS-NFR2.1.1, OS-FR3.1.2). */
suite('races on real PostgreSQL', () => {
  let stack: Stack | undefined;
  afterEach(async () => stack?.stop());

  it('OS-FR3.1.2: 100 simultaneous acceptances yield one courier, who alone is paid', async () => {
    const s = (stack = await Stack.start(TEST_POSTGRES_URL!, 'race_accept'));
    await s.issueWallet('requester');
    const couriers = Array.from({ length: 100 }, (_, i) => `courier-${i}`);
    for (const courier of couriers) await s.issueWallet(courier);
    const orderId = await createOrder(s, 'requester', 5);
    await s.settle();

    const attempts = await Promise.all(
      couriers.map((courier) => s.orders.accept(orderId, courier, 2, `race-${courier}`)),
    );
    const winners = attempts.filter((attempt) => attempt.accepted);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!.order!.courierId!;

    await command(s, orderId, 'RECORD_PICKUP', winner);
    await command(s, orderId, 'RECORD_DELIVERY', winner);
    await command(s, orderId, 'CONFIRM_RECEIPT', 'requester');
    await s.settle();
    expect((await s.orders.findById(orderId))!.status).toBe('COMPLETED');
    for (const courier of couriers) {
      expect(await s.wallet(courier)).toEqual({
        available: courier === winner ? 15 : 10,
        reserved: 0,
      });
    }
    expect(await economyViolations(s)).toEqual([]);
  });

  it('delivers a transfer and a release for one reservation at once: exactly one wins', async () => {
    const s = (stack = await Stack.start(TEST_POSTGRES_URL!, 'race_terminal'));
    await s.issueWallet('requester');
    await s.issueWallet('courier');
    const orders: string[] = [];
    for (let i = 0; i < 5; i++) orders.push(await createOrder(s, 'requester', 2));
    await s.settle();

    const subs = Object.fromEntries(s.bus.subscriptions.map((sub) => [sub.queue, sub]));
    const envelope = (orderId: string, kind: 'completion' | 'release') =>
      createEnvelope({
        eventType:
          kind === 'completion'
            ? EVENTS.ORDER_COMPLETION_REQUESTED
            : EVENTS.CREDIT_RELEASE_REQUESTED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'order-service',
        correlationId: `race-${randomUUID()}`,
        payload:
          kind === 'completion'
            ? { orderId, requesterId: 'requester', courierId: 'courier', amount: 2 }
            : { orderId, requesterId: 'requester', amount: 2 },
      });
    await Promise.allSettled(
      orders.flatMap((orderId) =>
        Array.from({ length: 10 }, (_, i) => {
          const kind = i % 2 === 0 ? 'completion' : 'release';
          const queue = kind === 'completion' ? COMPLETION_QUEUE : RELEASE_QUEUE;
          return subs[queue]!.handler(envelope(orderId, kind), { attempt: 1, queue });
        }),
      ),
    );
    for (const orderId of orders) {
      const types = await s.transactionsFor(orderId);
      expect(types[0]).toBe('RESERVE');
      expect(types).toHaveLength(2);
    }
    expect(await economyViolations(s)).toEqual([]);
    const wallet = (await s.wallet('requester'))!;
    expect(wallet.reserved).toBe(0);
    expect(wallet.available + ((await s.wallet('courier'))!.available - 10)).toBe(10);
  });

  it('never lets concurrent reservations overspend one wallet', async () => {
    const s = (stack = await Stack.start(TEST_POSTGRES_URL!, 'race_reserve'));
    await s.issueWallet('requester');
    const orders: string[] = [];
    for (let i = 0; i < 12; i++) orders.push(await createOrder(s, 'requester', 3));
    // Relay all requests, then deliver them to Credit simultaneously.
    const subs = s.bus.subscriptions;
    const reserve = subs.find((sub) => sub.queue === 'foc.credit.reservations')!;
    await Promise.all(
      orders.map((orderId) =>
        reserve.handler(
          createEnvelope({
            eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
            schemaVersion: 1,
            aggregateId: orderId,
            producer: 'order-service',
            correlationId: `race-${orderId}`,
            payload: { orderId, requesterId: 'requester', amount: 3 },
          }),
          { attempt: 1, queue: reserve.queue },
        ),
      ),
    );
    await s.settle();
    const wallet = (await s.wallet('requester'))!;
    expect(wallet).toEqual({ available: 1, reserved: 9 });
    const open = await Promise.all(orders.map((id) => s.orders.findById(id)));
    expect(open.filter((order) => order!.status === 'OPEN')).toHaveLength(3);
    expect(open.filter((order) => order!.status === 'REJECTED')).toHaveLength(9);
    expect(await economyViolations(s)).toEqual([]);
    expect(await agreementViolations(s, true)).toEqual([]);
  });
});
