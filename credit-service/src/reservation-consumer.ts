import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  UnparseableMessageError,
  creditReservationRequestedPayload,
  withReplayableInbox,
  type CreditReservationRequestedPayload,
  type Db,
  type Envelope,
  type EventConsumer,
  type Queryable,
} from '@foc/platform';
import { CreditRepository } from './credits/credit.repository.js';
import { RAW_DB } from './db/db.js';

export const RESERVATION_QUEUE = 'foc.credit.reservations';

@Injectable()
export class ReservationConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservationConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(RAW_DB) private readonly db: Db,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: RESERVATION_QUEUE,
      eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
      expectedProducer: 'order-service',
      payloadSchema: creditReservationRequestedPayload,
      handler: withReplayableInbox(this.db, RESERVATION_QUEUE, (envelope, tx) =>
        this.handle(envelope, tx),
      ),
    });
  }

  private async handle(
    envelope: Envelope<CreditReservationRequestedPayload>,
    tx: Queryable,
  ): Promise<void> {
    if (envelope.aggregateId !== envelope.payload.orderId) {
      throw new UnparseableMessageError('aggregateId does not match reservation orderId');
    }
    const outcome = await this.credits.reserve(tx, {
      ...envelope.payload,
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
    });
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId: envelope.payload.orderId,
      outcome,
      msg: 'reservation request recorded',
    });
  }
}
