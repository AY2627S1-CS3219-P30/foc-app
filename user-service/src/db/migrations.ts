import type { Migration } from '@foc/platform';

/**
 * Forward-only migrations, applied in order at boot and never edited once
 * merged: a change is a new entry. Kept as TypeScript strings rather than .sql
 * files so `tsc` carries them into `dist/` with no copy step.
 *
 * Schema rationale: docs/user-service/schema.md.
 */
export const migrations: Migration[] = [
  {
    id: '001_identity',
    sql: `
      CREATE TABLE users (
        id              uuid PRIMARY KEY,
        email           text NOT NULL,
        password_hash   text NOT NULL,
        status          text NOT NULL
                        CHECK (status IN ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED')),
        is_seeded_admin boolean NOT NULL DEFAULT false,
        activated_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      -- Uniqueness is enforced by the database, not just by the service: a
      -- duplicate cannot slip in through a race or a future code path.
      CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

      CREATE TABLE user_roles (
        user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        role       text NOT NULL CHECK (role IN ('STUDENT', 'ADMIN')),
        granted_by uuid REFERENCES users (id) ON DELETE RESTRICT,
        granted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, role)
      );

      CREATE TABLE profiles (
        user_id            uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
        display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
        faculty            text,
        avatar_ref         text,
        contact_preference text NOT NULL DEFAULT 'IN_APP'
                           CHECK (contact_preference IN ('IN_APP', 'EMAIL')),
        preferred_mode     text NOT NULL DEFAULT 'REQUESTER'
                           CHECK (preferred_mode IN ('REQUESTER', 'COURIER'))
      );

      -- Only the SHA-256 of the token is stored; the raw token exists in the email alone.
      CREATE TABLE activation_tokens (
        id          uuid PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        token_hash  text NOT NULL UNIQUE,
        expires_at  timestamptz NOT NULL,
        consumed_at timestamptz
      );
      CREATE INDEX activation_tokens_user_idx ON activation_tokens (user_id);

      -- Events are written here in the same transaction as the change that
      -- caused them. A publisher (EVT-02) drains it; nothing is lost if the
      -- broker is down at the moment of activation.
      CREATE TABLE outbox_events (
        id             uuid PRIMARY KEY,
        event_type     text NOT NULL,
        aggregate_id   uuid NOT NULL,
        payload        jsonb NOT NULL,
        correlation_id text NOT NULL,
        occurred_at    timestamptz NOT NULL DEFAULT now(),
        published_at   timestamptz
      );
      CREATE INDEX outbox_events_unpublished_idx ON outbox_events (occurred_at)
        WHERE published_at IS NULL;
    `,
  },
  {
    id: '002_refresh_sessions',
    sql: `
      -- Only the SHA-256 of a refresh token is stored. A login starts a family;
      -- every rotation adds a row to it. Presenting an already-rotated token
      -- revokes the whole family, so a stolen token cannot outlive its owner's
      -- next refresh.
      CREATE TABLE refresh_sessions (
        id          uuid PRIMARY KEY,
        family_id   uuid NOT NULL,
        user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        token_hash  text NOT NULL UNIQUE,
        issued_at   timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL,
        rotated_at  timestamptz,
        revoked_at  timestamptz
      );
      CREATE INDEX refresh_sessions_user_idx ON refresh_sessions (user_id);
      CREATE INDEX refresh_sessions_family_idx ON refresh_sessions (family_id);
    `,
  },
  {
    id: '003_audit_records',
    sql: `
      -- One row per suspension, reactivation and role change (US-NFR4.1.2).
      -- Append-only, enforced twice: the service role loses UPDATE/DELETE/TRUNCATE
      -- on it, and a trigger rejects any UPDATE or DELETE regardless of who runs it.
      CREATE TABLE audit_records (
        id             uuid PRIMARY KEY,
        actor_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        target_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        action         text NOT NULL
                       CHECK (action IN ('SUSPEND', 'REACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE')),
        reason         text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
        occurred_at    timestamptz NOT NULL DEFAULT now(),
        correlation_id text NOT NULL
      );
      CREATE INDEX audit_records_target_idx ON audit_records (target_user_id, occurred_at DESC);

      CREATE FUNCTION audit_records_immutable() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'audit_records is append-only' USING ERRCODE = 'restrict_violation';
      END;
      $fn$ LANGUAGE plpgsql;

      CREATE TRIGGER audit_records_no_update_delete
        BEFORE UPDATE OR DELETE ON audit_records
        FOR EACH ROW EXECUTE FUNCTION audit_records_immutable();

      DO $do$
      BEGIN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM %I', current_user);
      END
      $do$;
    `,
  },
  {
    id: '004_bootstrap_hardening',
    sql: `
      -- The bootstrap password comes from deployment configuration, so it must not
      -- stay usable (US-FR3.1.3.2). A flagged account cannot start a session until
      -- its password is changed. Every existing bootstrap admin is flagged: there
      -- was no way to change a password before this migration.
      ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
      UPDATE users SET must_change_password = true WHERE is_seeded_admin;
      -- Nor may it keep one: a bootstrap admin who signed in with the secret before this
      -- migration is signed out everywhere, and must change the password to sign in again.
      UPDATE refresh_sessions SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND user_id IN (SELECT id FROM users WHERE must_change_password);

      -- The bootstrap itself is now audited, and it has no human actor. The actor
      -- is either a user (actor_id set) or the SYSTEM (actor_id null), never
      -- ambiguous. DDL, so the append-only row trigger is not involved.
      ALTER TABLE audit_records ALTER COLUMN actor_id DROP NOT NULL;
      ALTER TABLE audit_records
        ADD COLUMN actor_type text NOT NULL DEFAULT 'USER'
          CHECK (actor_type IN ('USER', 'SYSTEM'));
      ALTER TABLE audit_records
        ADD CONSTRAINT audit_records_actor_consistent
          CHECK ((actor_type = 'SYSTEM') = (actor_id IS NULL));
      ALTER TABLE audit_records DROP CONSTRAINT audit_records_action_check;
      ALTER TABLE audit_records
        ADD CONSTRAINT audit_records_action_check
          CHECK (action IN ('SUSPEND', 'REACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'ADMIN_BOOTSTRAP'));

      -- Bootstrap admins created before this migration get the row the seed now writes, dated
      -- when the account was created. An INSERT, which the append-only trigger allows.
      INSERT INTO audit_records
        (id, actor_id, actor_type, target_user_id, action, reason, occurred_at, correlation_id)
      SELECT gen_random_uuid(), NULL, 'SYSTEM', id, 'ADMIN_BOOTSTRAP',
             'Bootstrap administrator from deployment configuration (ADMIN_SEED_EMAILS); '
               || 'recorded by migration 004',
             created_at, 'migration-004'
      FROM users WHERE is_seeded_admin;
    `,
  },
  {
    id: '005_outbox_catalogue_events',
    sql: `
      -- USR-07 renamed this service's events to the shared catalogue's routing
      -- keys and added the timestamps its payload schemas require. Rows written
      -- before that and not yet published would be dead-lettered by every
      -- consumer, so rewrite them in place. Timestamps are ISO 8601 in UTC, as
      -- the schemas expect; published rows are history and left alone.
      UPDATE outbox_events o
         SET event_type = 'user.activated',
             payload = jsonb_build_object(
               'activatedAt',
               to_char(
                 coalesce((SELECT u.activated_at FROM users u WHERE u.id = o.aggregate_id),
                          o.occurred_at) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             ) || o.payload
       WHERE o.event_type = 'UserActivated' AND o.published_at IS NULL;

      UPDATE outbox_events
         SET event_type = CASE event_type
                            WHEN 'UserSuspended' THEN 'user.suspended'
                            ELSE 'user.reactivated'
                          END,
             payload = jsonb_build_object(
               'occurredAt',
               to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             ) || payload
       WHERE event_type IN ('UserSuspended', 'UserReactivated') AND published_at IS NULL;
    `,
  },
];
