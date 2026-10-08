CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"details" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_alerts_kind_enum" CHECK ("admin_alerts"."kind" IN ('ROLE_CHANGE', 'ADMIN_SUSPENDED', 'BULK_SUSPENSIONS', 'SUSPENSION_LIMIT_REACHED', 'BULK_READS'))
);
--> statement-breakpoint
CREATE TABLE "admin_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"correlation_id" text NOT NULL,
	CONSTRAINT "role_change_requests_role_enum" CHECK ("role_change_requests"."role" IN ('STUDENT', 'ADMIN')),
	CONSTRAINT "role_change_requests_status_enum" CHECK ("role_change_requests"."status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
	CONSTRAINT "role_change_requests_reason_len" CHECK (char_length("role_change_requests"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "role_change_requests_decided_consistent" CHECK (("role_change_requests"."status" IN ('APPROVED', 'REJECTED')) = ("role_change_requests"."decided_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_records" DROP CONSTRAINT "audit_records_action_check";--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD COLUMN "stepped_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reads" ADD CONSTRAINT "admin_reads_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reads" ADD CONSTRAINT "admin_reads_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_alerts_occurred_idx" ON "admin_alerts" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "admin_alerts_actor_kind_idx" ON "admin_alerts" USING btree ("actor_id","kind","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "admin_reads_actor_idx" ON "admin_reads" USING btree ("actor_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "admin_reads_target_idx" ON "admin_reads" USING btree ("target_user_id","occurred_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "role_change_requests_one_pending_per_target" ON "role_change_requests" USING btree ("target_user_id") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "role_change_requests_created_idx" ON "role_change_requests" USING btree ("created_at" DESC);--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_action_check" CHECK ("audit_records"."action" IN ('SUSPEND', 'REACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'ADMIN_BOOTSTRAP', 'ROLE_CHANGE_REQUESTED', 'ROLE_CHANGE_REJECTED'));