import { Logger } from '@nestjs/common';
import type { BrokerConnection } from './connection.js';
import { createEnvelope, type Envelope, type NewEventInput } from './envelope.js';
import { EXCHANGE } from './topology.js';

/**
 * Publishes a domain event.
 *
 * Awaits the broker's confirmation rather than resolving on write, so a caller
 * that needs to know the message is durable can. It does not, however, make
 * publishing atomic with a database write — that is the outbox in EVT-02.
 * Until then a crash between commit and publish loses the event, which is
 * precisely the gap EVT-02 exists to close.
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
