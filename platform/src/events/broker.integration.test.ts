import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerConnection } from './connection.js';
import { EventConsumer } from './consumer.js';
import { EventPublisher } from './publisher.js';
import { EVENTS, userActivatedPayload } from './catalogue.js';
import { EXCHANGE, HEADER_FAILURE, deadLetterQueueName } from './topology.js';

/**
 * Exercises the real broker. Skipped unless RABBITMQ_URL is set, so `npm test`
 * on a laptop without the stack up still passes:
 *
 *   docker compose up -d rabbitmq
 *   RABBITMQ_URL=amqp://foc:foc_dev@localhost:55672 npm test -w @foc/platform
 */
const URL = process.env.RABBITMQ_URL;
const suite = URL ? describe : describe.skip;

// A unique prefix per run, so a re-run never inherits a previous run's messages.
const RUN = Math.random().toString(36).slice(2, 8);
const QUEUE = `foc.test-${RUN}.activation`;

const waitFor = async <T>(fn: () => T | undefined, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for a message');
    await new Promise((r) => setTimeout(r, 25));
  }
};

suite('broker integration', () => {
  let broker: BrokerConnection;
  let publisher: EventPublisher;
  let consumer: EventConsumer;

  beforeAll(async () => {
    broker = new BrokerConnection(
      URL as string,
      `test-${RUN}`,
      [{ queue: QUEUE, routingKeys: [EVENTS.USER_ACTIVATED] }],
      // Short delays: the production backoff is 1s/5s/15s/60s, which no test
      // should sit through. The path exercised is identical.
      [60, 60],
    );
    await broker.connect();
    publisher = new EventPublisher(broker, 'user-service');
    consumer = new EventConsumer(broker);
  }, 30_000);

  afterAll(async () => {
    // Leave no queues behind for the next run.
    try {
      const ch = broker.getChannel();
      await ch.deleteQueue(QUEUE);
      await ch.deleteQueue(deadLetterQueueName(QUEUE));
    } catch {
      /* already gone */
    }
    await broker?.close();
  });

  it('declares its topology against an empty broker', async () => {
    const ch = broker.getChannel();
    // checkQueue throws if the queue does not exist.
    await expect(ch.checkQueue(QUEUE)).resolves.toBeDefined();
    await expect(ch.checkQueue(deadLetterQueueName(QUEUE))).resolves.toBeDefined();
    await expect(ch.checkExchange(EXCHANGE)).resolves.toBeDefined();
  });

  it('delivers an activation to a consumer with its correlation id intact', async () => {
    let seen: { correlationId: string; userId: string } | undefined;
    await consumer.subscribe({
      queue: QUEUE,
      eventType: EVENTS.USER_ACTIVATED,
      payloadSchema: userActivatedPayload,
      handler: (envelope) => {
        seen = { correlationId: envelope.correlationId, userId: envelope.payload.userId };
      },
    });

    await publisher.publish({
      eventType: EVENTS.USER_ACTIVATED,
      schemaVersion: 1,
      aggregateId: 'user-42',
      correlationId: 'trace-from-http',
      payload: { userId: 'user-42', activatedAt: new Date().toISOString() },
    });

    const got = await waitFor(() => seen);
    expect(got.userId).toBe('user-42');
    expect(got.correlationId).toBe('trace-from-http');
  }, 20_000);

  it('retries a transient failure, then succeeds', async () => {
    const queue = `foc.test-${RUN}.retry`;
    const b = new BrokerConnection(
      URL as string,
      `test-${RUN}-retry`,
      [{ queue, routingKeys: ['test.retry'] }],
      [60, 60],
    );
    await b.connect();
    const attempts: number[] = [];
    await new EventConsumer(b).subscribe({
      queue,
      eventType: 'test.retry',
      payloadSchema: userActivatedPayload,
      handler: (_e, ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt < 2) throw new Error('dependency not ready');
      },
    });
    await new EventPublisher(b, 'test').publish({
      eventType: 'test.retry',
      schemaVersion: 1,
      aggregateId: 'a-1',
      correlationId: 'retry-trace',
      payload: { userId: 'a-1', activatedAt: new Date().toISOString() },
    });

    await waitFor(() => (attempts.includes(2) ? attempts : undefined));
    expect(attempts[0]).toBe(1);
    expect(attempts).toContain(2);

    const ch = b.getChannel();
    await ch.deleteQueue(queue);
    await ch.deleteQueue(deadLetterQueueName(queue));
    await b.close();
  }, 25_000);

  it('sets a malformed message aside, with the reason, instead of crashing', async () => {
    const queue = `foc.test-${RUN}.bad`;
    const b = new BrokerConnection(
      URL as string,
      `test-${RUN}-bad`,
      [{ queue, routingKeys: ['test.bad'] }],
      [60, 60],
    );
    await b.connect();

    let handlerRan = false;
    await new EventConsumer(b).subscribe({
      queue,
      eventType: 'test.bad',
      payloadSchema: userActivatedPayload,
      handler: () => {
        handlerRan = true;
      },
    });

    // Bypasses the publisher deliberately: this is what a buggy or older
    // producer would put on the wire.
    b.getChannel().publish(EXCHANGE, 'test.bad', Buffer.from('{"nonsense":true}'), {
      persistent: true,
    });

    const dlq = deadLetterQueueName(queue);
    let dead: Awaited<ReturnType<typeof b.getChannel>['get']> extends infer _ ? any : never;
    for (let i = 0; i < 200 && !dead; i++) {
      dead = await b.getChannel().get(dlq, { noAck: true });
      if (!dead) await new Promise((r) => setTimeout(r, 50));
    }

    expect(dead, 'malformed message should reach the dead-letter queue').toBeTruthy();
    expect(handlerRan, 'handler must never see an invalid payload').toBe(false);
    // An operator inspecting the dead letter must see why, without reading logs.
    expect(String(dead.properties.headers[HEADER_FAILURE])).toMatch(
      /payload invalid|envelope invalid/,
    );

    const ch = b.getChannel();
    await ch.deleteQueue(queue);
    await ch.deleteQueue(dlq);
    await b.close();
  }, 25_000);

  it('keeps the publisher usable while a workflow is still in flight', async () => {
    // EI-FR1.1.2: the action returns its own result without waiting.
    const started = Date.now();
    await publisher.publish({
      eventType: EVENTS.USER_ACTIVATED,
      schemaVersion: 1,
      aggregateId: 'user-99',
      correlationId: 'fast-return',
      payload: { userId: 'user-99', activatedAt: new Date().toISOString() },
    });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 15_000);
});
