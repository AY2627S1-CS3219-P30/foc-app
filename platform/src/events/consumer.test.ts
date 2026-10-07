import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { ChannelModel, ConsumeMessage, Options } from 'amqplib';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../metrics.js';
import { userActivatedPayload } from './catalogue.js';
import { BrokerConnection } from './connection.js';
import { EventConsumer, UnparseableMessageError, type SubscribeOptions } from './consumer.js';
import { createEnvelope } from './envelope.js';
import {
  DLX,
  HEADER_ATTEMPT,
  HEADER_ORIGINAL_QUEUE,
  deadLetterQueueName,
  retryExchangeName,
  retryQueueName,
  type SubscriptionSpec,
} from './topology.js';

/**
 * The broker's failure modes, without a broker: a fake channel and connection
 * that record what was declared, consumed, published and settled, and can be
 * closed the ways a real one is.
 */
type Delivery = (message: ConsumeMessage | null) => void;
let deliveryTag = 0;

class FakeChannel extends EventEmitter {
  /** The next consume() fails the way a server-side refusal does: the channel is closed. */
  static failNextConsume = false;
  open = true;
  readonly queues = new Map<string, Options.AssertQueue>();
  readonly consumers = new Map<string, Delivery>();
  readonly published: Array<{
    exchange: string;
    routingKey: string;
    headers: Record<string, unknown>;
  }> = [];
  readonly acked: ConsumeMessage[] = [];
  readonly nacked: Array<{ message: ConsumeMessage; requeue: boolean }> = [];

  async assertExchange() {
    this.check();
    return {};
  }
  async assertQueue(queue: string, options: Options.AssertQueue = {}) {
    this.check();
    this.queues.set(queue, options);
    return { queue, messageCount: 0, consumerCount: 0 };
  }
  async bindQueue() {
    this.check();
    return {};
  }
  async prefetch() {
    this.check();
  }
  async consume(queue: string, onMessage: Delivery) {
    this.check();
    if (FakeChannel.failNextConsume) {
      FakeChannel.failNextConsume = false;
      this.kill();
      throw new Error('Channel closed by server: 404 (NOT-FOUND)');
    }
    this.consumers.set(queue, onMessage);
    return { consumerTag: `ctag-${queue}` };
  }
  publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: Options.Publish,
    done?: (err: unknown) => void,
  ) {
    this.check();
    this.published.push({ exchange, routingKey, headers: options.headers ?? {} });
    done?.(null);
    return true;
  }
  ack(message: ConsumeMessage) {
    this.check();
    this.acked.push(message);
  }
  nack(message: ConsumeMessage, _allUpTo = false, requeue = true) {
    this.check();
    this.nacked.push({ message, requeue });
  }
  async close() {
    this.shut();
  }
  /** The server closes the channel on its own, as after a PRECONDITION_FAILED. */
  kill() {
    this.emit('error', new Error('Channel closed by server: 406 (PRECONDITION-FAILED)'));
    this.shut();
  }
  shut() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
  deliver(queue: string, body: unknown, headers: Record<string, unknown> = {}): ConsumeMessage {
    const message = {
      content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      fields: { routingKey: 'user.activated', deliveryTag: ++deliveryTag, redelivered: false },
      properties: { headers },
    } as unknown as ConsumeMessage;
    this.consumers.get(queue)!(message);
    return message;
  }
  private check() {
    if (!this.open) throw new Error('Channel closed');
  }
}

class FakeConnection extends EventEmitter {
  open = true;
  readonly channels: FakeChannel[] = [];
  async createConfirmChannel() {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
  async close() {
    this.drop();
  }
  /** The broker goes away: every channel closes, then the connection. */
  drop() {
    if (!this.open) return;
    this.open = false;
    for (const channel of this.channels) channel.shut();
    this.emit('close');
  }
}

const WORK: SubscriptionSpec = { queue: 'foc.test.work', routingKeys: ['user.activated'] };

function setup(subscriptions: SubscriptionSpec[] = [WORK], metrics?: Metrics) {
  const connections: FakeConnection[] = [];
  const outage = { failures: 0 };
  const broker = new BrokerConnection('amqp://broker.test', 'test', subscriptions, [100, 200], {
    connect: async () => {
      if (outage.failures > 0) {
        outage.failures--;
        throw new Error('ECONNREFUSED');
      }
      const connection = new FakeConnection();
      connections.push(connection);
      return connection as unknown as ChannelModel;
    },
  });
  const consumer = new EventConsumer(broker, metrics);
  /** The channel of the n-th connection (default: the latest). */
  const channel = (n = connections.length - 1) => connections[n]!.channels[0]!;
  return { broker, consumer, connections, channel, outage };
}

const activation = (userId = 'user-1') =>
  createEnvelope({
    eventType: 'user.activated',
    schemaVersion: 1,
    aggregateId: userId,
    producer: 'user-service',
    correlationId: 'trace-1',
    payload: { userId, activatedAt: new Date().toISOString() },
  });

function subscription(
  queue: string,
  handler: SubscribeOptions<{ userId: string }>['handler'],
): SubscribeOptions<{ userId: string }> {
  return {
    queue,
    eventType: 'user.activated',
    expectedProducer: 'user-service',
    payloadSchema: userActivatedPayload,
    handler,
  };
}

/** Lets every pending promise chain run to completion. */
const settle = () => new Promise((r) => setImmediate(r));
/** Past the first reconnect delay (1 s), then settled. */
const afterReconnectDelay = async (ms = 1_000) => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};

