CREATE TABLE "admin_activity_alerts" (
	"alert_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"details" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_activity_alerts_kind_enum" CHECK ("admin_activity_alerts"."kind" IN ('BULK_WALLET_READS'))
);
--> statement-breakpoint
CREATE INDEX "admin_activity_alerts_actor_idx" ON "admin_activity_alerts" USING btree ("actor_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "admin_wallet_reads_admin_idx" ON "admin_wallet_reads" USING btree ("admin_user_id","occurred_at");