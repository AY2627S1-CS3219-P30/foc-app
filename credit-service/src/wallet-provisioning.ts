import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  userActivatedPayload,
  UnparseableMessageError,
  withInbox,
  type Db,
  type EventConsumer,
  type Envelope,
  type UserActivatedPayload,
} from '@foc/platform';
import { CreditRepository } from './credits/credit.repository.js';
import { RAW_DB } from './db/db.js';

export const WALLET_QUEUE = 'foc.credit.wallet-provisioning';

/**
 * Workflow 1 of EI-FR1.1.1 — create a wallet after a student's first
 * activation.
 *
 * Event-id duplicates are removed by the inbox; distinct activation events for
 * the same user are deduplicated by the wallet primary key. The wallet, ISSUE
 * transaction and balanced ledger entries commit together.
 */
@Injectable()
export class WalletProvisioning implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletProvisioning.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(RAW_DB) private readonly db: Db,
    @Inject(CreditRepository) private readonly credits: CreditRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: WALLET_QUEUE,
      eventType: EVENTS.USER_ACTIVATED,
      expectedProducer: 'user-service',
      payloadSchema: userActivatedPayload,
      handler: withInbox(this.db, WALLET_QUEUE, (envelope, tx) => this.handle(envelope, tx)),
    });
  }

  private async handle(
    envelope: Envelope<UserActivatedPayload>,
    tx: import('@foc/platform').Queryable,
  ): Promise<void> {
    if (envelope.aggregateId !== envelope.payload.userId) {
      throw new UnparseableMessageError('aggregateId does not match activated userId');
    }
    const issued = await this.credits.issueInitial(tx, envelope.payload.userId);
    this.logger.log({
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      userId: envelope.payload.userId,
      issued,
      msg: issued ? 'wallet created and initial credits issued' : 'wallet already exists',
    });
  }
}
