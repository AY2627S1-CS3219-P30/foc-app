CREATE TABLE "admin_channel_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"correlation_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_channel_reads_resource_enum" CHECK ("admin_channel_reads"."resource" IN ('CHANNEL', 'MESSAGES'))
);
--> statement-breakpoint
CREATE INDEX "admin_channel_reads_admin_idx" ON "admin_channel_reads" USING btree ("admin_user_id","read_at");--> statement-breakpoint
CREATE INDEX "admin_channel_reads_order_idx" ON "admin_channel_reads" USING btree ("order_id","read_at");--> statement-breakpoint
CREATE INDEX "messages_sender_sent_idx" ON "messages" USING btree ("sender_id","sent_at");