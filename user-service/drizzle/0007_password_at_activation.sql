-- #309: the password is chosen at activation, once the inbox is proven, not at registration.
-- An account waiting for activation has no password until its owner chooses one.
--
-- Rollback-safe (docs/runbooks/backup-restore-rollback.md): images from before #309 must keep working
-- on this schema. So there is no CHECK tying a NULL hash to PENDING_ACTIVATION yet: an older image
-- activates without setting a password, and the CHECK would refuse that. The service enforces the
-- rule; a later release adds the CHECK once the rollback window has passed. Pending accounts keep any
-- password they were registered with: activation now always replaces it, and a pending account
-- cannot sign in, so it can never become the account's password.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
-- Hand-written: whoever holds an activation link now chooses the password, so a link issued under the
-- old 24-hour lifetime is cut to the new 30 minutes from now. A used link is left as it was.
UPDATE "activation_tokens" SET "expires_at" = LEAST("expires_at", now() + interval '30 minutes') WHERE "consumed_at" IS NULL;
