import { Logger } from '@nestjs/common';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  DLX,
  EXCHANGE,
  RETRY_DELAYS_MS,
  deadLetterQueueName,
  isTransient,
  retryLevels,
  type SubscriptionSpec,
} from './topology.js';

/** Work to redo on every fresh channel, after the topology is declared. */
export type ConnectedListener = (channel: ConfirmChannel) => Promise<void> | void;

export interface BrokerConnectionOptions {
  /** Test seam: opens a connection. Defaults to amqplib's `connect`. */
  connect?: (url: string) => Promise<ChannelModel>;
}

/**
 * Owns the connection and the topology. One per service.
 *
 * Reconnects on its own: a broker restart during a demo should be a pause, not
 * an outage. Losing the channel alone (the server closes it after, say, a
 * PRECONDITION_FAILED) is handled the same way. Every reconnect declares the
 * topology again and then runs the {@link onConnected} listeners, which is how
 * consumers come back: a new channel starts with none. Publishing while
 * disconnected throws rather than silently dropping, so a caller can decide
 * what to do.
 */
export class BrokerConnection {
  private readonly logger = new Logger(BrokerConnection.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private closing = false;
  private reconnectDelayMs = 1_000;
  private readonly listeners: ConnectedListener[] = [];
  private readonly open: (url: string) => Promise<ChannelModel>;

  constructor(
    private readonly url: string,
    /** Scopes this service's retry queues; conventionally the service name. */
    private readonly namespace: string,
    private readonly subscriptions: SubscriptionSpec[] = [],
    private readonly retryDelaysMs?: readonly number[],
    options: BrokerConnectionOptions = {},
  ) {
    this.open = options.connect ?? ((u) => amqp.connect(u));
  }

  get retryNamespace(): string {
    return this.namespace;
  }

  /** Attempts allowed before a message is set aside, derived from the delays. */
  get maxAttempts(): number {
    return (this.retryDelaysMs ?? RETRY_DELAYS_MS).length + 1;
  }

  /** The declared subscription for a queue, if this service declared one. */
  subscription(queue: string): SubscriptionSpec | undefined {
    return this.subscriptions.find((s) => s.queue === queue);
  }

  /** The queues this service consumes durably. Each has a dead-letter queue, `<queue>.dlq`. */
  durableQueues(): string[] {
    return this.subscriptions.filter((s) => !isTransient(s)).map((s) => s.queue);
  }

  /** Runs `listener` after every successful connect, including reconnects. */
  onConnected(listener: ConnectedListener): void {
    this.listeners.push(listener);
  }

  async connect(): Promise<void> {
    const connection = await this.open(this.url);
    let channel: ConfirmChannel;
    try {
      // A confirm channel so a publish can be awaited to the broker, rather than
      // resolving as soon as it is written to a socket buffer.
      channel = await connection.createConfirmChannel();
      await this.declareTopology(channel);
    } catch (err) {
      await connection.close().catch(() => undefined);
      throw err;
    }
    if (this.closing) {
      await connection.close().catch(() => undefined);
      return;
    }

    connection.on('error', (err: Error) => {
      this.logger.error({ err }, 'Broker connection error');
    });
    connection.on('close', () => this.lost(connection, 'connection closed'));
    // Without an 'error' listener, a channel the server closes would throw.
    channel.on('error', (err: Error) => {
      this.logger.error({ err }, 'Broker channel error');
    });
    channel.on('close', () => this.lost(channel, 'channel closed'));

    this.connection = connection;
    this.channel = channel;
    this.logger.log('Connected to the broker');

    for (const listener of this.listeners) {
      try {
        await listener(channel);
      } catch (err) {
        // Most likely the channel died under it. Start again rather than run half-subscribed,
        // keeping the backoff so a setup that keeps failing does not spin.
        this.logger.error({ err }, 'Setup after connecting failed; reconnecting');
        this.lost(channel, 'setup failed');
        return;
      }
    }
    this.reconnectDelayMs = 1_000;
  }

  /**
   * The current connection or its channel went away. Drops both and starts
   * again from nothing, so topology and consumers are rebuilt in one place.
   * Only the current pair counts: a connection closing drops its channel too,
   * and whichever of the two reports first handles it.
   */
  private lost(source: ChannelModel | ConfirmChannel, what: string): void {
    if (this.closing) return;
    if (source !== this.connection && source !== this.channel) return;
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    this.logger.warn(`Broker ${what}; reconnecting`);
    void connection?.close().catch(() => undefined);
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    while (!this.closing) {
      await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      if (this.closing) return;
      try {
        await this.connect();
        return;
      } catch (err) {
        this.logger.error({ err }, 'Reconnect failed; will retry');
      }
    }
  }

  /**
   * Declares every exchange and queue. Idempotent, so running it against a
   * broker that already has the topology is a no-op — that is what makes the
   * stack reproducible from empty.
   */
  private async declareTopology(ch: ConfirmChannel): Promise<void> {
    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    await ch.assertExchange(DLX, 'topic', { durable: true });

    // One fanout exchange per delay level, dead-lettering onto the default
    // exchange. The consumer publishes a failed message here with the queue it
    // failed on as its routing key; fanout keeps that key, and when the TTL
    // expires the default exchange delivers it to that queue and no other.
    for (const { exchange, queue, ttlMs } of retryLevels(this.namespace, this.retryDelaysMs)) {
      await ch.assertExchange(exchange, 'fanout', { durable: true });
      await ch.assertQueue(queue, {
        durable: true,
        messageTtl: ttlMs,
        deadLetterExchange: '',
      });
      await ch.bindQueue(queue, exchange, '');
    }

    for (const sub of this.subscriptions) {
      if (isTransient(sub)) {
        // No dead-letter queue, no retry: see isTransient.
        await ch.assertQueue(sub.queue, {
          durable: false,
          exclusive: sub.exclusive,
          autoDelete: sub.autoDelete,
          messageTtl: sub.messageTtlMs,
          maxLength: sub.maxLength,
        });
      } else {
        const dlq = deadLetterQueueName(sub.queue);
        await ch.assertQueue(dlq, { durable: true });
        await ch.bindQueue(dlq, DLX, sub.queue);

        await ch.assertQueue(sub.queue, {
          durable: true,
          deadLetterExchange: DLX,
          deadLetterRoutingKey: sub.queue,
          messageTtl: sub.messageTtlMs,
          maxLength: sub.maxLength,
        });
      }
      for (const key of sub.routingKeys) {
        await ch.bindQueue(sub.queue, EXCHANGE, key);
      }
    }
  }

  getChannel(): ConfirmChannel {
    if (!this.channel) throw new Error('Broker is not connected');
    return this.channel;
  }

  isConnected(): boolean {
    return Boolean(this.channel);
  }

  async close(): Promise<void> {
    this.closing = true;
    const { channel, connection } = this;
    this.channel = undefined;
    this.connection = undefined;
    // Each on its own: a channel already closing (a recycled consumer, a server close) must not
    // stop the connection from being closed too. Already gone is fine during shutdown.
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }
}
