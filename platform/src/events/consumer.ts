import { Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import type { BrokerConnection } from './connection.js';
import { UnparseableMessageError, parseEnvelope, type Envelope } from './envelope.js';
import {
  DLX,
  HEADER_ATTEMPT,
  HEADER_FAILURE,
  HEADER_ORIGINAL_QUEUE,
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
  eventType: string;
  payloadSchema: z.ZodType<T>;
  handler: EventHandler<T>;
  /** How many messages to hold unacknowledged at once. */
  prefetch?: number;
}

/**
 * Consumes events with bounded retry.
 *
 * Three outcomes for a message:
 *   - handled          acknowledged, done
 *   - transient failure republished to a retry queue that holds it for a
 *                      growing delay, then routes it back. Up to MAX_ATTEMPTS.
 *   - unparseable      dead-lettered immediately with the reason attached.
 *                      Retrying a malformed message only wastes the budget.
 */
export class EventConsumer {
  private readonly logger = new Logger(EventConsumer.name);

  constructor(private readonly broker: BrokerConnection) {}

  async subscribe<T>(options: SubscribeOptions<T>): Promise<void> {
    const channel = this.broker.getChannel();
    await channel.prefetch(options.prefetch ?? 10);

    await channel.consume(options.queue, (message) => {
      if (!message) return;
      void this.handle(options, message);
    });

    this.logger.log(`Consuming ${options.queue} for ${options.eventType}`);
  }

  private async handle<T>(options: SubscribeOptions<T>, message: ConsumeMessage): Promise<void> {
    const channel = this.broker.getChannel();
    const attempt = Number(message.properties.headers?.[HEADER_ATTEMPT] ?? 1);

    let envelope: Envelope<T>;
    try {
      envelope = parseEnvelope(message.content, options.payloadSchema);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ queue: options.queue, reason, msg: 'message is unparseable' });
      // Permanent: straight to the dead-letter queue, never retried — retrying
      // a malformed message only burns the budget. Published rather than
      // nacked so the reason travels with it; a bare nack would leave an
      // operator to guess from logs.
      await this.publishTo(DLX, options.queue, message, {
        ...message.properties.headers,
        [HEADER_FAILURE]: reason.slice(0, 500),
        [HEADER_ORIGINAL_QUEUE]: options.queue,
        [HEADER_ATTEMPT]: attempt,
      });
      channel.ack(message);
      return;
    }

    try {
      await options.handler(envelope, { attempt, queue: options.queue });
      channel.ack(message);
      this.logger.log({
        correlationId: envelope.correlationId,
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        attempt,
        msg: 'event handled',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.retryOrDeadLetter(options, message, envelope, attempt, reason);
    }
  }

  private async retryOrDeadLetter<T>(
    options: SubscribeOptions<T>,
    message: ConsumeMessage,
    envelope: Envelope<T>,
    attempt: number,
    reason: string,
  ): Promise<void> {
    const channel = this.broker.getChannel();

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
      // Published explicitly rather than nacked, so the dead-lettered message
      // carries the reason it failed. A bare nack would lose it, leaving an
      // operator to correlate against logs.
      await this.publishTo(DLX, options.queue, message, { ...headers, [HEADER_ATTEMPT]: attempt });
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

    // Fanout, so the routing key stays the event type and the message finds
    // its way back to this queue when the delay expires.
    await this.publishTo(
      retryExchangeName(this.broker.retryNamespace, attempt),
      message.fields.routingKey,
      message,
      {
        ...headers,
        [HEADER_ATTEMPT]: attempt + 1,
      },
    );

    channel.ack(message);
  }

  private publishTo(
    exchange: string,
    routingKey: string,
    message: ConsumeMessage,
    headers: Record<string, unknown>,
  ): Promise<void> {
    const channel = this.broker.getChannel();
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
