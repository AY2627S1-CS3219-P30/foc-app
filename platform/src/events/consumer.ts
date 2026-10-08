import { Logger } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import { errorMessage } from '../logging.js';
import type { Metrics } from '../metrics.js';
import type { BrokerConnection } from './connection.js';
import { UnparseableMessageError, parseEnvelope, type Envelope } from './envelope.js';
import {
  DLX,
  HEADER_ATTEMPT,
  HEADER_FAILURE,
  HEADER_ORIGINAL_QUEUE,
  isTransient,
  retryExchangeName,
} from './topology.js';

export interface HandlerContext {
  attempt: number;
  queue: string;
}

export type EventHandler<T> = (
  envelope: Envelope<T>,
  context: HandlerContext,
) => Promise<void> | void;

export interface SubscribeOptions<T> {
  queue: string;
  eventType: string | readonly string[];
  /**
   * Envelope producer(s) this handler trusts. This is an authorization check on
   * the broker identity claim; deployments must pair it with per-service broker
   * credentials/ACLs so another publisher cannot forge the claim.
   */
  expectedProducer?: string | readonly string[];
  payloadSchema: z.ZodType<T>;
  handler: EventHandler<T>;
  /** How many messages to hold unacknowledged at once. */
  prefetch?: number;
}

interface Subscription {
  options: SubscribeOptions<unknown>;
  /** The channel it consumes on. A consumer lives and dies with its channel. */
  channel?: ConfirmChannel;
}

/**
 * Consumes events with bounded retry.
 *
 * Three outcomes for a message:
 *   - handled          acknowledged, done
 *   - transient failure republished to a retry queue that holds it for a
 *                      growing delay, then routes it back to this queue
 *                      alone. Up to MAX_ATTEMPTS.
 *   - unparseable      dead-lettered immediately with the reason attached.
 *                      Retrying a malformed message only wastes the budget.
 *
 * On a transient queue (exclusive or auto-delete, see `isTransient`) both
 * failures simply drop the message: it has no retry or dead-letter topology.
 *
 * Subscriptions are remembered and re-registered on every new channel, so a
 * broker restart or a channel the server closed does not silently stop them.
 */
export class EventConsumer {
  private readonly logger = new Logger(EventConsumer.name);
  private readonly subscriptions: Subscription[] = [];

  /** `metrics` is optional so a test or a script can consume without a registry. */
  constructor(
    private readonly broker: BrokerConnection,
    private readonly metrics?: Metrics,
  ) {
    broker.onConnected((channel) => this.consumeAll(channel));
  }

  /**
   * Starts consuming now if the broker is connected, and in any case again
   * after every reconnect.
   */
  async subscribe<T>(options: SubscribeOptions<T>): Promise<void> {
    const sub: Subscription = { options: options as SubscribeOptions<unknown> };
    this.subscriptions.push(sub);
    this.startCounters(options);
    if (this.broker.isConnected()) {
      await this.consume(sub, this.broker.getChannel());
    } else {
      this.logger.warn(`Broker not connected; will consume ${options.queue} once it is`);
    }
  }

  /** The `queue` label on a queue's metrics: stable even where the queue's name is not. */
  private label(queue: string): string {
    return this.broker.subscription(queue)?.metricsLabel ?? queue;
  }

  /**
   * Reports this queue's counters at zero from the start. Prometheus cannot see an increase in a
   * series it first scraped after the increase, so without this a queue's first retry or dead
   * letter would never show on a rate or increase panel. A transient queue never retries or
   * dead-letters; it drops instead.
   */
  private startCounters<T>(options: SubscribeOptions<T>): void {
    if (!this.metrics) return;
    const spec = this.broker.subscription(options.queue);
    const transient = spec !== undefined && isTransient(spec);
    const queue = this.label(options.queue);
    const types = typeof options.eventType === 'string' ? [options.eventType] : options.eventType;
    for (const event_type of types) {
      this.metrics.eventsHandled.inc({ queue, event_type }, 0);
      if (!transient) this.metrics.eventRetries.inc({ queue, event_type }, 0);
    }
    for (const reason of transient ? ['unparseable', 'handler_failed'] : []) {
      this.metrics.eventsDropped.inc({ queue, reason }, 0);
    }
    for (const reason of transient ? [] : ['unparseable', 'exhausted']) {
      this.metrics.eventsDeadLettered.inc({ queue, reason }, 0);
    }
  }

