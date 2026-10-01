-- Financial history and security audit records are append-only. Corrections are
-- compensating transactions/alerts, never edits that erase what happened.
CREATE OR REPLACE FUNCTION reject_credit_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_transactions_append_only
BEFORE UPDATE OR DELETE ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION reject_credit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_credit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_audit_alerts_append_only
BEFORE UPDATE OR DELETE ON credit_audit_alerts
FOR EACH ROW EXECUTE FUNCTION reject_credit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER admin_wallet_reads_append_only
BEFORE UPDATE OR DELETE ON admin_wallet_reads
FOR EACH ROW EXECUTE FUNCTION reject_credit_history_mutation();
