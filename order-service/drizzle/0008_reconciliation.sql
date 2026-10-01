CREATE TABLE "order_reconciliation_attempts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_status" text NOT NULL,
	"order_version" integer NOT NULL,
	"credit_status" text,
	"credit_detail" text,
	"action" text NOT NULL,
	"reissued_event_id" uuid,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_reconciliation_action_enum" CHECK ("order_reconciliation_attempts"."action" IN ('REISSUED', 'ALERTED', 'CREDIT_UNAVAILABLE')),
	CONSTRAINT "order_reconciliation_reissue_shape" CHECK (("order_reconciliation_attempts"."action" = 'REISSUED') = ("order_reconciliation_attempts"."reissued_event_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "order_operator_alerts" DROP CONSTRAINT "order_operator_alerts_kind_enum";--> statement-breakpoint
ALTER TABLE "order_reconciliation_attempts" ADD CONSTRAINT "order_reconciliation_attempts_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_reconciliation_order_time_idx" ON "order_reconciliation_attempts" USING btree ("order_id","attempted_at");--> statement-breakpoint
CREATE INDEX "order_reconciliation_time_idx" ON "order_reconciliation_attempts" USING btree ("attempted_at");--> statement-breakpoint
ALTER TABLE "order_operator_alerts" ADD CONSTRAINT "order_operator_alerts_kind_enum" CHECK ("order_operator_alerts"."kind" IN ('CREDIT_WAIT_EXCEEDED', 'CREDIT_STATE_CONFLICT'));