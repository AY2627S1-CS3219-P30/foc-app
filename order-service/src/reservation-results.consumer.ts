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
import { ORDER_DB } from './db/db.js';
import { OrdersRepository } from './orders/orders.repository.js';
import { SUSPENSION_REASONS } from './orders/order-state-machine.js';
import { UserDirectoryClient } from './orders/user-directory.client.js';

export const RESERVATION_RESULTS_QUEUE = 'foc.order.reservation-results';
// Order matters: a union returns the first schema that accepts the payload, and a rejection also
// satisfies the looser reserved shape, which would strip its reason and available balance. The
// rejection schema requires `reason`, so a reserved payload falls through to the second member.
const resultPayload = z.union([creditReservationRejectedPayload, creditsReservedPayload]);
type ResultPayload = CreditsReservedPayload | CreditReservationRejectedPayload;

/**
 * Opens or rejects an errand on Credit's reservation reply. The reply must restate the requester
 * and amount Order asked for, or it is dead-lettered. A reservation for a requester suspended
 * meanwhile cancels the errand and returns the credits (ORD-06): the User Service is asked, and if
 * it does not answer the handler throws and the reply is retried, never opened on a guess.
 */
@Injectable()
export class ReservationResultsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservationResultsConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(ORDER_DB) private readonly db: Db,
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(UserDirectoryClient) private readonly directory: UserDirectoryClient,
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

    const { orderId, requesterId, amount } = envelope.payload;
    const rejection =
      envelope.eventType === EVENTS.CREDITS_RESERVED
        ? undefined
        : (envelope.payload as CreditReservationRejectedPayload);
    // Only an insufficient-credits refusal reports the balance.
    const available = rejection && 'available' in rejection ? rejection.available : null;
    // Locked before the User Service is asked: see OrdersRepository.lockActiveErrandsOf.
    const order = await this.orders.lockById(tx, orderId);
    if (!order) throw new UnparseableMessageError('reservation result names an unknown order');
    if (order.requesterId !== requesterId || order.reward !== amount) {
      throw new UnparseableMessageError('reservation result does not match the recorded request');
    }
    // Asked only when the answer decides the outcome, so a repeated reply needs no User Service.
    const requesterSuspended =
      !rejection && order.status === 'PENDING_CREDIT'
        ? await this.directory.isSuspended(requesterId)
        : false;

    const result = await this.orders.transition(
      {
        orderId,
        action: rejection ? 'CREDIT_REJECTED' : 'CREDIT_RESERVED',
        actor: { kind: 'CREDIT_SERVICE', id: 'credit-service' },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        requesterSuspended,
        reason: requesterSuspended ? SUSPENSION_REASONS.REQUESTER : undefined,
        patch: rejection && {
          rejection_reason: rejection.reason,
          available_at_rejection: available,
        },
      },
      tx,
    );
    if (result.kind === 'rejected') {
      // Only a repeat of the reply already recorded is harmless.
      const current = result.order!; // found above, under the lock
      const repeated = rejection
        ? current.status === 'REJECTED' &&
          current.rejectionReason === rejection.reason &&
          current.availableAtRejection === available
        : current.status === 'OPEN';
      if (!repeated) {
        throw new UnparseableMessageError(
          `reservation result cannot move order from ${current.status}`,
        );
      }
    }
    const changed = result.kind === 'applied';
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId,
      outcome: rejection ? 'REJECTED' : 'RESERVED',
      changed,
      msg: 'reservation result handled',
    });
  }
}
