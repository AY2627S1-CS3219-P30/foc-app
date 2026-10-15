import type { ConsumeMessage } from 'amqplib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrokerConnection,
  EVENTS,
  EventConsumer,
  EventPublisher,
  HEADER_ATTEMPT,
  HEADER_FAILURE,
  deadLetterQueueName,
  userActivatedPayload,
} from '@foc/platform';
import { createMemoryBroker } from '../src/memory-broker.js';

const QUEUE = 'foc.test.activation';
const activation = (userId: string) => ({ userId, activatedAt: '2026-10-08T08:00:00.000Z' });

/** The real connection, consumer and publisher, over the in-memory broker. */
async function connect(delays: number[] = [5, 5]) {
  const memory = createMemoryBroker();
  const broker = new BrokerConnection(
    'amqp://memory',
    'test',
    [{ queue: QUEUE, routingKeys: [EVENTS.USER_ACTIVATED] }],
    delays,
    { connect: memory.connect },
  );
  const consumer = new EventConsumer(broker);
  const publisher = new EventPublisher(broker, 'user-service');
  await broker.connect();
  return { memory, broker, consumer, publisher };
}

/** Reads a queue the way an operator's tool would: one message off it, left unacknowledged. */
async function peek(broker: BrokerConnection, queue: string): Promise<ConsumeMessage> {
  const channel = broker.getChannel();
  return new Promise((resolve) => void channel.consume(queue, (m) => m && resolve(m)));
}

describe('in-memory broker (for suites without RabbitMQ)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('routes a published event to the queue bound to its type, and nowhere else', async () => {
    const { broker, consumer, publisher } = await connect();
    close = () => broker.close();
    const seen: string[] = [];
    await consumer.subscribe({
      queue: QUEUE,
      eventType: EVENTS.USER_ACTIVATED,
      payloadSchema: userActivatedPayload,
      handler: (e) => void seen.push(e.payload.userId),
    });
    await publisher.publish({
      eventType: EVENTS.USER_ACTIVATED,
      schemaVersion: 1,
      aggregateId: 'u-1',
      correlationId: 'c-1',
      payload: activation('u-1'),
    });
    await vi.waitFor(() => expect(seen).toEqual(['u-1']));
  });

  it('retries through the delay queues, then dead-letters with the reason and attempt count', async () => {
    const { memory, broker, consumer, publisher } = await connect([5, 5]);
    close = () => broker.close();
    let calls = 0;
    await consumer.subscribe({
      queue: QUEUE,
      eventType: EVENTS.USER_ACTIVATED,
      payloadSchema: userActivatedPayload,
      handler: () => {
        calls += 1;
        throw new Error('ledger unavailable');
      },
    });
    await publisher.publish({
      eventType: EVENTS.USER_ACTIVATED,
      schemaVersion: 1,
      aggregateId: 'u-2',
      correlationId: 'c-2',
      payload: activation('u-2'),
    });

    const dlq = deadLetterQueueName(QUEUE);
    await vi.waitFor(() => expect(memory.depth(dlq)).toBe(1));
    expect(calls).toBe(3); // the first try and one per delay
    expect(memory.depth(QUEUE)).toBe(0);
    const dead = await peek(broker, dlq);
    expect(dead.properties.headers).toMatchObject({
      [HEADER_ATTEMPT]: 3,
      [HEADER_FAILURE]: 'ledger unavailable',
    });
    expect(JSON.parse(dead.content.toString())).toMatchObject({ aggregateId: 'u-2' });
  });

  it('dead-letters a rejected message with an x-death header, as RabbitMQ does', async () => {
    const { memory, broker } = await connect();
    close = () => broker.close();
    const channel = broker.getChannel();
    await channel.consume(QUEUE, (m) => m && channel.nack(m, false, false));
    memory.publish('', QUEUE, { not: 'an envelope' });

    const dead = await peek(broker, deadLetterQueueName(QUEUE));
    expect(dead.properties.headers?.['x-death']).toEqual([
      expect.objectContaining({ reason: 'rejected', queue: QUEUE, count: 1 }),
    ]);
  });

  it('redelivers what a closed channel left unacknowledged', async () => {
    const { memory, broker } = await connect();
    close = () => broker.close();
    const first = broker.getChannel();
    const held = new Promise<void>((resolve) => void first.consume(QUEUE, (m) => m && resolve()));
    memory.publish('', QUEUE, { hello: 1 });
    await held;
    expect(memory.depth(QUEUE)).toBe(1);

    await first.close(); // the broker reconnects on its own
    await vi.waitFor(() => expect(broker.isConnected()).toBe(true), { timeout: 5_000 });
    const again = await peek(broker, QUEUE);
    expect(again.fields.redelivered).toBe(true);
  });

  it('refuses a publish to an exchange nobody declared', async () => {
    const { broker } = await connect();
    close = () => broker.close();
    const result = new Promise<unknown>((resolve) =>
      broker.getChannel().publish('foc.nowhere', 'x', Buffer.from('{}'), {}, resolve),
    );
    await expect(result).resolves.toBeInstanceOf(Error);
  });
});
