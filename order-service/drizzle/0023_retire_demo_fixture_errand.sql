-- 0000 seeds a demonstration errand straight into OPEN, with no reservation behind it in Credit.
-- An hour later the sweep expires it into RELEASE_PENDING_CREDIT, Credit has nothing to release,
-- and reconciliation raises the same contradiction every run, burying real ones on the admin
-- panel. Where that has happened, the errand is closed as REJECTED and the decisions and alerts
-- about it are removed, lifting the append-only guards for those rows only. A database where it is
-- still OPEN (a fresh stack, the tests) is left alone.
DO $$
DECLARE
  fixture CONSTANT uuid := '00000000-0000-4000-8000-000000000129';
  next_version integer;
BEGIN
  SELECT version + 1 INTO next_version
    FROM orders
   WHERE order_id = fixture AND status = 'RELEASE_PENDING_CREDIT' AND requester_id = 'seed-requester'
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE orders
     SET status = 'REJECTED',
         rejection_reason = 'Demonstration errand from the first migration; Credit never held its reward.',
         version = next_version,
         updated_at = now()
   WHERE order_id = fixture;

  INSERT INTO order_status_history
    (history_id, order_id, previous_status, new_status, action, actor_type, actor_id, reason, order_version)
  VALUES
    (gen_random_uuid(), fixture, 'RELEASE_PENDING_CREDIT', 'REJECTED', 'FIXTURE_RETIRED', 'SYSTEM',
     'migration-0023', 'Demonstration errand retired: Credit never reserved it, so there was nothing to release.',
     next_version);

  ALTER TABLE order_reconciliation_attempts DISABLE TRIGGER order_reconciliation_attempts_append_only;
  DELETE FROM order_reconciliation_attempts WHERE order_id = fixture;
  ALTER TABLE order_reconciliation_attempts ENABLE TRIGGER order_reconciliation_attempts_append_only;

  ALTER TABLE order_operator_alerts DISABLE TRIGGER order_operator_alerts_append_only;
  DELETE FROM order_operator_alerts WHERE order_id = fixture;
  ALTER TABLE order_operator_alerts ENABLE TRIGGER order_operator_alerts_append_only;
END
$$;