  private async consumeAll(channel: ConfirmChannel): Promise<void> {
    // Indexed rather than a snapshot, so a subscribe() racing a reconnect is picked up too.
    for (let i = 0; i < this.subscriptions.length; i++) {
      await this.consume(this.subscriptions[i] as Subscription, channel);
    }
  }

  private async consume(sub: Subscription, channel: ConfirmChannel): Promise<void> {
    if (sub.channel === channel) return; // already consuming on this channel
    sub.channel = channel;
    const { options } = sub;
    try {
      await channel.prefetch(options.prefetch ?? 10);
      await channel.consume(options.queue, (message) => {
        if (!message) {
          // The broker cancelled us (the queue was deleted, or its node went). Recycle the
          // channel: the connection declares the topology again and re-subscribes everything.
          this.logger.warn(`Consumer for ${options.queue} cancelled by the broker; resubscribing`);
          void channel.close().catch(() => undefined);
          return;
        }
        this.handle(options, channel, message).catch((err: unknown) => {
          // The channel most likely closed mid-message; the broker redelivers it.
          this.logger.error({ err, queue: options.queue, msg: 'message not settled' });
        });
      });
    } catch (err) {
      sub.channel = undefined;
      throw err;
    }

    const eventTypes =
      typeof options.eventType === 'string' ? options.eventType : options.eventType.join(', ');
    this.logger.log(`Consuming ${options.queue} for ${eventTypes}`);
  }

  /** Settles on the channel the message arrived on: a delivery tag means nothing on another. */
  private async handle<T>(
    options: SubscribeOptions<T>,
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    const attempt = Number(message.properties.headers?.[HEADER_ATTEMPT] ?? 1);
    const spec = this.broker.subscription(options.queue);
    const transient = spec !== undefined && isTransient(spec);
    const queueLabel = this.label(options.queue);

    let envelope: Envelope<T>;
    try {
      envelope = parseEnvelope(message.content, options.payloadSchema);
      const eventTypes =
        typeof options.eventType === 'string' ? [options.eventType] : options.eventType;
      if (!eventTypes.includes(envelope.eventType)) {
        throw new UnparseableMessageError(
          `event type ${envelope.eventType} does not match subscription ${eventTypes.join(', ')}`,
        );
      }
      const expected =
        typeof options.expectedProducer === 'string'
          ? [options.expectedProducer]
          : options.expectedProducer;
      if (expected && !expected.includes(envelope.producer)) {
        throw new UnparseableMessageError(
          `producer ${envelope.producer} is not trusted for ${options.eventType}`,
        );
      }
    } catch (err) {
      const reason = errorMessage(err);
      this.logger.error({ queue: options.queue, reason, msg: 'message is unparseable' });
      if (transient) {
        this.metrics?.eventsDropped.inc({ queue: queueLabel, reason: 'unparseable' });
        channel.nack(message, false, false); // nowhere to set it aside
        return;
      }
      this.metrics?.eventsDeadLettered.inc({ queue: queueLabel, reason: 'unparseable' });
      // Permanent: straight to the dead-letter queue, never retried — retrying
      // a malformed message only burns the budget. Published rather than
      // nacked so the reason travels with it; a bare nack would leave an
      // operator to guess from logs.
      await this.publishTo(channel, DLX, options.queue, message, {
        ...message.properties.headers,
        [HEADER_FAILURE]: reason.slice(0, 500),
        [HEADER_ORIGINAL_QUEUE]: options.queue,
        [HEADER_ATTEMPT]: attempt,
      });
      channel.ack(message);
      return;
    }

    const labels = { queue: queueLabel, event_type: envelope.eventType };
    const startedAt = process.hrtime.bigint();
    try {
      await options.handler(envelope, { attempt, queue: options.queue });
      channel.ack(message);
      if (this.metrics) {
        this.metrics.eventsHandled.inc(labels);
        this.metrics.eventHandleDuration.observe(
          labels,
          Number(process.hrtime.bigint() - startedAt) / 1e9,
        );
        // From when it happened, so time spent waiting in the queue and in retries counts.
        const lagMs = Date.now() - Date.parse(envelope.occurredAt);
        if (Number.isFinite(lagMs)) this.metrics.eventLag.observe(labels, Math.max(0, lagMs) / 1e3);
      }
      this.logger.log({
        correlationId: envelope.correlationId,
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        attempt,
        msg: 'event handled',
      });
    } catch (err) {
      const reason = errorMessage(err);
      if (err instanceof UnparseableMessageError) {
        this.logger.error({ queue: options.queue, reason, msg: 'message is unparseable' });
        if (transient) {
          this.metrics?.eventsDropped.inc({ queue: queueLabel, reason: 'unparseable' });
          channel.nack(message, false, false);
          return;
        }
        this.metrics?.eventsDeadLettered.inc({ queue: queueLabel, reason: 'unparseable' });
        await this.publishTo(channel, DLX, options.queue, message, {
          ...message.properties.headers,
          [HEADER_FAILURE]: reason.slice(0, 500),
          [HEADER_ORIGINAL_QUEUE]: options.queue,
          [HEADER_ATTEMPT]: attempt,
        });
        channel.ack(message);
        return;
      }
      if (transient) {
        this.logger.warn({
          correlationId: envelope.correlationId,
          eventId: envelope.eventId,
          reason,
          msg: 'handler failed on a transient queue; dropping',
        });
        this.metrics?.eventsDropped.inc({ queue: queueLabel, reason: 'handler_failed' });
        channel.nack(message, false, false);
        return;
      }
      await this.retryOrDeadLetter(options, channel, message, envelope, attempt, reason);
    }
  }

