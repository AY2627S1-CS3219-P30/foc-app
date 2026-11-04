CREATE TABLE "order_command_idempotency_keys" (
	"caller_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_command_idempotency_keys_caller_id_idempotency_key_pk" PRIMARY KEY("caller_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "order_command_idempotency_keys" ADD CONSTRAINT "order_command_idempotency_keys_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE restrict ON UPDATE no action;