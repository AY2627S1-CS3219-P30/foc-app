import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { OrderItem, OrderStatus, SupplierSnapshot } from '../orders/types.js';

const statusCheck = (column: unknown) =>
  sql`${column} IN ('PENDING_CREDIT', 'OPEN', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETION_PENDING_CREDIT', 'RELEASE_PENDING_CREDIT', 'REJECTED', 'COMPLETED', 'CANCELLED', 'EXPIRED')`;

export const orders = pgTable(
  'orders',
  {
    orderId: uuid('order_id').primaryKey(),
    requesterId: text('requester_id').notNull(),
    courierId: text('courier_id'),
    referredAdminId: text('referred_admin_id'),
    supplierSnapshot: jsonb('supplier_snapshot').notNull().$type<SupplierSnapshot>(),
    items: jsonb('items').notNull().$type<OrderItem[]>(),
    deliveryZone: text('delivery_zone').notNull(),
    deliveryInstructions: text('delivery_instructions').notNull(),
    reward: integer('reward').notNull(),
    status: text('status').notNull().$type<OrderStatus>(),
    releaseReason: text('release_reason'),
    rejectionReason: text('rejection_reason'),
    availableAtRejection: integer('available_at_rejection'),
    version: integer('version').notNull().default(1),
    acceptanceDeadlineAt: timestamp('acceptance_deadline_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    completionRequestedAt: timestamp('completion_requested_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    releaseRequestedAt: timestamp('release_requested_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    creditTransactionId: uuid('credit_transaction_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('orders_status_enum', statusCheck(t.status)),
    check('orders_reward_range', sql`${t.reward} BETWEEN 1 AND 5`),
    check('orders_version_positive', sql`${t.version} >= 1`),
    check(
      'orders_items_array',
      sql`jsonb_typeof(${t.items}) = 'array' AND jsonb_array_length(${t.items}) > 0`,
    ),
    check('orders_supplier_object', sql`jsonb_typeof(${t.supplierSnapshot}) = 'object'`),
    check('orders_delivery_zone_len', sql`char_length(${t.deliveryZone}) BETWEEN 1 AND 200`),
    check(
      'orders_delivery_instructions_len',
      sql`char_length(${t.deliveryInstructions}) BETWEEN 1 AND 1000`,
    ),
    check(
      'orders_courier_shape',
      sql`${t.status} NOT IN ('ACCEPTED', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETION_PENDING_CREDIT', 'COMPLETED') OR ${t.courierId} IS NOT NULL`,
    ),
    check(
      'orders_release_reason_shape',
      sql`${t.releaseReason} IS NULL OR ${t.releaseReason} IN ('CANCELLED', 'EXPIRED')`,
    ),
    check(
      'orders_completed_shape',
      sql`${t.status} <> 'COMPLETED' OR (${t.completedAt} IS NOT NULL AND ${t.creditTransactionId} IS NOT NULL)`,
    ),
    check(
      'orders_released_shape',
      sql`${t.status} NOT IN ('CANCELLED', 'EXPIRED') OR (${t.releasedAt} IS NOT NULL AND ${t.creditTransactionId} IS NOT NULL AND ${t.releaseReason} IS NOT NULL)`,
    ),
    check(
      'orders_rejection_shape',
      sql`(${t.status} = 'REJECTED') = (${t.rejectionReason} IS NOT NULL)`,
    ),
    index('orders_status_created_idx').on(t.status, t.createdAt),
    index('orders_requester_created_idx').on(t.requesterId, t.createdAt),
    index('orders_courier_created_idx').on(t.courierId, t.createdAt),
    index('orders_referred_admin_created_idx').on(t.referredAdminId, t.createdAt),
    index('orders_accepted_at_idx')
      .on(t.acceptedAt)
      .where(sql`${t.status} = 'ACCEPTED'`),
    index('orders_open_deadline_idx')
      .on(t.acceptanceDeadlineAt, t.createdAt)
      .where(sql`${t.status} = 'OPEN'`),
  ],
);

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    historyId: uuid('history_id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.orderId, { onDelete: 'restrict' }),
    previousStatus: text('previous_status').$type<OrderStatus>(),
    newStatus: text('new_status').notNull().$type<OrderStatus>(),
    action: text('action').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    orderVersion: integer('order_version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'order_history_previous_status_enum',
      sql`${t.previousStatus} IS NULL OR ${statusCheck(t.previousStatus)}`,
    ),
    check('order_history_new_status_enum', statusCheck(t.newStatus)),
    check(
      'order_history_actor_type_enum',
      sql`${t.actorType} IN ('REQUESTER', 'COURIER', 'STUDENT', 'ADMIN', 'CREDIT_SERVICE', 'SYSTEM')`,
    ),
    uniqueIndex('order_history_order_version_key').on(t.orderId, t.orderVersion),
    index('order_history_order_time_idx').on(t.orderId, t.occurredAt),
  ],
);

/**
 * The immutable completion receipt (OS-FR5.1.2), written in the same transaction as the Credit
 * Service's transfer confirmation. A trigger makes it append-only, like the status history.
 */
export const orderReceipts = pgTable(
  'order_receipts',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.orderId, { onDelete: 'restrict' }),
    requesterId: text('requester_id').notNull(),
    courierId: text('courier_id').notNull(),
    supplierSnapshot: jsonb('supplier_snapshot').notNull().$type<SupplierSnapshot>(),
    reward: integer('reward').notNull(),
    creditTransactionId: uuid('credit_transaction_id').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
    completionRequestedAt: timestamp('completion_requested_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('order_receipts_reward_range', sql`${t.reward} BETWEEN 1 AND 5`)],
);

export const orderIdempotencyKeys = pgTable(
  'order_idempotency_keys',
  {
    requesterId: text('requester_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.orderId, { onDelete: 'restrict' }),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requesterId, t.idempotencyKey] })],
);

export const processedEvents = pgTable(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    eventType: text('event_type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.seq)
      .where(sql`${t.publishedAt} IS NULL`),
    index('outbox_events_pending_aggregate_idx')
      .on(t.aggregateId, t.seq)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);
