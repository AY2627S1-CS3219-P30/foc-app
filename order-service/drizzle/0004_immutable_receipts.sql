-- Rows that were accepted before accepted_at existed take it from their status history,
-- so the pickup timer and receipts have a start time for every assigned order.
UPDATE orders o
   SET accepted_at = h.occurred_at
  FROM (
    SELECT order_id, max(occurred_at) AS occurred_at
      FROM order_status_history
     WHERE new_status = 'ACCEPTED'
     GROUP BY order_id
  ) h
 WHERE o.order_id = h.order_id
   AND o.accepted_at IS NULL
   AND o.courier_id IS NOT NULL;
--> statement-breakpoint
-- Status history (OS-FR7.1.2) and completion receipts (OS-FR5.1.2) are append-only:
-- what happened to an errand is never edited or erased.
CREATE OR REPLACE FUNCTION reject_order_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_status_history_append_only
BEFORE UPDATE OR DELETE ON order_status_history
FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
--> statement-breakpoint
CREATE TRIGGER order_receipts_append_only
BEFORE UPDATE OR DELETE ON order_receipts
FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
