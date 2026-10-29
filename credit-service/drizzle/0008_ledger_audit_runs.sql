CREATE TABLE "ledger_audit_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"requested_by" text,
	"scheduled_day" text,
	"status" text NOT NULL,
	"mismatch_count" integer,
	"results" jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_audit_origin_enum" CHECK ("ledger_audit_runs"."origin" IN ('SCHEDULED', 'MANUAL', 'CLI')),
	CONSTRAINT "ledger_audit_status_enum" CHECK ("ledger_audit_runs"."status" IN ('PASS', 'MISMATCH', 'ERROR')),
	CONSTRAINT "ledger_audit_result_consistent" CHECK (("ledger_audit_runs"."status" = 'PASS' AND "ledger_audit_runs"."mismatch_count" IS NOT NULL AND "ledger_audit_runs"."mismatch_count" = 0) OR ("ledger_audit_runs"."status" = 'MISMATCH' AND "ledger_audit_runs"."mismatch_count" IS NOT NULL AND "ledger_audit_runs"."mismatch_count" > 0) OR ("ledger_audit_runs"."status" = 'ERROR' AND "ledger_audit_runs"."mismatch_count" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_audit_scheduled_day_key" ON "ledger_audit_runs" USING btree ("scheduled_day");--> statement-breakpoint
CREATE INDEX "ledger_audit_completed_idx" ON "ledger_audit_runs" USING btree ("completed_at","run_id");
--> statement-breakpoint
CREATE TRIGGER ledger_audit_runs_append_only
BEFORE UPDATE OR DELETE ON ledger_audit_runs
FOR EACH ROW EXECUTE FUNCTION reject_credit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_audit_runs_no_truncate
BEFORE TRUNCATE ON ledger_audit_runs
FOR EACH STATEMENT EXECUTE FUNCTION reject_credit_history_mutation();
