ALTER TABLE "order_operator_alerts" DROP CONSTRAINT "order_operator_alerts_kind_enum";--> statement-breakpoint
ALTER TABLE "order_receipts" ALTER COLUMN "delivered_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "order_operator_alerts" ADD CONSTRAINT "order_operator_alerts_kind_enum" CHECK ("order_operator_alerts"."kind" IN ('CREDIT_WAIT_EXCEEDED', 'CREDIT_STATE_CONFLICT', 'REFERRAL_UNASSIGNED'));