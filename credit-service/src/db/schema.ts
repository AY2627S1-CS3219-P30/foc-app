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

export const wallets = pgTable(
  'wallets',
  {
    userId: text('user_id').primaryKey(),
    available: integer('available').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('wallets_available_nonnegative', sql`${t.available} >= 0`),
    check('wallets_reserved_nonnegative', sql`${t.reserved} >= 0`),
  ],
);

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    transactionId: uuid('transaction_id').primaryKey(),
    orderId: text('order_id'),
    transactionType: text('transaction_type').notNull(),
    walletUserId: text('wallet_user_id').references(() => wallets.userId, {
      onDelete: 'restrict',
    }),
    amount: integer('amount').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'credit_transactions_type_enum',
      sql`${t.transactionType} IN ('ISSUE', 'RESERVE', 'RELEASE', 'TRANSFER')`,
    ),
    check('credit_transactions_amount_positive', sql`${t.amount} > 0`),
    uniqueIndex('credit_transactions_order_type_key')
      .on(t.orderId, t.transactionType)
      .where(sql`${t.orderId} IS NOT NULL`),
    uniqueIndex('credit_transactions_issue_wallet_key')
      .on(t.walletUserId, t.transactionType)
      .where(sql`${t.transactionType} = 'ISSUE'`),
    uniqueIndex('credit_transactions_terminal_order_key')
      .on(t.orderId)
      .where(sql`${t.orderId} IS NOT NULL AND ${t.transactionType} IN ('RELEASE', 'TRANSFER')`),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    entryId: uuid('entry_id').primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => creditTransactions.transactionId, { onDelete: 'restrict' }),
    entryNo: integer('entry_no').notNull(),
    walletUserId: text('wallet_user_id').references(() => wallets.userId, {
      onDelete: 'restrict',
    }),
    account: text('account').notNull(),
    direction: text('direction').notNull(),
    amount: integer('amount').notNull(),
    resultingAvailable: integer('resulting_available'),
    resultingReserved: integer('resulting_reserved'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'ledger_entries_account_enum',
      sql`${t.account} IN ('PLATFORM_ISSUANCE', 'AVAILABLE', 'RESERVED')`,
    ),
    check('ledger_entries_direction_enum', sql`${t.direction} IN ('DEBIT', 'CREDIT')`),
    check('ledger_entries_amount_positive', sql`${t.amount} > 0`),
    check(
      'ledger_entries_result_pair',
      sql`(${t.resultingAvailable} IS NULL) = (${t.resultingReserved} IS NULL)`,
    ),
    check(
      'ledger_entries_wallet_result',
      sql`(${t.walletUserId} IS NULL) = (${t.resultingAvailable} IS NULL)`,
    ),
    check(
      'ledger_entries_result_nonnegative',
      sql`${t.resultingAvailable} IS NULL OR (${t.resultingAvailable} >= 0 AND ${t.resultingReserved} >= 0)`,
    ),
    uniqueIndex('ledger_entries_transaction_entry_key').on(t.transactionId, t.entryNo),
    index('ledger_entries_wallet_history_idx').on(t.walletUserId, t.occurredAt),
  ],
);

export const creditOperations = pgTable(
  'credit_operations',
  {
    orderId: text('order_id').notNull(),
    operationType: text('operation_type').notNull(),
    requesterId: text('requester_id').notNull(),
    courierId: text('courier_id').references(() => wallets.userId, {
      onDelete: 'restrict',
    }),
    amount: integer('amount').notNull(),
    outcome: text('outcome').notNull(),
    rejectionReason: text('rejection_reason'),
    availableAtDecision: integer('available_at_decision'),
    transactionId: uuid('transaction_id').references(() => creditTransactions.transactionId, {
      onDelete: 'restrict',
    }),
    resultPayload: jsonb('result_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.operationType] }),
    check(
      'credit_operations_type_enum',
      sql`${t.operationType} IN ('RESERVE', 'RELEASE', 'TRANSFER')`,
    ),
    check('credit_operations_amount_positive', sql`${t.amount} > 0`),
    check(
      'credit_operations_outcome_enum',
      sql`${t.outcome} IN ('PENDING', 'SUCCEEDED', 'REJECTED')`,
    ),
    check(
      'credit_operations_rejection_reason_enum',
      sql`${t.rejectionReason} IS NULL OR ${t.rejectionReason} IN ('INSUFFICIENT_CREDITS', 'AMOUNT_OUT_OF_RANGE')`,
    ),
    check(
      'credit_operations_outcome_shape',
      sql`(${t.outcome} = 'PENDING' AND ${t.transactionId} IS NULL AND ${t.rejectionReason} IS NULL)
          OR (${t.outcome} = 'SUCCEEDED' AND ${t.transactionId} IS NOT NULL AND ${t.rejectionReason} IS NULL)
          OR (${t.outcome} = 'REJECTED' AND ${t.transactionId} IS NULL AND ${t.rejectionReason} IS NOT NULL)`,
    ),
    check(
      'credit_operations_party_shape',
      sql`(${t.operationType} = 'TRANSFER' AND ${t.courierId} IS NOT NULL)
          OR (${t.operationType} <> 'TRANSFER' AND ${t.courierId} IS NULL)`,
    ),
    uniqueIndex('credit_operations_terminal_order_key')
      .on(t.orderId)
      .where(sql`${t.operationType} IN ('RELEASE', 'TRANSFER')`),
  ],
);

export const creditAuditAlerts = pgTable(
  'credit_audit_alerts',
  {
    alertId: uuid('alert_id').primaryKey(),
    orderId: text('order_id').notNull(),
    operationType: text('operation_type').notNull(),
    code: text('code').notNull(),
    details: jsonb('details').notNull(),
    correlationId: text('correlation_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_audit_alerts_order_idx').on(t.orderId, t.occurredAt)],
);

export const adminWalletReads = pgTable(
  'admin_wallet_reads',
  {
    auditId: uuid('audit_id').primaryKey(),
    adminUserId: text('admin_user_id').notNull(),
    targetUserId: text('target_user_id').notNull(),
    resource: text('resource').notNull(),
    correlationId: text('correlation_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('admin_wallet_reads_resource_enum', sql`${t.resource} IN ('WALLET', 'LEDGER')`),
    index('admin_wallet_reads_target_idx').on(t.targetUserId, t.occurredAt),
  ],
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
