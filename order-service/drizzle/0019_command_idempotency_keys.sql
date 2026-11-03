CREATE TABLE "order_command_idempotency_keys" (
	"caller_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_command_idempotency_keys_caller_id_idempotency_key_pk" PRIMARY KEY("caller_id","idempotency_key")
);
