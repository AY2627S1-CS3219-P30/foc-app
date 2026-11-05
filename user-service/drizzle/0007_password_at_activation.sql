-- #309: the password is chosen at activation, once the inbox is proven, not at registration.
-- An account waiting for activation has no password; any other account must have one.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
-- Hand-written: a password set at registration was chosen before anyone proved the inbox, so it may
-- be someone else's. Removed from every pending account; its owner chooses one when activating.
UPDATE "users" SET "password_hash" = NULL, "updated_at" = now() WHERE "status" = 'PENDING_ACTIVATION';--> statement-breakpoint
-- Hand-written: whoever holds an activation link now chooses the password, so a link issued under the
-- old 24-hour lifetime is cut to the new 30 minutes from now. A used link is left as it was.
UPDATE "activation_tokens" SET "expires_at" = LEAST("expires_at", now() + interval '30 minutes') WHERE "consumed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_password_unless_pending" CHECK ("users"."password_hash" IS NOT NULL OR "users"."status" = 'PENDING_ACTIVATION');
