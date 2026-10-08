import { randomUUID } from 'node:crypto';
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
  userRoleChangedPayload,
  userStatusChangedPayload,
  type Envelope,
  type EventConsumer,
  type SubscriptionSpec,
} from '@foc/platform';
import { z } from 'zod';
import type { Authenticator } from './authenticator.js';
import { DEFAULT_CACHE_TTL_MS } from './identity-client.js';
import { AUTHENTICATOR } from './nest.js';

const QUEUE_OPTIONS = Symbol('FOC_AUTH_STATUS_QUEUE');

/** Every event after which a cached identity may be wrong: status or role changed. */
export const IDENTITY_CHANGE_EVENTS = [
  EVENTS.USER_SUSPENDED,
  EVENTS.USER_REACTIVATED,
  EVENTS.USER_ROLE_CHANGED,
] as const;

/** Either shape; the handler reads nothing but `userId`. */
const identityChangedPayload = z.union([userStatusChangedPayload, userRoleChangedPayload]);
type IdentityChangedPayload = z.infer<typeof identityChangedPayload>;

/**
 * An invalidation is only useful while a stale answer could still be cached, so a message older
 * than the cache window is discarded unread; and a burst beyond this many drops the oldest. Either
 * way the cache window still bounds staleness.
 */
const MAX_QUEUED_INVALIDATIONS = 1_000;

/**
 * USR-07 — drop a user's cached identity the moment their account is suspended or reactivated,
 * or an administrator role is granted or revoked, instead of waiting out the cache window
 * (`cacheTtlMs`, 5 s by default).
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
    // One queue bound to every routing key: the handler does the same thing for each.
    await this.consumer.subscribe({
      queue: this.queue,
      eventType: IDENTITY_CHANGE_EVENTS,
      expectedProducer: 'user-service',
      payloadSchema: identityChangedPayload,
      handler: (envelope) => this.handle(envelope),
    });
  }

  handle(envelope: Envelope<Pick<IdentityChangedPayload, 'userId'>>): void {
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
 * Everything a service needs to invalidate on identity events. Use it only where the service
 * configures a broker, and pass the same config as `AuthModule.forRoot` so the queue's message TTL
 * matches the cache window:
 *
 * ```ts
 * const status = authStatusEvents('order', authConfig);
 * EventsModule.forRoot({ url, producer, subscriptions: [status.subscription] })
 * // and in the same module:
 * providers: [...status.providers]
 * ```
 *
 * Every **instance** gets its own queue (`foc.<service>.auth-status.<random>`), because every
 * instance holds its own cache: a queue shared by replicas would hand each event to one of them.
 * The queue is exclusive and auto-deleted, so it goes with the instance, and it is declared afresh
 * on every (re)connect — an instance that was down has an empty cache and nothing to catch up on.
 * Its metrics are labelled `foc.<service>.auth-status`, without the random part, so a restart
 * continues the same series instead of starting new ones.
 */
export function authStatusEvents(
  service: string,
  cache: { cacheTtlMs?: number } = {},
): {
  subscription: SubscriptionSpec;
  providers: Provider[];
} {
  const queue = `foc.${service}.auth-status.${randomUUID()}`;
  return {
    subscription: {
      queue,
      metricsLabel: `foc.${service}.auth-status`,
      routingKeys: [...IDENTITY_CHANGE_EVENTS],
      exclusive: true,
      autoDelete: true,
      messageTtlMs: cache.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      maxLength: MAX_QUEUED_INVALIDATIONS,
    },
    providers: [{ provide: QUEUE_OPTIONS, useValue: queue }, UserStatusInvalidation],
  };
}
