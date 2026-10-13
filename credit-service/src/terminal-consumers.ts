import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  UnparseableMessageError,
  creditReleaseRequestedPayload,
  orderCompletionRequestedPayload,
  withReplayableInbox,
  type CreditReleaseRequestedPayload,
  type Db,
  type Envelope,
  type EventConsumer,
  type OrderCompletionRequestedPayload,
  type Queryable,
} from '@foc/platform';
import { CreditRepository } from './credits/credit.repository.js';
import { RAW_DB } from './db/db.js';

export const COMPLETION_QUEUE = 'foc.credit.completions';
export const RELEASE_QUEUE = 'foc.credit.releases';

@Injectable()
export class CompletionConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompletionConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(RAW_DB) private readonly db: Db,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: COMPLETION_QUEUE,
      eventType: EVENTS.ORDER_COMPLETION_REQUESTED,
      expectedProducer: 'order-service',
      payloadSchema: orderCompletionRequestedPayload,
      handler: withReplayableInbox(this.db, COMPLETION_QUEUE, (envelope, tx) =>
        this.handle(envelope, tx),
      ),
    });
  }

  private async handle(
    envelope: Envelope<OrderCompletionRequestedPayload>,
    tx: Queryable,
  ): Promise<void> {
    if (envelope.aggregateId !== envelope.payload.orderId) {
      throw new UnparseableMessageError('aggregateId does not match completion orderId');
    }
    const outcome = await this.credits.transfer(tx, {
      ...envelope.payload,
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
    });
    const entry = {
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId: envelope.payload.orderId,
      outcome,
      msg: 'completion request recorded',
    };
    if (outcome.status === 'REJECTED') this.logger.warn(entry);
    else this.logger.log(entry);
  }
}

@Injectable()
export class ReleaseConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReleaseConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(RAW_DB) private readonly db: Db,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: RELEASE_QUEUE,
      eventType: EVENTS.CREDIT_RELEASE_REQUESTED,
      expectedProducer: 'order-service',
      payloadSchema: creditReleaseRequestedPayload,
      handler: withReplayableInbox(this.db, RELEASE_QUEUE, (envelope, tx) =>
        this.handle(envelope, tx),
      ),
    });
  }

  private async handle(
    envelope: Envelope<CreditReleaseRequestedPayload>,
    tx: Queryable,
  ): Promise<void> {
    if (envelope.aggregateId !== envelope.payload.orderId) {
      throw new UnparseableMessageError('aggregateId does not match release orderId');
    }
    const outcome = await this.credits.release(tx, {
      ...envelope.payload,
      correlationId: envelope.correlationId,
      causationId: envelope.eventId,
    });
    const entry = {
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      orderId: envelope.payload.orderId,
      outcome,
      msg: 'release request recorded',
    };
    if (outcome.status === 'REJECTED') this.logger.warn(entry);
    else this.logger.log(entry);
  }
}
