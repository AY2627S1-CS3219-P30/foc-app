import { afterEach, describe, expect, it } from 'vitest';
import { RABBITMQ_URL, TEST_POSTGRES_URL } from '@foc/test-harness';
import { failNextAt } from '../src/faults.js';
import { agreementViolations, economyViolations } from '../src/invariants.js';
import { RabbitWiring } from '../src/rabbit.js';
import { accept, command, createOrder } from '../src/scenario.js';
import { Stack } from '../src/stack.js';

const suite = TEST_POSTGRES_URL && RABBITMQ_URL ? describe : describe.skip;

/**
 * The full Order↔Credit lifecycle over a real RabbitMQ, with every event published twice, a
 * transient consumer failure retried through the broker's retry queues, and finally every event of
 * the run replayed again. Each operation still has exactly one economic effect.
 */
suite('broker replay over real RabbitMQ', () => {
  let stack: Stack | undefined;
  let wiring: RabbitWiring | undefined;
  afterEach(async () => {
    await wiring?.stop();
    await stack?.stop();
  });

  it('completes and cancels with one effect each under duplicate publication and full replay', async () => {
    stack = await Stack.start(TEST_POSTGRES_URL!, 'broker');
    wiring = await RabbitWiring.start(stack, RABBITMQ_URL!, { replay: true });
    await stack.issueWallet('requester');
    await stack.issueWallet('courier');

    const completed = await createOrder(stack, 'requester', 4);
    const cancelled = await createOrder(stack, 'requester', 2);
    await wiring.settle();
    expect((await stack.orders.findById(completed))!.status).toBe('OPEN');

    // Credit's first transfer attempt crashes mid-transaction; the broker redelivers it.
    const crash = failNextAt(stack.creditDb.db, /UPDATE wallets/);
    await accept(stack, completed, 'courier');
    await command(stack, completed, 'RECORD_PICKUP', 'courier');
    await command(stack, completed, 'RECORD_DELIVERY', 'courier');
    await command(stack, completed, 'CONFIRM_RECEIPT', 'requester');
    await command(stack, cancelled, 'CANCEL', 'requester');
    await wiring.settle();
    crash.restore();
    expect(crash.fired()).toBe(true);

    // Replay everything the run ever published.
    await wiring.republish([...wiring.published]);
    await wiring.settle();

    expect((await stack.orders.findById(completed))!.status).toBe('COMPLETED');
    expect((await stack.orders.findById(cancelled))!.status).toBe('CANCELLED');
    expect(await stack.transactionsFor(completed)).toEqual(['RESERVE', 'TRANSFER']);
    expect(await stack.transactionsFor(cancelled)).toEqual(['RESERVE', 'RELEASE']);
    expect(await stack.wallet('requester')).toEqual({ available: 6, reserved: 0 });
    expect(await stack.wallet('courier')).toEqual({ available: 14, reserved: 0 });
    expect(await economyViolations(stack)).toEqual([]);
    expect(await agreementViolations(stack, true)).toEqual([]);
  });
});
