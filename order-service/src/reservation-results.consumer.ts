import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  UnparseableMessageError,
  creditReservationRejectedPayload,
  creditsReservedPayload,
  withInbox,
  type CreditReservationRejectedPayload,
  type CreditsReservedPayload,
  type Db,
  type Envelope,
  type EventConsumer,
  type Queryable,
} from '@foc/platform';
import { z } from 'zod';
import { env } from './config.js';
import { ORDER_DB } from './db/db.js';
import { OrdersRepository } from './orders/orders.repository.js';

export const RESERVATION_RESULTS_QUEUE = 'foc.order.reservation-results';
const resultPayload = z.union([creditsReservedPayload, creditReservationRejectedPayload]);
type ResultPayload = CreditsReservedPayload | CreditReservationRejectedPayload;

@Injectable()
export class ReservationResultsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservationResultsConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(ORDER_DB) private readonly db: Db,
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: RESERVATION_RESULTS_QUEUE,
      eventType: [EVENTS.CREDITS_RESERVED, EVENTS.CREDIT_RESERVATION_REJECTED],
      expectedProducer: 'credit-service',
      payloadSchema: resultPayload,
      handler: withInbox(this.db, RESERVATION_RESULTS_QUEUE, (envelope, tx) =>
        this.handle(envelope, tx),
      ),
    });
  }

  private async handle(envelope: Envelope<ResultPayload>, tx: Queryable): Promise<void> {
    if (envelope.aggregateId !== envelope.payload.orderId) {
      throw new UnparseableMessageError('aggregateId does not match reservation orderId');
    }

    const outcome =
      envelope.eventType === EVENTS.CREDITS_RESERVED
        ? ({ kind: 'RESERVED' } as const)
        : ({
            kind: 'REJECTED',
            reason: (envelope.payload as CreditReservationRejectedPayload).reason,
            ...('available' in envelope.payload ? { available: envelope.payload.available } : {}),
          } as const);
    const changed = await this.orders.applyReservationResult(tx, {
      orderId: envelope.payload.orderId,
      requesterId: envelope.payload.requesterId,
      amount: envelope.payload.amount,
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
      acceptanceWindowMs: env.ACCEPTANCE_WINDOW_MS,
      outcome,
    });
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId: envelope.payload.orderId,
      outcome: outcome.kind,
      changed,
      msg: 'reservation result handled',
    });
  }
}
