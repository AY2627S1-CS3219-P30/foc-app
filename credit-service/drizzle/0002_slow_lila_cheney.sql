ALTER TABLE "credit_operations" ADD COLUMN "courier_id" text;--> statement-breakpoint
ALTER TABLE "credit_operations" ADD COLUMN "result_payload" jsonb;--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_courier_id_wallets_user_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."wallets"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_operations_terminal_order_key" ON "credit_operations" USING btree ("order_id") WHERE "credit_operations"."operation_type" IN ('RELEASE', 'TRANSFER');--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_party_shape" CHECK (("credit_operations"."operation_type" = 'TRANSFER' AND "credit_operations"."courier_id" IS NOT NULL)
          OR ("credit_operations"."operation_type" <> 'TRANSFER' AND "credit_operations"."courier_id" IS NULL));