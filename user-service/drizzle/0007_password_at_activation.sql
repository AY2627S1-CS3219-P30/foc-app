-- #309: the password is chosen at activation, once the inbox is proven, not at registration.
-- An account waiting for activation has no password; any other account must have one.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
-- Hand-written: a password set at registration was chosen before anyone proved the inbox, so it may
-- be someone else's. Removed from every pending account; its owner chooses one when activating.
UPDATE "users" SET "password_hash" = NULL, "updated_at" = now() WHERE "status" = 'PENDING_ACTIVATION';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_password_unless_pending" CHECK ("users"."password_hash" IS NOT NULL OR "users"."status" = 'PENDING_ACTIVATION');
