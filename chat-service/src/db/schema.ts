import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * One channel per errand (ADR 0012), opened by the first authorized request while the errand has
 * a courier. It holds nothing about the errand: who may read and send is asked of the Order
 * Service on every request. `latest_seq` numbers its messages; a send takes it under the row lock.
 */
export const channels = pgTable('channels', {
  orderId: uuid('order_id').primaryKey(),
  latestSeq: integer('latest_seq').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A message is stored once per sender and `client_id`, so a retried send repeats nothing. */
export const messages = pgTable(
  'messages',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => channels.orderId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    senderId: text('sender_id').notNull(),
    clientId: uuid('client_id').notNull(),
    body: text('body').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.seq] }),
    unique('messages_sender_client_key').on(t.orderId, t.senderId, t.clientId),
    // The rate limit counts a sender's messages over the last minute, across all channels.
    index('messages_sender_sent_idx').on(t.senderId, t.sentAt),
  ],
);

/** How far each participant has read; it only moves forward. */
export const readPositions = pgTable(
  'read_positions',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => channels.orderId, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.userId] })],
);

/**
 * Every administrator read of a channel or its messages (ADR 0008: admin reads of personal data
 * are recorded). No foreign key to `channels`: the record outlives the channel's 90-day retention.
 */
export const adminChannelReads = pgTable(
  'admin_channel_reads',
  {
    id: uuid('id').primaryKey(),
    adminUserId: text('admin_user_id').notNull(),
    orderId: uuid('order_id').notNull(),
    resource: text('resource').notNull(),
    correlationId: text('correlation_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('admin_channel_reads_resource_enum', sql`${t.resource} IN ('CHANNEL', 'MESSAGES')`),
    index('admin_channel_reads_admin_idx').on(t.adminUserId, t.readAt),
    index('admin_channel_reads_order_idx').on(t.orderId, t.readAt),
  ],
);
