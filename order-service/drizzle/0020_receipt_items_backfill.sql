-- Receipts written before they listed items take them from their errand, whose items never change
-- once posted. Receipts are append-only, so the guard is lifted for this one backfill only.
ALTER TABLE "order_receipts" DISABLE TRIGGER "order_receipts_append_only";--> statement-breakpoint
UPDATE "order_receipts" r
   SET "items" = o."items"
  FROM "orders" o
 WHERE o."order_id" = r."order_id"
   AND r."items" IS NULL;--> statement-breakpoint
ALTER TABLE "order_receipts" ENABLE TRIGGER "order_receipts_append_only";