  private async retryOrDeadLetter<T>(
    options: SubscribeOptions<T>,
    channel: ConfirmChannel,
    message: ConsumeMessage,
    envelope: Envelope<T>,
    attempt: number,
    reason: string,
  ): Promise<void> {
    const headers = {
      ...message.properties.headers,
      [HEADER_FAILURE]: reason.slice(0, 500),
      [HEADER_ORIGINAL_QUEUE]: options.queue,
    };

    if (attempt >= this.broker.maxAttempts) {
      this.logger.error({
        correlationId: envelope.correlationId,
        eventId: envelope.eventId,
        attempt,
        reason,
        msg: 'attempts exhausted; setting aside for an operator',
      });
      this.metrics?.eventsDeadLettered.inc({
        queue: this.label(options.queue),
        reason: 'exhausted',
      });
      // Published explicitly rather than nacked, so the dead-lettered message
      // carries the reason it failed. A bare nack would lose it, leaving an
      // operator to correlate against logs.
      await this.publishTo(channel, DLX, options.queue, message, {
        ...headers,
        [HEADER_ATTEMPT]: attempt,
      });
      channel.ack(message);
      return;
    }

    this.logger.warn({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      attempt,
      reason,
      retryLevel: attempt,
      msg: 'handler failed; scheduling retry',
    });
    this.metrics?.eventRetries.inc({
      queue: this.label(options.queue),
      event_type: envelope.eventType,
    });

    // Keyed by this queue's name, not the event type: the retry queue
    // dead-letters onto the default exchange, which delivers by queue name, so
    // the message comes back here and not to every queue bound to its type.
    await this.publishTo(
      channel,
      retryExchangeName(this.broker.retryNamespace, attempt),
      options.queue,
      message,
      {
        ...headers,
        [HEADER_ATTEMPT]: attempt + 1,
      },
    );

    channel.ack(message);
  }

  private publishTo(
    channel: ConfirmChannel,
    exchange: string,
    routingKey: string,
    message: ConsumeMessage,
    headers: Record<string, unknown>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      channel.publish(
        exchange,
        routingKey,
        message.content,
        { ...message.properties, persistent: true, headers },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
}

export { UnparseableMessageError };
