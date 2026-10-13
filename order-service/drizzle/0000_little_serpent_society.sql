CREATE TABLE "order_idempotency_keys" (
	"requester_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_idempotency_keys_requester_id_idempotency_key_pk" PRIMARY KEY("requester_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"history_id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"previous_status" text,
	"new_status" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"order_version" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_history_previous_status_enum" CHECK ("order_status_history"."previous_status" IS NULL OR "order_status_history"."previous_status" IN ('PENDING_CREDIT', 'OPEN', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETION_PENDING_CREDIT', 'RELEASE_PENDING_CREDIT', 'REJECTED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "order_history_new_status_enum" CHECK ("order_status_history"."new_status" IN ('PENDING_CREDIT', 'OPEN', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETION_PENDING_CREDIT', 'RELEASE_PENDING_CREDIT', 'REJECTED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "order_history_actor_type_enum" CHECK ("order_status_history"."actor_type" IN ('REQUESTER', 'COURIER', 'STUDENT', 'ADMIN', 'CREDIT_SERVICE', 'SYSTEM'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"courier_id" text,
	"supplier_snapshot" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"delivery_zone" text NOT NULL,
	"delivery_instructions" text NOT NULL,
	"reward" integer NOT NULL,
	"status" text NOT NULL,
	"release_reason" text,
	"rejection_reason" text,
	"available_at_rejection" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"acceptance_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_status_enum" CHECK ("orders"."status" IN ('PENDING_CREDIT', 'OPEN', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETION_PENDING_CREDIT', 'RELEASE_PENDING_CREDIT', 'REJECTED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "orders_reward_range" CHECK ("orders"."reward" BETWEEN 1 AND 5),
	CONSTRAINT "orders_version_positive" CHECK ("orders"."version" >= 1),
	CONSTRAINT "orders_items_array" CHECK (jsonb_typeof("orders"."items") = 'array' AND jsonb_array_length("orders"."items") > 0),
	CONSTRAINT "orders_supplier_object" CHECK (jsonb_typeof("orders"."supplier_snapshot") = 'object'),
	CONSTRAINT "orders_delivery_zone_len" CHECK (char_length("orders"."delivery_zone") BETWEEN 1 AND 200),
	CONSTRAINT "orders_delivery_instructions_len" CHECK (char_length("orders"."delivery_instructions") BETWEEN 1 AND 1000),
	CONSTRAINT "orders_courier_shape" CHECK ("orders"."status" NOT IN ('ACCEPTED', 'PICKED_UP', 'DELIVERED', 'DISPUTED', 'COMPLETION_PENDING_CREDIT', 'COMPLETED') OR "orders"."courier_id" IS NOT NULL),
	CONSTRAINT "orders_release_reason_shape" CHECK ("orders"."release_reason" IS NULL OR "orders"."release_reason" IN ('CANCELLED', 'EXPIRED')),
	CONSTRAINT "orders_rejection_shape" CHECK (("orders"."status" = 'REJECTED') = ("orders"."rejection_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "order_idempotency_keys" ADD CONSTRAINT "order_idempotency_keys_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_history_order_version_key" ON "order_status_history" USING btree ("order_id","order_version");--> statement-breakpoint
CREATE INDEX "order_history_order_time_idx" ON "order_status_history" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_requester_created_idx" ON "orders" USING btree ("requester_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_courier_created_idx" ON "orders" USING btree ("courier_id","created_at");
--> statement-breakpoint
INSERT INTO "orders" (
	"order_id", "requester_id", "supplier_snapshot", "items", "delivery_zone",
	"delivery_instructions", "reward", "status", "version", "acceptance_deadline_at"
) VALUES (
	'00000000-0000-4000-8000-000000000129',
	'seed-requester',
	'{"supplierId":"00000000-0000-4000-8000-000000000125","name":"The Deck","type":"FOOD","building":"COM2","floor":"1","locationDescription":"Level 1 canteen"}'::jsonb,
	'[{"name":"Chicken rice","quantity":1}]'::jsonb,
	'COM2 Lobby',
	'Meet beside the security desk',
	2,
	'OPEN',
	2,
	now() + interval '60 minutes'
);
--> statement-breakpoint
INSERT INTO "order_status_history" (
	"history_id", "order_id", "previous_status", "new_status", "action",
	"actor_type", "actor_id", "order_version"
) VALUES (
	'00000000-0000-4000-8000-000000000127',
	'00000000-0000-4000-8000-000000000129',
	NULL,
	'PENDING_CREDIT',
	'CREATE',
	'REQUESTER',
	'seed-requester',
	1
), (
	'00000000-0000-4000-8000-000000000128',
	'00000000-0000-4000-8000-000000000129',
	'PENDING_CREDIT',
	'OPEN',
	'CREDIT_RESERVED',
	'CREDIT_SERVICE',
	'credit-service',
	2
);
