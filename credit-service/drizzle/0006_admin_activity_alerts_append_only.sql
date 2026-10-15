-- Custom migration (ADM-04): an alert about an administrator is never edited or deleted, like the
-- wallet reads it is raised from (0001).
CREATE TRIGGER admin_activity_alerts_append_only
BEFORE UPDATE OR DELETE ON admin_activity_alerts
FOR EACH ROW EXECUTE FUNCTION reject_credit_history_mutation();
