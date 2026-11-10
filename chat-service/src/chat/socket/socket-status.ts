// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-03
// Scope: Generated the initial implementation for "close a user's sockets on identity change"
//   (#346).
// Author review: Anselm Long reviewed the implementation for correctness, ran it against the test
//   suite, and checked that it fits our service boundaries without fatal errors before committing.

import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import {
  AUTHENTICATOR,
  DEFAULT_CACHE_TTL_MS,
  IDENTITY_CHANGE_EVENTS,
  type Authenticator,
} from '@foc/auth-client';
import {
  EVENT_CONSUMER,
  userRoleChangedPayload,
  userStatusChangedPayload,
  type Envelope,
  type EventConsumer,
  type SubscriptionSpec,
} from '@foc/platform';
import { z } from 'zod';
import { SocketHub } from './socket-hub.js';

const QUEUE = Symbol('FOC_CHAT_SOCKET_STATUS_QUEUE');

/** As `authStatusEvents`: a burst beyond this many drops the oldest; the recheck still bounds it. */
const MAX_QUEUED_EVENTS = 1_000;

const identityChangedPayload = z.union([userStatusChangedPayload, userRoleChangedPayload]);

/**
 * #346 — close a user's chat sockets the moment their account is suspended or reactivated, or a
 * role changes, so each signs in again and the User Service decides afresh.
 *
 * Like `UserStatusInvalidation` it only forgets: it decides nothing from the payload, so a forged
 * or stale event costs at most a reconnect. It drops the cached identity first, because the
 * reconnect can arrive before this instance's `auth-status` queue has delivered the same event.
 */
@Injectable()
export class SocketStatusEvents implements OnApplicationBootstrap {
  private readonly logger = new Logger(SocketStatusEvents.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(SocketHub) private readonly hub: SocketHub,
    @Inject(QUEUE) private readonly queue: string,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: this.queue,
      eventType: IDENTITY_CHANGE_EVENTS,
      expectedProducer: 'user-service',
      payloadSchema: identityChangedPayload,
      handler: (envelope) => this.handle(envelope),
    });
  }

  handle(envelope: Envelope<{ userId: string }>): void {
    this.authenticator.invalidateUser(envelope.payload.userId);
    this.hub.identityChanged(envelope.payload.userId);
    this.logger.log({
      correlationId: envelope.correlationId,
      userId: envelope.payload.userId,
      eventType: envelope.eventType,
      msg: 'chat sockets closed on identity change',
    });
  }
}

/**
 * Chat's own queue for identity changes, beside the one `authStatusEvents` declares: one handler
 * per queue, so the cache's queue cannot also close sockets. Per instance, exclusive and
 * auto-deleted, since each instance holds its own sockets; `foc.chat.socket-status.<random>`
 * falls within the chat-service account's `foc.chat.*` permissions.
 */
export function socketStatusEvents(cache: { cacheTtlMs?: number } = {}): {
  subscription: SubscriptionSpec;
  providers: Provider[];
} {
  const queue = `foc.chat.socket-status.${randomUUID()}`;
  return {
    subscription: {
      queue,
      metricsLabel: 'foc.chat.socket-status',
      routingKeys: [...IDENTITY_CHANGE_EVENTS],
      exclusive: true,
      autoDelete: true,
      messageTtlMs: cache.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      maxLength: MAX_QUEUED_EVENTS,
    },
    providers: [{ provide: QUEUE, useValue: queue }, SocketStatusEvents],
  };
}
