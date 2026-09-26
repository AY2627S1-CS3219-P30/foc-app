/**
 * Forward-only migrations, applied in order at boot and never edited once
 * merged: a change is a new entry. Kept as TypeScript strings rather than .sql
 * files so `tsc` carries them into `dist/` with no copy step.
 *
 * Schema rationale: docs/user-service/schema.md.
 */
export interface Migration {
  id: string;
  sql: string;
}

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
];
