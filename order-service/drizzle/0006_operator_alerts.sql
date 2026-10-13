CREATE TABLE "order_operator_alerts" (
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb NOT NULL,
	CONSTRAINT "order_operator_alerts_order_id_kind_pk" PRIMARY KEY("order_id","kind"),
	CONSTRAINT "order_operator_alerts_kind_enum" CHECK ("order_operator_alerts"."kind" IN ('CREDIT_WAIT_EXCEEDED'))
);
--> statement-breakpoint
ALTER TABLE "order_operator_alerts" ADD CONSTRAINT "order_operator_alerts_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_operator_alerts_raised_idx" ON "order_operator_alerts" USING btree ("raised_at");