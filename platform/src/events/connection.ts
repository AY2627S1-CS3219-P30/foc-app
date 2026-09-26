import { Logger } from '@nestjs/common';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  DLX,
  EXCHANGE,
  RETRY_DELAYS_MS,
  deadLetterQueueName,
  retryLevels,
  type SubscriptionSpec,
} from './topology.js';

/**
 * Owns the connection and the topology. One per service.
 *
 * Reconnects on its own: a broker restart during a demo should be a pause, not
 * an outage. Publishing while disconnected throws rather than silently
 * dropping, so a caller can decide what to do.
 */
export class BrokerConnection {
  private readonly logger = new Logger(BrokerConnection.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private closing = false;
  private reconnectDelayMs = 1_000;

  constructor(
    private readonly url: string,
    /** Scopes this service's retry queues; conventionally the service name. */
    private readonly namespace: string,
    private readonly subscriptions: SubscriptionSpec[] = [],
    private readonly retryDelaysMs?: readonly number[],
  ) {}

  get retryNamespace(): string {
    return this.namespace;
  }

  /** Attempts allowed before a message is set aside, derived from the delays. */
  get maxAttempts(): number {
    return (this.retryDelaysMs ?? RETRY_DELAYS_MS).length + 1;
  }

  async connect(): Promise<void> {
    this.connection = await amqp.connect(this.url);
    // A confirm channel so a publish can be awaited to the broker, rather than
    // resolving as soon as it is written to a socket buffer.
    this.channel = await this.connection.createConfirmChannel();
    await this.declareTopology(this.channel);

    this.connection.on('error', (err: Error) => {
      this.logger.error({ err }, 'Broker connection error');
    });
    this.connection.on('close', () => {
      if (this.closing) return;
      this.logger.warn('Broker connection closed; reconnecting');
      void this.reconnect();
    });

    this.reconnectDelayMs = 1_000;
    this.logger.log('Connected to the broker');
  }

  private async reconnect(): Promise<void> {
    if (this.closing) return;
    await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    try {
      await this.connect();
    } catch (err) {
      this.logger.error({ err }, 'Reconnect failed; will retry');
      void this.reconnect();
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

    // One fanout exchange per delay level. Fanout because the routing key must
    // stay the original event type: when the TTL expires the message is
    // dead-lettered onto the main exchange with whatever key it still carries,
    // and that key is what routes it back to the queue it came from.
    for (const { exchange, queue, ttlMs } of retryLevels(this.namespace, this.retryDelaysMs)) {
      await ch.assertExchange(exchange, 'fanout', { durable: true });
      await ch.assertQueue(queue, {
        durable: true,
        messageTtl: ttlMs,
        deadLetterExchange: EXCHANGE,
      });
      await ch.bindQueue(queue, exchange, '');
    }

    for (const sub of this.subscriptions) {
      const dlq = deadLetterQueueName(sub.queue);
      await ch.assertQueue(dlq, { durable: true });
      await ch.bindQueue(dlq, DLX, sub.queue);

      await ch.assertQueue(sub.queue, {
        durable: true,
        deadLetterExchange: DLX,
        deadLetterRoutingKey: sub.queue,
      });
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
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // Already gone; nothing useful to do during shutdown.
    }
    this.channel = undefined;
    this.connection = undefined;
  }
}
