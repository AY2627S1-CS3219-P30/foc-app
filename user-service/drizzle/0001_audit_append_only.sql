-- Custom migration: make `audit_records` append-only. These objects — a plpgsql
-- function, a trigger, and a REVOKE — have no representation in the Drizzle
-- schema DSL, so `drizzle-kit generate` cannot emit them; they are written here
-- by hand and applied by the Drizzle migrator like any other migration.
--
-- Enforced twice: the service role loses UPDATE/DELETE/TRUNCATE on the table,
-- and the trigger rejects any UPDATE or DELETE regardless of who runs it.
CREATE FUNCTION audit_records_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_records is append-only' USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_records_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION audit_records_immutable();
--> statement-breakpoint
DO $do$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_records FROM %I', current_user);
END
$do$;
