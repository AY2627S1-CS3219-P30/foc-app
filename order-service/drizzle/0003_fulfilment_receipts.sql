CREATE TABLE "order_receipts" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"courier_id" text NOT NULL,
	"supplier_snapshot" jsonb NOT NULL,
	"reward" integer NOT NULL,
	"credit_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"picked_up_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"completion_requested_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_receipts_credit_transaction_id_unique" UNIQUE("credit_transaction_id"),
	CONSTRAINT "order_receipts_reward_range" CHECK ("order_receipts"."reward" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "picked_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "completion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "credit_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "order_receipts" ADD CONSTRAINT "order_receipts_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_completed_shape" CHECK ("orders"."status" <> 'COMPLETED' OR ("orders"."completed_at" IS NOT NULL AND "orders"."credit_transaction_id" IS NOT NULL));