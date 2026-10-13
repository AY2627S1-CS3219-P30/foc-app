import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfirmChannel } from 'amqplib';
import { PAYLOAD_SCHEMAS, REQUIRES_CONSUMER } from './catalogue.js';
import type { BrokerConnection } from './connection.js';
import {
  EventValidationError,
  UnroutableEventError,
  createEnvelope,
  type Envelope,
  type NewEventInput,
} from './envelope.js';
import { EXCHANGE } from './topology.js';

export interface EventPublisherOptions {
  /**
   * The payload schema for each event type this publisher may send. Defaults to the catalogue; a
   * suite that publishes event types of its own passes them here.
   */
  schemas?: Readonly<Record<string, z.ZodType>>;
  /**
   * The event types that must reach a consumer. Defaults to the catalogue's `REQUIRES_CONSUMER`;
   * a suite with event types of its own passes them here.
   */
  requiresConsumer?: ReadonlySet<string>;
}

/**
 * Publishes a domain event.
 *
 * Awaits the broker's confirmation rather than resolving on write, so a caller
 * that needs to know the message is durable can.
 *
 * Validates before it sends (EVT-03): an event type the catalogue does not
 * describe, or a payload that fails its schema, throws `EventValidationError`
 * and nothing reaches the broker.
 *
 * An event that needs a consumer is sent as mandatory. If no queue is bound
 * for it, the broker hands it back and the publish fails with
 * `UnroutableEventError`, rather than being confirmed and then discarded.
 *
 * A service does not call this directly for an event that records a state
 * change: publishing here is not atomic with a database write, and a crash
 * between the commit and the publish would lose the event. Such an event goes
 * through the outbox instead (`insertOutboxEvent` in the same transaction as
 * the change, see outbox.ts), and the `OutboxRelay` calls this to deliver
 * it, passing the row's id so a redelivery is the same event to a consumer.
 */
export class EventPublisher {
  private readonly logger = new Logger(EventPublisher.name);

  private readonly schemas: Readonly<Record<string, z.ZodType>>;
  private readonly requiresConsumer: ReadonlySet<string>;
  /** Channels already listening for handed-back messages; a reconnect makes a new one. */
  private readonly watched = new WeakSet<ConfirmChannel>();
  /** Ids the broker handed back as unroutable, kept until their confirmation arrives. */
  private readonly handedBack = new Set<string>();

  constructor(
    private readonly broker: BrokerConnection,
    private readonly producer: string,
    options: EventPublisherOptions = {},
  ) {
    this.schemas = options.schemas ?? PAYLOAD_SCHEMAS;
    this.requiresConsumer = options.requiresConsumer ?? REQUIRES_CONSUMER;
  }

  async publish<T>(input: Omit<NewEventInput<T>, 'producer'>): Promise<Envelope<T>> {
    const schema = Object.hasOwn(this.schemas, input.eventType)
      ? this.schemas[input.eventType]
      : undefined;
    if (!schema) {
      throw new EventValidationError(`unknown event type ${input.eventType}: not in the catalogue`);
    }
    const checked = schema.safeParse(input.payload);
    if (!checked.success) {
      throw new EventValidationError(
        `payload invalid: ${checked.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    const envelope = createEnvelope({
      ...input,
      payload: checked.data as T,
      producer: this.producer,
    });
    const channel = this.broker.getChannel();
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');
    const mandatory = this.requiresConsumer.has(envelope.eventType);
    if (mandatory && !this.watched.has(channel)) {
      this.watched.add(channel);
      // The broker returns an unroutable mandatory message before it confirms it.
      channel.on('return', (message: { properties: { messageId?: unknown } }) => {
        const id = message.properties.messageId;
        if (typeof id === 'string') this.handedBack.add(id);
      });
    }

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE,
        envelope.eventType,
        body,
        {
          contentType: 'application/json',
          persistent: true,
          mandatory,
          // The broker checks this against the login, so a consumer can rely on it (sender.ts).
          userId: this.broker.account,
          messageId: envelope.eventId,
          correlationId: envelope.correlationId,
          timestamp: Date.now(),
          type: envelope.eventType,
        },
        (err) => {
          // Cleared however this attempt ends: a hand-back followed by a closed channel must not
          // be held against the next attempt at the same event.
          const handedBack = this.handedBack.delete(envelope.eventId);
          if (err) return reject(err);
          if (handedBack) return reject(new UnroutableEventError(envelope.eventType));
          resolve();
        },
      );
    });

    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      aggregateId: envelope.aggregateId,
      msg: 'event published',
    });
    return envelope;
  }
}
