ALTER TABLE "orders" ADD COLUMN "release_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_accepted_at_idx" ON "orders" USING btree ("accepted_at") WHERE "orders"."status" = 'ACCEPTED';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_released_shape" CHECK ("orders"."status" NOT IN ('CANCELLED', 'EXPIRED') OR ("orders"."released_at" IS NOT NULL AND "orders"."credit_transaction_id" IS NOT NULL AND "orders"."release_reason" IS NOT NULL));