import { Logger } from '@nestjs/common';
import type { BrokerConnection } from './connection.js';
import { createEnvelope, type Envelope, type NewEventInput } from './envelope.js';
import { EXCHANGE } from './topology.js';

/**
 * Publishes a domain event.
 *
 * Awaits the broker's confirmation rather than resolving on write, so a caller
 * that needs to know the message is durable can.
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

  constructor(
    private readonly broker: BrokerConnection,
    private readonly producer: string,
  ) {}

  async publish<T>(input: Omit<NewEventInput<T>, 'producer'>): Promise<Envelope<T>> {
    const envelope = createEnvelope({ ...input, producer: this.producer });
    const channel = this.broker.getChannel();
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE,
        envelope.eventType,
        body,
        {
          contentType: 'application/json',
          persistent: true,
          messageId: envelope.eventId,
          correlationId: envelope.correlationId,
          timestamp: Date.now(),
          type: envelope.eventType,
        },
        (err) => (err ? reject(err) : resolve()),
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
