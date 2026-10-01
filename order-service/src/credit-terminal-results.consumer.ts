import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  UnparseableMessageError,
  creditsReleasedPayload,
  creditsTransferredPayload,
  withInbox,
  type CreditsReleasedPayload,
  type CreditsTransferredPayload,
  type Db,
  type Envelope,
  type EventConsumer,
  type Queryable,
} from '@foc/platform';
import { ORDER_DB } from './db/db.js';
import { OrdersRepository } from './orders/orders.repository.js';
import type { OrderRow } from './orders/types.js';

export const TRANSFER_RESULTS_QUEUE = 'foc.order.transfer-results';
export const RELEASE_RESULTS_QUEUE = 'foc.order.release-results';

/**
 * Finishes an errand only on the Credit Service's own confirmation (OS-FR5.1.1, EC4). The reply
 * must restate exactly the requester, courier and amount Order asked for; anything else changes
 * nothing and is dead-lettered for an operator rather than guessed at. A redelivered or replayed
 * confirmation with the same transaction is a no-op, so the order completes once.
 */
@Injectable()
export class CreditTerminalResultsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(CreditTerminalResultsConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(ORDER_DB) private readonly db: Db,
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: TRANSFER_RESULTS_QUEUE,
      eventType: EVENTS.CREDITS_TRANSFERRED,
      expectedProducer: 'credit-service',
      payloadSchema: creditsTransferredPayload,
      handler: withInbox(this.db, TRANSFER_RESULTS_QUEUE, async (envelope, tx) => {
        await this.handleTransfer(envelope, tx);
      }),
    });
    await this.consumer.subscribe({
      queue: RELEASE_RESULTS_QUEUE,
      eventType: EVENTS.CREDITS_RELEASED,
      expectedProducer: 'credit-service',
      payloadSchema: creditsReleasedPayload,
      handler: withInbox(this.db, RELEASE_RESULTS_QUEUE, async (envelope, tx) => {
        await this.handleRelease(envelope, tx);
      }),
    });
  }

  /**
   * Closes a cancelled or expired errand (OS-FR6.1.2) only on Credit's confirmation that the
   * reserved reward went back to the requester. The same matching, dead-lettering and duplicate
   * rules as a transfer apply, so the release is recorded once.
   */
  async handleRelease(envelope: Envelope<CreditsReleasedPayload>, tx: Queryable): Promise<boolean> {
    const payload = envelope.payload;
    if (envelope.aggregateId !== payload.orderId) {
      throw new UnparseableMessageError('aggregateId does not match the released orderId');
    }
    const matches = (order: OrderRow) =>
      order.requesterId === payload.requesterId && order.reward === payload.amount;

    const result = await this.orders.transition(
      {
        orderId: payload.orderId,
        action: 'RELEASE_CONFIRMED',
        actor: { kind: 'CREDIT_SERVICE', id: 'credit-service' },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        patch: { credit_transaction_id: payload.transactionId },
        verify: (order) => {
          if (!matches(order)) {
            throw new UnparseableMessageError('release does not match the requested release');
          }
        },
      },
      tx,
    );

    if (result.kind === 'rejected') {
      const order = result.order;
      const duplicate =
        (order?.status === 'CANCELLED' || order?.status === 'EXPIRED') &&
        order.creditTransactionId === payload.transactionId &&
        matches(order);
      if (!duplicate) {
        throw new UnparseableMessageError(
          `release confirmation cannot close order in ${order?.status ?? 'unknown'} state`,
        );
      }
    }
    const changed = result.kind === 'applied';
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId: payload.orderId,
      transactionId: payload.transactionId,
      changed,
      msg: 'credit release confirmation handled',
    });
    return changed;
  }

  async handleTransfer(
    envelope: Envelope<CreditsTransferredPayload>,
    tx: Queryable,
  ): Promise<boolean> {
    const payload = envelope.payload;
    if (envelope.aggregateId !== payload.orderId) {
      throw new UnparseableMessageError('aggregateId does not match the transferred orderId');
    }
    const matches = (order: OrderRow) =>
      order.requesterId === payload.requesterId &&
      order.courierId === payload.courierId &&
      order.reward === payload.amount;

    const result = await this.orders.transition(
      {
        orderId: payload.orderId,
        action: 'TRANSFER_CONFIRMED',
        actor: { kind: 'CREDIT_SERVICE', id: 'credit-service' },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        patch: { credit_transaction_id: payload.transactionId },
        verify: (order) => {
          if (!matches(order)) {
            throw new UnparseableMessageError('transfer does not match the requested completion');
          }
        },
        afterApply: (inner, order) => this.orders.insertReceipt(inner, order),
      },
      tx,
    );

    if (result.kind === 'rejected') {
      const order = result.order;
      const duplicate =
        order?.status === 'COMPLETED' &&
        order.creditTransactionId === payload.transactionId &&
        matches(order);
      if (!duplicate) {
        throw new UnparseableMessageError(
          `transfer confirmation cannot complete order in ${order?.status ?? 'unknown'} state`,
        );
      }
    }
    const changed = result.kind === 'applied';
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId: payload.orderId,
      transactionId: payload.transactionId,
      changed,
      msg: 'credit transfer confirmation handled',
    });
    return changed;
  }
}
