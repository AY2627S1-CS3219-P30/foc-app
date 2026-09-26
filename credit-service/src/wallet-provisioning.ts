import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  userActivatedPayload,
  type EventConsumer,
  type Envelope,
  type UserActivatedPayload,
} from '@foc/platform';

export const WALLET_QUEUE = 'foc.credit.wallet-provisioning';

/**
 * Workflow 1 of EI-FR1.1.1 — create a wallet after a student's first
 * activation.
 *
 * The subscription and its retry and dead-letter behaviour are complete; the
 * handler is not. CRD-01 (#133) replaces the body below with the actual wallet
 * issuance, which must be idempotent on userId: `CS-FR1.1.2` requires a
 * repeated activation to return the existing wallet rather than issue more
 * credits, and this message can legitimately arrive more than once.
 */
@Injectable()
export class WalletProvisioning implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletProvisioning.name);

  constructor(@Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: WALLET_QUEUE,
      eventType: EVENTS.USER_ACTIVATED,
      payloadSchema: userActivatedPayload,
      handler: (envelope) => this.handle(envelope),
    });
  }

  private handle(envelope: Envelope<UserActivatedPayload>): void {
    this.logger.log({
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      userId: envelope.payload.userId,
      msg: 'activation received; wallet issuance lands with CRD-01',
    });
  }
}
