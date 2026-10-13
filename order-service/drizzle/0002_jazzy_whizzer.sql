ALTER TABLE "orders" ADD COLUMN "referred_admin_id" text;--> statement-breakpoint
CREATE INDEX "orders_referred_admin_created_idx" ON "orders" USING btree ("referred_admin_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_open_deadline_idx" ON "orders" USING btree ("acceptance_deadline_at","created_at") WHERE "orders"."status" = 'OPEN';