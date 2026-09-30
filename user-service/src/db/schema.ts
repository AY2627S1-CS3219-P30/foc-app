import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import type { AccountStatus, Role } from '../users/users.repository.js';
import type { AuditAction, AuditActorType } from '../admin/admin.repository.js';

/**
 * The Drizzle schema for the identity tables — one source of truth for both the
 * query builder (repositories) and drizzle-kit (`db:generate`, `db:studio`).
 *
 * The SQL migrations under `./drizzle` are what is applied to the database:
 * `db:generate` diffs this file into a structural baseline, and a hand-written
 * custom migration adds the `audit_records` append-only trigger, its plpgsql
 * function and the `REVOKE` — objects Drizzle's schema DSL cannot express.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: text('status').notNull().$type<AccountStatus>(),
    isSeededAdmin: boolean('is_seeded_admin').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_status_enum', sql`${t.status} IN ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED')`),
    // Uniqueness is enforced by the database, not just the service: a duplicate
    // cannot slip in through a race or a future code path.
    uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role').notNull().$type<Role>(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    check('user_roles_role_enum', sql`${t.role} IN ('STUDENT', 'ADMIN')`),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    faculty: text('faculty'),
    avatarRef: text('avatar_ref'),
    contactPreference: text('contact_preference').notNull().default('IN_APP'),
    preferredMode: text('preferred_mode').notNull().default('REQUESTER'),
  },
  (t) => [
    check('profiles_display_name_len', sql`char_length(${t.displayName}) BETWEEN 1 AND 50`),
    check('profiles_contact_pref_enum', sql`${t.contactPreference} IN ('IN_APP', 'EMAIL')`),
    check('profiles_preferred_mode_enum', sql`${t.preferredMode} IN ('REQUESTER', 'COURIER')`),
  ],
);

/** Only the SHA-256 of the token is stored; the raw token exists in the email alone. */
export const activationTokens = pgTable(
  'activation_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('activation_tokens_user_idx').on(t.userId)],
);

/**
 * Events are written here in the same transaction as the change that caused
 * them; the platform's OutboxRelay publishes committed rows (EVT-02).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    seq: bigint('seq', { mode: 'number' }).generatedByDefaultAsIdentity(),
    eventType: text('event_type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    aggregateId: uuid('aggregate_id').notNull(),
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
      .where(sql`published_at IS NULL`),
    index('outbox_events_pending_aggregate_idx')
      .on(t.aggregateId, t.seq)
      .where(sql`published_at IS NULL`),
  ],
);

/**
 * A login starts a family; every rotation adds a row to it. Presenting an
 * already-rotated token revokes the whole family, so a stolen token cannot
 * outlive its owner's next refresh. Only the SHA-256 of a refresh token is kept.
 */
export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('refresh_sessions_user_idx').on(t.userId),
    index('refresh_sessions_family_idx').on(t.familyId),
  ],
);

/**
 * One row per suspension, reactivation, role change and bootstrap (US-NFR4.1.2).
 * The actor is a user (`actorId` set) or the SYSTEM (`actorId` null), never both.
 * Append-only — enforced by a trigger and a `REVOKE` that this schema cannot
 * express, so those live in the custom migration `0001_audit_append_only.sql`.
 */
export const auditRecords = pgTable(
  'audit_records',
  {
    id: uuid('id').primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    actorType: text('actor_type').notNull().default('USER').$type<AuditActorType>(),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: text('action').notNull().$type<AuditAction>(),
    reason: text('reason').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    correlationId: text('correlation_id').notNull(),
  },
  (t) => [
    check(
      'audit_records_action_check',
      sql`${t.action} IN ('SUSPEND', 'REACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'ADMIN_BOOTSTRAP')`,
    ),
    check('audit_records_actor_type_check', sql`${t.actorType} IN ('USER', 'SYSTEM')`),
    check(
      'audit_records_actor_consistent',
      sql`(${t.actorType} = 'SYSTEM') = (${t.actorId} IS NULL)`,
    ),
    check('audit_records_reason_len', sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
    index('audit_records_target_idx').on(t.targetUserId, sql`${t.occurredAt} DESC`),
  ],
);