beforeAll(() => Logger.overrideLogger(false));
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('reconnecting (the consumer survives the broker)', () => {
  it('declares the topology again and re-subscribes after the connection drops', async () => {
    const { broker, consumer, connections, channel } = setup();
    await broker.connect();
    const seen: string[] = [];
    await consumer.subscribe(subscription(WORK.queue, (e) => void seen.push(e.payload.userId)));
    expect(channel(0).consumers.has(WORK.queue)).toBe(true);

    connections[0]!.drop();
    expect(broker.isConnected()).toBe(false);
    await afterReconnectDelay();

    expect(connections).toHaveLength(2);
    const fresh = channel(1);
    expect(fresh.queues.has(WORK.queue)).toBe(true);
    expect(fresh.consumers.has(WORK.queue)).toBe(true);

    const message = fresh.deliver(WORK.queue, activation('user-42'));
    await settle();
    expect(seen).toEqual(['user-42']);
    // Settled on the channel it arrived on: a delivery tag means nothing on another.
    expect(fresh.acked).toEqual([message]);
  });

  it('recovers when the server closes only the channel, without throwing on its error', async () => {
    const { broker, consumer, connections, channel } = setup();
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, () => undefined));

    expect(() => channel(0).kill()).not.toThrow();
    // The connection is dropped too, so everything is rebuilt from one place.
    expect(connections[0]!.open).toBe(false);
    await afterReconnectDelay();

    expect(connections).toHaveLength(2);
    expect(channel(1).consumers.has(WORK.queue)).toBe(true);
    expect(broker.isConnected()).toBe(true);
  });

  it('reconnects once per loss, and ignores anything the old connection says afterwards', async () => {
    const { broker, connections } = setup();
    await broker.connect();

    connections[0]!.drop(); // reports twice: channel close, then connection close
    await afterReconnectDelay(10_000);
    expect(connections).toHaveLength(2);

    connections[0]!.emit('close');
    connections[0]!.channels[0]!.emit('close');
    await afterReconnectDelay(10_000);
    expect(connections).toHaveLength(2);
    expect(broker.isConnected()).toBe(true);
  });

  it('keeps trying, backing off, until the broker is back', async () => {
    const { broker, consumer, connections, channel, outage } = setup();
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, () => undefined));

    outage.failures = 2;
    connections[0]!.drop();
    await afterReconnectDelay(1_000); // attempt 1 fails
    await afterReconnectDelay(2_000); // attempt 2 fails
    expect(connections).toHaveLength(1);
    await afterReconnectDelay(4_000); // attempt 3 succeeds

    expect(connections).toHaveLength(2);
    expect(channel(1).consumers.has(WORK.queue)).toBe(true);
  });

  it('starts over, backing off, rather than run half-subscribed when re-subscribing fails', async () => {
    const { broker, consumer, connections, channel } = setup();
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, () => undefined));

    FakeChannel.failNextConsume = true;
    connections[0]!.drop();
    await afterReconnectDelay(1_000); // reconnects, but the consume is refused
    expect(connections).toHaveLength(2);
    expect(connections[1]!.open).toBe(false);
    await afterReconnectDelay(1_000);
    expect(connections).toHaveLength(2); // the backoff grew instead of resetting
    await afterReconnectDelay(1_000);

    expect(connections).toHaveLength(3);
    expect(channel(2).consumers.has(WORK.queue)).toBe(true);
  });

  it('starts a subscription made while disconnected as soon as it connects', async () => {
    const { broker, consumer, channel } = setup();
    await expect(
      consumer.subscribe(subscription(WORK.queue, () => undefined)),
    ).resolves.toBeUndefined();

    await broker.connect();
    expect(channel(0).consumers.has(WORK.queue)).toBe(true);
  });

  it('resubscribes when the broker cancels the consumer', async () => {
    const { broker, consumer, connections, channel } = setup();
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, () => undefined));

    channel(0).consumers.get(WORK.queue)!(null); // what amqplib delivers on a server cancel
    await settle();
    expect(channel(0).open).toBe(false);
    await afterReconnectDelay();

    expect(connections).toHaveLength(2);
    expect(channel(1).consumers.has(WORK.queue)).toBe(true);
  });
});

