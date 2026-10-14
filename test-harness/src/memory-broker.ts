import { EventEmitter } from 'node:events';
import type { ChannelModel, ConsumeMessage, Options, XDeath } from 'amqplib';

/**
 * RabbitMQ's routing in memory: enough of AMQP 0-9-1 for `BrokerConnection` to declare its topology,
 * and for a message to retry, dead-letter and be redriven through it, in a suite with no broker.
 *
 * It is not a broker. Nothing persists, prefetch is ignored, a queue has at most one consumer, and
 * a message TTL is a timer. It routes as RabbitMQ does: the default exchange by queue name, topic
 * and fanout exchanges by binding, and a rejected or expired message to its queue's dead-letter
 * exchange with an `x-death` header. Suites that need the real thing use `createEphemeralBroker`.
 *
 *   const memory = createMemoryBroker();
 *   const broker = new BrokerConnection('amqp://memory', 'credit-service', subs, [10], {
 *     connect: memory.connect,
 *   });
 */
export interface MemoryBroker {
  /** Pass as `BrokerConnection`'s `connect` option. */
  readonly connect: (url?: string) => Promise<ChannelModel>;
  /** Messages in a queue not yet acknowledged: waiting, or delivered and unsettled. */
  depth(queue: string): number;
  /** Publishes as another service would. An object body is sent as JSON. */
  publish(exchange: string, routingKey: string, body: unknown, options?: Options.Publish): void;
}

interface Message {
  content: Buffer;
  properties: ConsumeMessage['properties'];
  exchange: string;
  routingKey: string;
  redelivered: boolean;
}

interface Queue {
  name: string;
  options: Options.AssertQueue;
  ready: Message[];
  unacked: Map<number, Message>;
  /** The channel it consumes on, compared by identity, and its callback. */
  consumer?: { channel: EventEmitter; onMessage: (message: ConsumeMessage | null) => void };
}

interface Exchange {
  type: string;
  bindings: Array<{ queue: string; pattern: string }>;
}

/** AMQP topic matching: `*` is exactly one word, `#` is zero or more. */
function topicMatches(pattern: string, key: string): boolean {
  const match = (p: string[], k: string[]): boolean => {
    if (p.length === 0) return k.length === 0;
    if (p[0] === '#') return match(p.slice(1), k) || (k.length > 0 && match(p, k.slice(1)));
    if (k.length === 0) return false;
    return (p[0] === '*' || p[0] === k[0]) && match(p.slice(1), k.slice(1));
  };
  return match(pattern.split('.'), key.split('.'));
}

/** What a consumer reads back from the publish options amqplib was given. */
function toProperties(options: Options.Publish = {}): ConsumeMessage['properties'] {
  const { persistent, headers, ...rest } = options as Options.Publish & Record<string, unknown>;
  return {
    ...rest,
    headers: { ...(headers ?? {}) },
    deliveryMode: persistent ? 2 : (rest.deliveryMode as number | undefined),
  } as ConsumeMessage['properties'];
}

