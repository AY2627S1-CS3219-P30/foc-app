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
import { OrdersRepository, type TransitionCommand } from './orders/orders.repository.js';
import { SUSPENSION_EFFECTS } from './orders/order-state-machine.js';
import type { OrderRow } from './orders/types.js';
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
    // Locked before the User Service is asked: see OrdersRepository.lockActiveErrandsOf.
    const order = await this.orders.lockById(tx, orderId);
    if (!order) throw new UnparseableMessageError('reservation result names an unknown order');
    if (order.requesterId !== requesterId || order.reward !== amount) {
      throw new UnparseableMessageError('reservation result does not match the recorded request');
    }
    const outcome =
      envelope.eventType === EVENTS.CREDITS_RESERVED
        ? await this.reserved(order)
        : rejected(envelope.payload as CreditReservationRejectedPayload);

    const result = await this.orders.transition(
      {
        ...outcome.command,
        orderId,
        actor: { kind: 'CREDIT_SERVICE', id: 'credit-service' },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
      },
      tx,
    );
    // Refused: harmless only as a repeat of the reply already recorded.
    if (result.kind === 'rejected' && !outcome.repeats(order)) {
      throw new UnparseableMessageError(
        `reservation result cannot move order from ${order.status}`,
      );
    }
    const changed = result.kind === 'applied';
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId,
      outcome: outcome.kind,
      changed,
      msg: 'reservation result handled',
    });
  }

  /** The requester is asked about only while the answer decides the outcome, not for a repeat. */
  private async reserved(order: OrderRow): Promise<Outcome> {
    const requesterSuspended =
      order.status === 'PENDING_CREDIT' && (await this.directory.isSuspended(order.requesterId));
    return {
      kind: 'RESERVED',
      command: {
        action: 'CREDIT_RESERVED',
        requesterSuspended,
        reason: requesterSuspended ? SUSPENSION_EFFECTS.REQUESTER.reason : undefined,
      },
      repeats: (current) => current.status === 'OPEN',
    };
  }
}

/** What one reply asks of the order, and which recorded state it would merely repeat. */
interface Outcome {
  kind: 'RESERVED' | 'REJECTED';
  command: Pick<TransitionCommand, 'action' | 'requesterSuspended' | 'reason' | 'patch'>;
  repeats: (order: OrderRow) => boolean;
}

function rejected(payload: CreditReservationRejectedPayload): Outcome {
  // Only an insufficient-credits refusal reports the balance.
  const available = 'available' in payload ? payload.available : null;
  return {
    kind: 'REJECTED',
    command: {
      action: 'CREDIT_REJECTED',
      patch: { rejection_reason: payload.reason, available_at_rejection: available },
    },
    repeats: (current) =>
      current.status === 'REJECTED' &&
      current.rejectionReason === payload.reason &&
      current.availableAtRejection === available,
  };
}