describe('retry routing', () => {
  it('sends a failed message back to its own queue only, never to every queue bound to its type', async () => {
    const { broker, consumer, channel } = setup();
    await broker.connect();
    await consumer.subscribe(
      subscription(WORK.queue, () => {
        throw new Error('dependency not ready');
      }),
    );

    const message = channel().deliver(WORK.queue, activation());
    await settle();

    // Keyed by the queue, not by the event type ...
    expect(channel().published).toEqual([
      {
        exchange: retryExchangeName('test', 1),
        routingKey: WORK.queue,
        headers: expect.objectContaining({
          [HEADER_ATTEMPT]: 2,
          [HEADER_ORIGINAL_QUEUE]: WORK.queue,
        }),
      },
    ]);
    expect(channel().acked).toEqual([message]);
    // ... and the delay queue dead-letters onto the default exchange, which delivers by queue name.
    expect(channel().queues.get(retryQueueName('test', 1))).toMatchObject({
      deadLetterExchange: '',
    });
  });

  it('sets a message aside once its attempts are spent', async () => {
    const { broker, consumer, channel } = setup();
    await broker.connect();
    await consumer.subscribe(
      subscription(WORK.queue, () => {
        throw new Error('still broken');
      }),
    );

    channel().deliver(WORK.queue, activation(), { [HEADER_ATTEMPT]: broker.maxAttempts });
    await settle();

    expect(channel().published).toEqual([
      { exchange: DLX, routingKey: WORK.queue, headers: expect.any(Object) },
    ]);
  });

  it('leaves an ordinary queue declared exactly as before (no new arguments)', async () => {
    const { broker, channel } = setup();
    await broker.connect();
    expect(channel().queues.get(WORK.queue)).toEqual({
      durable: true,
      deadLetterExchange: DLX,
      deadLetterRoutingKey: WORK.queue,
    });
    expect(channel().queues.has(deadLetterQueueName(WORK.queue))).toBe(true);
  });
});

describe('subscription trust boundary', () => {
  it('dead-letters an envelope whose event type does not match the handler', async () => {
    const { broker, consumer, channel } = setup();
    await broker.connect();
    const handler = vi.fn();
    await consumer.subscribe(subscription(WORK.queue, handler));

    const wrongType = { ...activation(), eventType: 'user.suspended' };
    const message = channel().deliver(WORK.queue, wrongType);
    await settle();

    expect(handler).not.toHaveBeenCalled();
    expect(channel().published).toEqual([
      { exchange: DLX, routingKey: WORK.queue, headers: expect.any(Object) },
    ]);
    expect(channel().acked).toEqual([message]);
  });

  it('dead-letters an event from a producer the subscription does not trust', async () => {
    const { broker, consumer, channel } = setup();
    await broker.connect();
    const handler = vi.fn();
    await consumer.subscribe(subscription(WORK.queue, handler));

    const forged = { ...activation(), producer: 'order-service' };
    const message = channel().deliver(WORK.queue, forged);
    await settle();

    expect(handler).not.toHaveBeenCalled();
    expect(channel().published).toEqual([
      { exchange: DLX, routingKey: WORK.queue, headers: expect.any(Object) },
    ]);
    expect(channel().acked).toEqual([message]);
  });

  it('dead-letters a handler-discovered permanent contract violation without retrying', async () => {
    const { broker, consumer, channel } = setup();
    await broker.connect();
    await consumer.subscribe(
      subscription(WORK.queue, () => {
        throw new UnparseableMessageError('aggregate does not match payload');
      }),
    );

    const message = channel().deliver(WORK.queue, activation());
    await settle();

    expect(channel().published).toEqual([
      { exchange: DLX, routingKey: WORK.queue, headers: expect.any(Object) },
    ]);
    expect(channel().acked).toEqual([message]);
  });
});