export function createMemoryBroker(): MemoryBroker {
  const queues = new Map<string, Queue>();
  const exchanges = new Map<string, Exchange>();
  let deliveryTag = 0;

  function route(exchange: string, routingKey: string): string[] {
    if (exchange === '') return queues.has(routingKey) ? [routingKey] : [];
    const target = exchanges.get(exchange);
    if (!target) throw new Error(`NOT_FOUND - no exchange '${exchange}'`);
    return target.bindings
      .filter(({ pattern }) =>
        target.type === 'fanout'
          ? true
          : target.type === 'topic'
            ? topicMatches(pattern, routingKey)
            : pattern === routingKey,
      )
      .map(({ queue }) => queue);
  }

  function send(
    exchange: string,
    routingKey: string,
    content: Buffer,
    properties: Message['properties'],
  ) {
    // A queue bound twice receives one copy, as in RabbitMQ.
    for (const name of new Set(route(exchange, routingKey))) {
      enqueue(queues.get(name)!, {
        content,
        properties: { ...properties, headers: { ...(properties.headers ?? {}) } },
        exchange,
        routingKey,
        redelivered: false,
      });
    }
  }

  function enqueue(queue: Queue, message: Message) {
    queue.ready.push(message);
    const ttl = queue.options.messageTtl;
    if (ttl !== undefined) {
      setTimeout(() => {
        const at = queue.ready.indexOf(message);
        if (at === -1) return; // delivered before it expired
        queue.ready.splice(at, 1);
        deadLetter(queue, message, 'expired');
      }, ttl).unref?.();
    }
    dispatch(queue);
  }

  function dispatch(queue: Queue) {
    while (queue.consumer && queue.ready.length > 0) {
      const message = queue.ready.shift()!;
      const tag = ++deliveryTag;
      queue.unacked.set(tag, message);
      const { onMessage } = queue.consumer;
      setImmediate(() =>
        onMessage({
          content: message.content,
          fields: {
            deliveryTag: tag,
            redelivered: message.redelivered,
            exchange: message.exchange,
            routingKey: message.routingKey,
            consumerTag: `ctag-${queue.name}`,
          },
          properties: message.properties,
        } as ConsumeMessage),
      );
    }
  }

  /** A rejected or expired message goes to the queue's dead-letter exchange, if it has one. */
  function deadLetter(queue: Queue, message: Message, reason: 'rejected' | 'expired') {
    const dlx = queue.options.deadLetterExchange;
    if (dlx === undefined) return; // dropped, as RabbitMQ drops it
    const headers = { ...(message.properties.headers ?? {}) };
    const deaths = Array.isArray(headers['x-death']) ? (headers['x-death'] as XDeath[]) : [];
    headers['x-death'] = [
      {
        count: 1,
        reason,
        queue: queue.name,
        time: { '!': 'timestamp', value: Math.floor(Date.now() / 1000) },
        exchange: message.exchange,
        'routing-keys': [message.routingKey],
      },
      ...deaths,
    ];
    send(dlx, queue.options.deadLetterRoutingKey ?? message.routingKey, message.content, {
      ...message.properties,
      headers,
    });
  }

  function settle(channel: EventEmitter, tag: number, requeue?: boolean) {
    for (const queue of queues.values()) {
      const message = queue.unacked.get(tag);
      if (!message || queue.consumer?.channel !== channel) continue;
      queue.unacked.delete(tag);
      if (requeue === undefined) return; // acknowledged
      if (requeue) {
        queue.ready.unshift({ ...message, redelivered: true });
        dispatch(queue);
      } else {
        deadLetter(queue, message, 'rejected');
      }
      return;
    }
    throw new Error(`PRECONDITION_FAILED - unknown delivery tag ${tag}`);
  }

  class MemoryChannel extends EventEmitter {
    open = true;

    async assertExchange(name: string, type: string) {
      this.check();
      if (!exchanges.has(name)) exchanges.set(name, { type, bindings: [] });
      return { exchange: name };
    }
    async assertQueue(name: string, options: Options.AssertQueue = {}) {
      this.check();
      const queue: Queue = queues.get(name) ?? { name, options, ready: [], unacked: new Map() };
      queues.set(name, queue);
      return {
        queue: name,
        messageCount: queue.ready.length,
        consumerCount: queue.consumer ? 1 : 0,
      };
    }
    async checkQueue(name: string) {
      this.check();
      const queue = queues.get(name);
      if (!queue) throw new Error(`NOT_FOUND - no queue '${name}'`);
      return {
        queue: name,
        messageCount: queue.ready.length,
        consumerCount: queue.consumer ? 1 : 0,
      };
    }
    async bindQueue(queue: string, exchange: string, pattern: string) {
      this.check();
      const target = exchanges.get(exchange);
      if (!target || !queues.has(queue))
        throw new Error(`NOT_FOUND - bind ${queue} to ${exchange}`);
      if (!target.bindings.some((b) => b.queue === queue && b.pattern === pattern)) {
        target.bindings.push({ queue, pattern });
      }
      return {};
    }
    async prefetch() {
      this.check();
    }
    async consume(name: string, onMessage: (message: ConsumeMessage | null) => void) {
      this.check();
      const queue = queues.get(name);
      if (!queue) throw new Error(`NOT_FOUND - no queue '${name}'`);
      queue.consumer = { channel: this, onMessage };
      dispatch(queue);
      return { consumerTag: `ctag-${name}` };
    }
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: Options.Publish,
      done?: (err: unknown) => void,
    ): boolean {
      this.check();
      try {
        send(exchange, routingKey, content, toProperties(options));
        setImmediate(() => done?.(null));
      } catch (err) {
        setImmediate(() => done?.(err));
      }
      return true;
    }
    ack(message: ConsumeMessage) {
      this.check();
      settle(this, message.fields.deliveryTag);
    }
    nack(message: ConsumeMessage, _allUpTo = false, requeue = true) {
      this.check();
      settle(this, message.fields.deliveryTag, requeue);
    }
    async close() {
      if (!this.open) return;
      this.open = false;
      // What it held unsettled goes back to its queues, as when a real channel closes.
      for (const queue of queues.values()) {
        if (queue.consumer?.channel !== this) continue;
        queue.consumer = undefined;
        queue.ready.unshift(
          ...[...queue.unacked.values()].map((m) => ({ ...m, redelivered: true })),
        );
        queue.unacked.clear();
      }
      this.emit('close');
    }
    private check() {
      if (!this.open) throw new Error('Channel closed');
    }
  }

  class MemoryConnection extends EventEmitter {
    private readonly channels: MemoryChannel[] = [];
    async createConfirmChannel() {
      const channel = new MemoryChannel();
      this.channels.push(channel);
      return channel;
    }
    async close() {
      for (const channel of this.channels) await channel.close();
      this.emit('close');
    }
  }

  return {
    connect: async () => new MemoryConnection() as unknown as ChannelModel,
    depth: (name) => {
      const queue = queues.get(name);
      return queue ? queue.ready.length + queue.unacked.size : 0;
    },
    publish: (exchange, routingKey, body, options) =>
      send(
        exchange,
        routingKey,
        Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
        toProperties(options),
      ),
  };
}
