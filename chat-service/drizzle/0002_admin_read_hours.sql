-- Edited from the generated migration: rows recorded under 0001 are given their hour and folded
-- into one per admin, errand, resource and hour before the unique index is built.
ALTER TABLE "admin_channel_reads" ADD COLUMN "read_hour" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_channel_reads" ADD COLUMN "read_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_channel_reads" ADD COLUMN "last_read_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "admin_channel_reads" SET "read_hour" = date_trunc('hour', "read_at", 'UTC'), "last_read_at" = "read_at";--> statement-breakpoint
WITH "hours" AS (
	SELECT "id",
		row_number() OVER ("hour" ORDER BY "read_at", "id") AS "n",
		count(*) OVER "hour" AS "reads",
		max("read_at") OVER "hour" AS "last"
	FROM "admin_channel_reads"
	WINDOW "hour" AS (PARTITION BY "admin_user_id", "order_id", "resource", "read_hour")
)
UPDATE "admin_channel_reads" SET "read_count" = "hours"."reads", "last_read_at" = "hours"."last"
FROM "hours" WHERE "admin_channel_reads"."id" = "hours"."id" AND "hours"."n" = 1;--> statement-breakpoint
DELETE FROM "admin_channel_reads" AS "later" USING "admin_channel_reads" AS "first"
WHERE "later"."admin_user_id" = "first"."admin_user_id" AND "later"."order_id" = "first"."order_id"
	AND "later"."resource" = "first"."resource" AND "later"."read_hour" = "first"."read_hour"
	AND ("first"."read_at", "first"."id") < ("later"."read_at", "later"."id");--> statement-breakpoint
ALTER TABLE "admin_channel_reads" ALTER COLUMN "read_hour" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_channel_reads_hour_key" ON "admin_channel_reads" USING btree ("admin_user_id","order_id","resource","read_hour");
