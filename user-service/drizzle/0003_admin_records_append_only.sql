-- Custom migration: make the record of what administrators do (ADR 0008) append-only, like
-- `audit_records` (0001). `admin_reads` says which admin opened which account, `admin_alerts` what
-- looked unusual; a record of the admins that could be edited afterwards would prove nothing.
--
-- `role_change_requests` is not included: deciding a request updates its row. Its history is still
-- append-only, because the request and every decision also write an `audit_records` row.
--
-- Enforced twice, as for the audit trail: the service role loses UPDATE/DELETE/TRUNCATE on both
-- tables, and the trigger rejects any UPDATE or DELETE regardless of who runs it.
CREATE FUNCTION admin_records_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER admin_reads_no_update_delete
  BEFORE UPDATE OR DELETE ON admin_reads
  FOR EACH ROW EXECUTE FUNCTION admin_records_immutable();
--> statement-breakpoint
CREATE TRIGGER admin_alerts_no_update_delete
  BEFORE UPDATE OR DELETE ON admin_alerts
  FOR EACH ROW EXECUTE FUNCTION admin_records_immutable();
--> statement-breakpoint
DO $do$
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON admin_reads, admin_alerts FROM %I', current_user);
END
$do$;
