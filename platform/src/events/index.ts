export {
  createEnvelope,
  envelopeSchema,
  parseEnvelope,
  UnparseableMessageError,
  type Envelope,
  type NewEventInput,
} from './envelope.js';
export {
  EVENTS,
  PAYLOAD_SCHEMAS,
  creditReservationRejectedPayload,
  creditReservationRequestedPayload,
  creditsReservedPayload,
  userActivatedPayload,
  userRoleChangedPayload,
  userStatusChangedPayload,
  type CreditReservationRejectedPayload,
  type CreditReservationRequestedPayload,
  type CreditsReservedPayload,
  type EventType,
  type UserActivatedPayload,
  type UserRoleChangedPayload,
  type UserStatusChangedPayload,
} from './catalogue.js';
export {
  DLX,
  EXCHANGE,
  HEADER_ATTEMPT,
  HEADER_FAILURE,
  HEADER_ORIGINAL_QUEUE,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  deadLetterQueueName,
  isTransient,
  retryExchangeName,
  retryLevels,
  retryQueueName,
  type SubscriptionSpec,
} from './topology.js';
export { BrokerConnection } from './connection.js';
export type { BrokerConnectionOptions, ConnectedListener } from './connection.js';
export { EventPublisher } from './publisher.js';
export {
  EventConsumer,
  type EventHandler,
  type HandlerContext,
  type SubscribeOptions,
} from './consumer.js';
export {
  BROKER,
  EVENT_CONSUMER,
  EVENT_PUBLISHER,
  EventsModule,
  type EventsModuleOptions,
} from './events.module.js';
export {
  OUTBOX_RELAY,
  OUTBOX_TABLE_SQL,
  OutboxRelay,
  insertOutboxEvent,
  provideOutboxRelay,
  type CataloguedEventType,
  type NewOutboxEvent,
  type OutboxRelayOptions,
  type OutboxRelayStats,
} from './outbox.js';
export { INBOX_TABLE_SQL, processOnce, withInbox, type InboxHandler } from './inbox.js';