describe('a transient (per-instance) queue', () => {
  const CACHE: SubscriptionSpec = {
    queue: 'foc.test.cache.instance-1',
    routingKeys: ['user.suspended'],
    exclusive: true,
    autoDelete: true,
    messageTtlMs: 5_000,
    maxLength: 1_000,
  };

  it('is private, bounded, and has no dead-letter or retry topology of its own', async () => {
    const { broker, channel } = setup([CACHE]);
    await broker.connect();
    expect(channel().queues.get(CACHE.queue)).toEqual({
      durable: false,
      exclusive: true,
      autoDelete: true,
      messageTtl: 5_000,
      maxLength: 1_000,
    });
    expect(channel().queues.has(deadLetterQueueName(CACHE.queue))).toBe(false);
  });

  it('drops a message its handler fails on, and an unparseable one, instead of retrying', async () => {
    const { broker, consumer, channel } = setup([CACHE]);
    await broker.connect();
    await consumer.subscribe(
      subscription(CACHE.queue, () => {
        throw new Error('boom');
      }),
    );

    const failed = channel().deliver(CACHE.queue, activation());
    const garbage = channel().deliver(CACHE.queue, 'not json');
    await settle();

    expect(channel().published).toEqual([]);
    expect(channel().nacked).toEqual([
      { message: failed, requeue: false },
      { message: garbage, requeue: false },
    ]);
  });

  it('is declared again, and consumed again, after a reconnect', async () => {
    const { broker, consumer, connections, channel } = setup([CACHE]);
    await broker.connect();
    await consumer.subscribe(subscription(CACHE.queue, () => undefined));

    connections[0]!.drop(); // the broker deletes an exclusive queue with its connection
    await afterReconnectDelay();

    expect(channel(1).queues.get(CACHE.queue)).toMatchObject({ exclusive: true });
    expect(channel(1).consumers.has(CACHE.queue)).toBe(true);
  });
});

describe('metrics (PLT-04)', () => {
  /** A counter's or histogram's value for one queue, from the registry the consumer reports to. */
  async function value(
    metric: {
      get(): Promise<{ values: { labels: object; value: number; metricName?: string }[] }>;
    },
    labels: Record<string, string>,
    metricName?: string,
  ): Promise<number> {
    const { values } = await metric.get();
    const series = values.find(
      (v) =>
        (metricName === undefined || v.metricName === metricName) &&
        Object.entries(labels).every(
          ([k, want]) => String((v.labels as Record<string, unknown>)[k]) === want,
        ),
    );
    return series?.value ?? 0;
  }
  const onWork = { queue: WORK.queue, event_type: 'user.activated' };

  it("reports a queue's counters at zero from the moment it subscribes, so its first event shows", async () => {
    const metrics = new Metrics('test-service');
    const { broker, consumer } = setup([WORK], metrics);
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, () => undefined));

    const series = async (metric: { get(): Promise<{ values: { labels: object }[] }> }) =>
      (await metric.get()).values.map((v) => v.labels);
    expect(await series(metrics.eventRetries)).toEqual([onWork]);
    expect(await series(metrics.eventsDeadLettered)).toEqual([
      { queue: WORK.queue, reason: 'unparseable' },
      { queue: WORK.queue, reason: 'exhausted' },
    ]);
  });

  it('counts a handled event, and how long after it occurred it was handled', async () => {
    const metrics = new Metrics('test-service');
    const { broker, consumer, channel } = setup([WORK], metrics);
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, () => undefined));

    channel().deliver(WORK.queue, activation());
    await settle();

    expect(await value(metrics.eventsHandled, onWork)).toBe(1);
    expect(await value(metrics.eventLag, onWork, 'foc_event_lag_seconds_count')).toBe(1);
    expect(
      await value(metrics.eventHandleDuration, onWork, 'foc_event_handle_duration_seconds_count'),
    ).toBe(1);
  });

  it('counts a retry when a handler fails', async () => {
    const metrics = new Metrics('test-service');
    const { broker, consumer, channel } = setup([WORK], metrics);
    await broker.connect();
    await consumer.subscribe(
      subscription(WORK.queue, () => {
        throw new Error('dependency not ready');
      }),
    );

    channel().deliver(WORK.queue, activation());
    await settle();

    expect(await value(metrics.eventRetries, onWork)).toBe(1);
    expect(await value(metrics.eventsHandled, onWork)).toBe(0);
  });

  it('counts a dead letter once attempts are spent, as exhausted', async () => {
    const metrics = new Metrics('test-service');
    const { broker, consumer, channel } = setup([WORK], metrics);
    await broker.connect();
    await consumer.subscribe(
      subscription(WORK.queue, () => {
        throw new Error('still broken');
      }),
    );

    channel().deliver(WORK.queue, activation(), { [HEADER_ATTEMPT]: broker.maxAttempts });
    await settle();

    expect(
      await value(metrics.eventsDeadLettered, { queue: WORK.queue, reason: 'exhausted' }),
    ).toBe(1);
    expect(await value(metrics.eventRetries, onWork)).toBe(0);
  });

  it('counts a message that cannot be parsed as an unparseable dead letter, never a retry', async () => {
    const metrics = new Metrics('test-service');
    const { broker, consumer, channel } = setup([WORK], metrics);
    await broker.connect();
    await consumer.subscribe(subscription(WORK.queue, vi.fn()));

    channel().deliver(WORK.queue, 'not json');
    await settle();

    expect(
      await value(metrics.eventsDeadLettered, { queue: WORK.queue, reason: 'unparseable' }),
    ).toBe(1);
  });
});
