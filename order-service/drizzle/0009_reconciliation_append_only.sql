-- Reconciliation attempts are an audit record of every repair decision; never edited or erased.
CREATE TRIGGER order_reconciliation_attempts_append_only
BEFORE UPDATE OR DELETE ON order_reconciliation_attempts
FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
