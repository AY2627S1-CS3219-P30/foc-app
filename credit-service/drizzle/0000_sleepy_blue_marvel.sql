CREATE TABLE "admin_wallet_reads" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"resource" text NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_wallet_reads_resource_enum" CHECK ("admin_wallet_reads"."resource" IN ('WALLET', 'LEDGER'))
);
--> statement-breakpoint
CREATE TABLE "credit_audit_alerts" (
	"alert_id" uuid PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"operation_type" text NOT NULL,
	"code" text NOT NULL,
	"details" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_operations" (
	"order_id" text NOT NULL,
	"operation_type" text NOT NULL,
	"requester_id" text NOT NULL,
	"amount" integer NOT NULL,
	"outcome" text NOT NULL,
	"rejection_reason" text,
	"available_at_decision" integer,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_operations_order_id_operation_type_pk" PRIMARY KEY("order_id","operation_type"),
	CONSTRAINT "credit_operations_type_enum" CHECK ("credit_operations"."operation_type" IN ('RESERVE', 'RELEASE', 'TRANSFER')),
	CONSTRAINT "credit_operations_amount_positive" CHECK ("credit_operations"."amount" > 0),
	CONSTRAINT "credit_operations_outcome_enum" CHECK ("credit_operations"."outcome" IN ('PENDING', 'SUCCEEDED', 'REJECTED')),
	CONSTRAINT "credit_operations_rejection_reason_enum" CHECK ("credit_operations"."rejection_reason" IS NULL OR "credit_operations"."rejection_reason" IN ('INSUFFICIENT_CREDITS', 'AMOUNT_OUT_OF_RANGE')),
	CONSTRAINT "credit_operations_outcome_shape" CHECK (("credit_operations"."outcome" = 'PENDING' AND "credit_operations"."transaction_id" IS NULL AND "credit_operations"."rejection_reason" IS NULL)
          OR ("credit_operations"."outcome" = 'SUCCEEDED' AND "credit_operations"."transaction_id" IS NOT NULL AND "credit_operations"."rejection_reason" IS NULL)
          OR ("credit_operations"."outcome" = 'REJECTED' AND "credit_operations"."transaction_id" IS NULL AND "credit_operations"."rejection_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"order_id" text,
	"transaction_type" text NOT NULL,
	"wallet_user_id" text,
	"amount" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_type_enum" CHECK ("credit_transactions"."transaction_type" IN ('ISSUE', 'RESERVE', 'RELEASE', 'TRANSFER')),
	CONSTRAINT "credit_transactions_amount_positive" CHECK ("credit_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"entry_no" integer NOT NULL,
	"wallet_user_id" text,
	"account" text NOT NULL,
	"direction" text NOT NULL,
	"amount" integer NOT NULL,
	"resulting_available" integer,
	"resulting_reserved" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_account_enum" CHECK ("ledger_entries"."account" IN ('PLATFORM_ISSUANCE', 'AVAILABLE', 'RESERVED')),
	CONSTRAINT "ledger_entries_direction_enum" CHECK ("ledger_entries"."direction" IN ('DEBIT', 'CREDIT')),
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount" > 0),
	CONSTRAINT "ledger_entries_result_pair" CHECK (("ledger_entries"."resulting_available" IS NULL) = ("ledger_entries"."resulting_reserved" IS NULL)),
	CONSTRAINT "ledger_entries_wallet_result" CHECK (("ledger_entries"."wallet_user_id" IS NULL) = ("ledger_entries"."resulting_available" IS NULL)),
	CONSTRAINT "ledger_entries_result_nonnegative" CHECK ("ledger_entries"."resulting_available" IS NULL OR ("ledger_entries"."resulting_available" >= 0 AND "ledger_entries"."resulting_reserved" >= 0))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_available_nonnegative" CHECK ("wallets"."available" >= 0),
	CONSTRAINT "wallets_reserved_nonnegative" CHECK ("wallets"."reserved" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_operations" ADD CONSTRAINT "credit_operations_transaction_id_credit_transactions_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."credit_transactions"("transaction_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_wallet_user_id_wallets_user_id_fk" FOREIGN KEY ("wallet_user_id") REFERENCES "public"."wallets"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_credit_transactions_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."credit_transactions"("transaction_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_user_id_wallets_user_id_fk" FOREIGN KEY ("wallet_user_id") REFERENCES "public"."wallets"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_wallet_reads_target_idx" ON "admin_wallet_reads" USING btree ("target_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "credit_audit_alerts_order_idx" ON "credit_audit_alerts" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_order_type_key" ON "credit_transactions" USING btree ("order_id","transaction_type") WHERE "credit_transactions"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_issue_wallet_key" ON "credit_transactions" USING btree ("wallet_user_id","transaction_type") WHERE "credit_transactions"."transaction_type" = 'ISSUE';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_transaction_entry_key" ON "ledger_entries" USING btree ("transaction_id","entry_no");--> statement-breakpoint
CREATE INDEX "ledger_entries_wallet_history_idx" ON "ledger_entries" USING btree ("wallet_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("seq") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_aggregate_idx" ON "outbox_events" USING btree ("aggregate_id","seq") WHERE "outbox_events"."published_at" IS NULL;