import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import {
  EVENT_CONSUMER,
  EVENTS,
  userStatusChangedPayload,
  type Envelope,
  type EventConsumer,
  type SubscriptionSpec,
  type UserStatusChangedPayload,
} from '@foc/platform';
import type { Authenticator } from './authenticator.js';
import { AUTHENTICATOR } from './nest.js';

const QUEUE_OPTIONS = Symbol('FOC_AUTH_STATUS_QUEUE');

/**
 * USR-07 — drop a user's cached identity the moment their account is suspended or reactivated,
 * instead of waiting out the cache window (`cacheTtlMs`, 5 s by default).
 *
 * The handler only ever *forgets*: it never decides anything from the event's payload. The next
 * request from that user asks the User Service, which remains the only source of status and role.
 * So a forged, duplicated, reordered or stale event can at worst cost one extra lookup — it can
 * never grant access or keep a suspended user in.
 */
@Injectable()
export class UserStatusInvalidation implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserStatusInvalidation.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(QUEUE_OPTIONS) private readonly queue: string,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // One queue bound to both routing keys: the two events share a payload schema, and the
    // handler does the same thing for either.
    await this.consumer.subscribe({
      queue: this.queue,
      eventType: `${EVENTS.USER_SUSPENDED}|${EVENTS.USER_REACTIVATED}`,
      payloadSchema: userStatusChangedPayload,
      handler: (envelope) => this.handle(envelope),
    });
  }

  handle(envelope: Envelope<UserStatusChangedPayload>): void {
    this.authenticator.invalidateUser(envelope.payload.userId);
    this.logger.log({
      correlationId: envelope.correlationId,
      userId: envelope.payload.userId,
      eventType: envelope.eventType,
      msg: 'cached identity invalidated',
    });
  }
}

/**
 * Everything a service needs to invalidate on status events. Use it only where the service
 * configures a broker:
 *
 * ```ts
 * const status = authStatusEvents('order');
 * EventsModule.forRoot({ url, producer, subscriptions: [status.subscription] })
 * // and in the same module:
 * providers: [...status.providers]
 * ```
 *
 * Each service gets its own queue, so every service hears every status change. Replicas of one
 * service share that queue, so only one replica invalidates; the others fall back to the cache
 * window. That is inside USR-07's 10 s bound; a per-replica exclusive queue would close it.
 */
export function authStatusEvents(service: string): {
  subscription: SubscriptionSpec;
  providers: Provider[];
} {
  const queue = `foc.${service}.auth-status`;
  return {
    subscription: { queue, routingKeys: [EVENTS.USER_SUSPENDED, EVENTS.USER_REACTIVATED] },
    providers: [{ provide: QUEUE_OPTIONS, useValue: queue }, UserStatusInvalidation],
  };
}
