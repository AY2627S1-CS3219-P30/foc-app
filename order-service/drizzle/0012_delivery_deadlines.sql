ALTER TABLE "orders" ADD COLUMN "non_delivery_report_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "auto_confirm_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_auto_confirm_idx" ON "orders" USING btree ("auto_confirm_at") WHERE "orders"."status" = 'DELIVERED';