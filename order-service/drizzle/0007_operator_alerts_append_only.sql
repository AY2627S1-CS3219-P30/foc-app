-- Operator alerts are a record of what the service surfaced and when; never edited or erased.
CREATE TRIGGER order_operator_alerts_append_only
BEFORE UPDATE OR DELETE ON order_operator_alerts
FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
