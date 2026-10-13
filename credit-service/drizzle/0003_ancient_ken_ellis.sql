CREATE UNIQUE INDEX "credit_transactions_terminal_order_key" ON "credit_transactions" USING btree ("order_id") WHERE "credit_transactions"."order_id" IS NOT NULL AND "credit_transactions"."transaction_type" IN ('RELEASE', 'TRANSFER');
--> statement-breakpoint
-- Once a command has a recorded outcome, replays must reproduce that exact
-- result. Only the initial PENDING -> terminal update is mutable.
CREATE OR REPLACE FUNCTION reject_finalized_credit_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.outcome <> 'PENDING' THEN
    RAISE EXCEPTION 'finalized credit operation is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_operations_finalized_immutable
BEFORE UPDATE OR DELETE ON credit_operations
FOR EACH ROW EXECUTE FUNCTION reject_finalized_credit_operation_mutation();
