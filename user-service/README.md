# User Service

## Running this service

Owned by **Anselm**. Implements identity, authentication, RBAC, and account status.

### Prerequisites

Node 22.12 or later (`nvm use` picks it up from `.nvmrc`). Install dependencies
once from the repository root — this is an npm workspace, so a per-service
`npm install` is neither needed nor correct:

```bash
npm install
npm run build -w @foc/platform   # again after pulling a change to platform/
```

The service imports the compiled `@foc/platform`, so it cannot start until that is built.

### Commands

Run these from the repository root.

| Command                                   | What it does                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run db:migrate -w @foc/user-service` | Apply migrations to `DATABASE_URL`                                                                 |
| `npm run dev:user`                        | Start with reload on change                                                                        |
| `npm run build -w @foc/user-service`      | Compile TypeScript to `dist/`                                                                      |
| `npm test -w @foc/user-service`           | Run the PGlite tests and, with `TEST_POSTGRES_URL`, the real-PostgreSQL re-registration lock tests |
| `npm run typecheck -w @foc/user-service`  | Type-check without emitting                                                                        |
| `npm run lint`                            | Lint every service                                                                                 |

### Required environment

| Variable                                   | Example                                            | Notes                                                                                                   |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SERVICE_NAME`                             | `user-service`                                     | Tags every log line                                                                                     |
| `PORT`                                     | `3001`                                             | Bind port                                                                                               |
| `NODE_ENV`                                 | `development`                                      | `development` \| `test` \| `production`                                                                 |
| `LOG_LEVEL`                                | `info`                                             | Defaults to `info`                                                                                      |
| `DATABASE_URL`                             | `postgres://user_service:…@postgres:5432/foc_user` | Supplied by Compose                                                                                     |
| `ALLOWED_EMAIL_DOMAINS`                    | `u.nus.edu,nus.edu.sg`                             | Registration is limited to these domains                                                                |
| `INTERNAL_SERVICE_KEYS`                    | (16+ chars each)                                   | Keys other services send as `X-Service-Key` on `/internal/**`                                           |
| `ACTIVATION_TOKEN_TTL_MINUTES`             | `30`                                               | Optional; 5–1440. How long an activation link works (where the password is chosen)                      |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES`         | `30`                                               | Optional; 5–1440. How long a password reset link works                                                  |
| `SMTP_HOST`                                | `mailpit`                                          | Where activation and reset email goes. Required in production                                           |
| `SMTP_PORT`                                | `1025`                                             | Defaults to `587`; `465` means implicit TLS                                                             |
| `SMTP_USER`, `SMTP_PASSWORD`               | (secret store)                                     | Optional, both or neither. Never committed                                                              |
| `SMTP_REQUIRE_TLS`                         | `false`                                            | Defaults to required in production; `false` only for Mailpit                                            |
| `MAIL_FROM`                                | `Friend on Campus <no-reply@foc.local>`            | Optional; the default is shown                                                                          |
| `ACTIVATION_URL`                           | `http://localhost:3000/activate`                   | The web app page the email links to. Required with SMTP. Reset links open its sibling, `reset-password` |
| `JWT_PRIVATE_KEY`                          | (generated into `.env`)                            | Signs access tokens; see "Signing key" below. Required in production                                    |
| `ADMIN_SEED_EMAILS`, `ADMIN_SEED_PASSWORD` | `admin@u.nus.edu`, (generated)                     | Optional, set together; the password is 12–128 characters. See "First admin" below                      |
| `LOGIN_LIMIT_PER_IP`                       | `50`                                               | Optional. Sign-ins per IP in 15 minutes                                                                 |
| `LOGIN_LIMIT_PER_EMAIL`                    | `10`                                               | Optional. Sign-ins per email in 15 minutes                                                              |
| `REGISTER_LIMIT_PER_IP`                    | `20`                                               | Optional. Registrations per IP in an hour. Production refuses any of these three above its default      |

Also from the shared base, all optional: `INTERNAL_PORT` (Compose: 4001; with it set, `/internal/**`
is served there only), `RABBITMQ_URL` (without it, events wait in the outbox), `CORS_ORIGINS`
(`http://localhost:3000` by default), `TRUSTED_PROXY` (Compose: `edge`; the per-address limits rely
on it) and `METRICS_TOKEN` (16+ characters).

**Mail.** Compose sends activation and password reset email to Mailpit, a local inbox at <http://localhost:8025>.
Without `SMTP_HOST`, outside production, each email is kept in memory where nobody receives it,
and a warning at boot says so. To send to the stack's inbox from `npm run dev:user`, start
`postgres mailpit` with `compose.dev.yaml` and set `SMTP_HOST`, `SMTP_PORT` and `ACTIVATION_URL`, as in
the example below. With `NODE_ENV=production` the service refuses to start without `SMTP_HOST`, and
requires TLS to it unless `SMTP_REQUIRE_TLS=false`, which it allows with a warning (Compose sets this
for Mailpit). No route returns a token.

Optional controls on administrators ([ADR 0008](../docs/adr/0008-controlling-administrators.md)), with
their defaults: `ROLE_REQUEST_TTL_HOURS=24` (1–168), `STEP_UP_WINDOW_SECONDS=300` (30–3600),
`ADMIN_SUSPENSIONS_ALERT_PER_HOUR=10`, `ADMIN_SUSPENSIONS_LIMIT_PER_HOUR=20`, `ADMIN_READS_ALERT_PER_HOUR=50`.

A missing required variable stops the service at boot and names the variable.
Nothing falls back to an insecure default.

To run it by hand, from the repository root. `npm run dev:user` runs in `user-service/`, so it never
reads the root `.env`: load it into the shell first. `.env` says `NODE_ENV=production`, which a
service run by hand should not use.

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres mailpit
set -a; . ./.env; NODE_ENV=development; set +a
DATABASE_URL=$HOST_USER_DATABASE_URL npm run db:migrate -w @foc/user-service
DATABASE_URL=$HOST_USER_DATABASE_URL SMTP_HOST=localhost SMTP_PORT=1025 \
  ACTIVATION_URL=http://localhost:3000/activate npm run dev:user
curl -i http://localhost:3001/health
```

Do not run the stack's own `user-service` at the same time: it holds port 3001. This recipe starts
only Postgres and Mailpit, so nothing else calls the service: try it at `http://localhost:3001`. It
runs without the broker, so its events wait in the outbox until it runs with `RABBITMQ_URL`.

### What you get from `@foc/platform`

Importing `PlatformModule.forRoot(...)` gives this service a `GET /health`
endpoint, Prometheus metrics at `GET /metrics` (behind `METRICS_TOKEN`), structured JSON logging
where every line carries a correlation ID, request logging, a shared error envelope, and graceful
shutdown on `SIGTERM`. Do not re-implement these per service — extend the shared package instead,
so a change lands once rather than five times.

### Docker

```bash
docker build -f user-service/Dockerfile -t foc/user-service .
```

The build context is the **repository root**, not this folder, because the image
needs the workspace manifests and `@foc/platform`. The image runs as a non-root
user and declares a `HEALTHCHECK`. `compose.yaml` runs it on port 3001, with `/internal/**` on the
internal port 4001 (not published), after the one-shot `user-service-migrate`.

### What is implemented (USR-01)

| Endpoint                              | Purpose                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                 | Normalise the email, enforce the domain allowlist, reject duplicates, email a one-time activation link. Takes no password (#309); 20 per IP an hour (`REGISTER_LIMIT_PER_IP`)                 |
| `POST /auth/activate`                 | Token and password: sets the password (Argon2id), activates, publishes exactly one `UserActivated`. Single-use, `ACTIVATION_TOKEN_TTL_MINUTES` (30 by default), replay-idempotent; no sign-in |
| `POST /auth/activation/resend`        | Mails a new link to a pending account and invalidates the old ones. Same `202` for any address; 3 per address and 20 per IP an hour                                                           |
| `POST /auth/password-reset`           | Mails a reset link to an active or pending account and invalidates the old ones. Same `202` for any address; its own 3 per address and 20 per IP an hour                                      |
| `POST /auth/password-reset/confirm`   | Sets the password from the link (12–128 characters, as at activation), activates a pending account, revokes every session, deletes the unused activation link. `204`; no sign-in              |
| `GET /internal/users/:id`             | Least-data identity lookup (`X-Service-Key` required)                                                                                                                                         |
| `GET /internal/users/:id/permissions` | Effective permissions for admin authorisation (`X-Service-Key` required)                                                                                                                      |
| `GET /internal/introspect`            | Session liveness plus identity, for `@foc/auth-client` (`X-Service-Key` required)                                                                                                             |
| `GET /internal/admins`                | Active administrators, for dispute referral (`X-Service-Key` required)                                                                                                                        |

With `INTERNAL_PORT` set, the `/internal/**` routes answer only there; on the public port they are
`404`.

The contract is `contracts/user-service.openapi.yaml`; role and schema design are in
`docs/user-service/`, and every decision with its trade-offs is in `docs/user-service/decisions.md`. Migrations are forward-only, live in `drizzle/`, and are applied by `npm run db:migrate -w @foc/user-service` before the service starts; the service never migrates at boot.

**Tests run on PGlite** (PostgreSQL compiled to WASM), so `npm test -w @foc/user-service` needs no
database server or Docker. Runtime uses `pg` against the Compose Postgres. The re-registration lock
tests in `test/re-register.postgres.test.ts` need real PostgreSQL and are skipped without
`TEST_POSTGRES_URL`: `TEST_POSTGRES_URL=$HOST_POSTGRES_URL npm test -w @foc/user-service` runs them,
with postgres up and `.env` loaded as in the by-hand recipe; without `.env`, the variable is empty
and they skip as if they passed (see [docs/testing.md](../docs/testing.md)).

**The password is chosen at activation (#309).** Registration takes none: whoever signs up has not
proven the inbox, so a password chosen then could be someone else's. A pending account has no
password (`password_hash` is NULL: migration 0007 only drops NOT NULL, and the service keeps NULL to
pending accounts until a later release adds the CHECK), and signing
in to it fails as for an unknown address. The emailed link opens the web app's activation page, where
the student chooses one; `POST /auth/activate` sets it and activates in one transaction. So someone who
registers a student's address and keeps resending its link never chooses its password: see
[decisions.md O2](../docs/user-service/decisions.md).

A registration that never activated, and whose every link has expired, is not a duplicate:
registering it again replaces its display name and emails a new link.

**Password reset (#309).** Whoever owns the inbox can always replace the password:
`POST /auth/password-reset` mails a single-use link (30 minutes by default, stored hashed, the newest
only). Confirming it makes the same writes as activation: it sets the new password, activates the
account if it was pending (one `user.activated`), revokes every session and deletes every other unused
link.

**Try it** (needs the Compose stack): register, read the token from the email in Mailpit, then
activate with a password. Or open <http://localhost:8025> and click the link.

```bash
curl -s localhost:3001/auth/register -H 'content-type: application/json' \
  -d '{"email":"e0123456@u.nus.edu","displayName":"Alex"}'
token=$(./scripts-activation-token.sh e0123456@u.nus.edu)
curl -s localhost:3001/auth/activate -H 'content-type: application/json' \
  -d "{\"token\":\"$token\",\"password\":\"correct-horse-battery\"}"
```

### Sessions and tokens (USR-02)

| Endpoint                     | Purpose                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`           | Valid credentials on an `ACTIVE` account → 15-minute access token in the body, 7-day refresh token in an `HttpOnly` cookie. Rate limited per email (10 / 15 min, `LOGIN_LIMIT_PER_EMAIL`) and per IP (50 / 15 min, `LOGIN_LIMIT_PER_IP`) |
| `POST /auth/refresh`         | Rotates the refresh token. Reusing an already-rotated token revokes the whole session family                                                                                                                                             |
| `POST /auth/logout`          | Revokes the caller's whole session family. Idempotent                                                                                                                                                                                    |
| `GET /users/me`              | The caller's account (`PATCH /users/me` edits it, below)                                                                                                                                                                                 |
| `GET /.well-known/jwks.json` | Public key other services use to verify access tokens                                                                                                                                                                                    |

### Decision: where tokens live, and what that means for CSRF

**Access token** — a signed Ed25519 JWT (15 min), returned in the login response body and sent as
`Authorization: Bearer …`. The web app keeps it **in memory only**, never in `localStorage` or a cookie.
Because the browser does not attach an `Authorization` header by itself, every endpoint that uses it is
immune to CSRF, and because it is not in storage, an XSS bug cannot lift a long-lived credential.

**Refresh token** — an opaque 256-bit value, delivered _only_ as a cookie:
`foc_refresh; HttpOnly; SameSite=Strict; Path=/auth` (`Secure` in production, as Compose runs it; Chrome still
sends it to `http://localhost`, which it counts as secure).

- `HttpOnly`: page JavaScript cannot read it, so XSS cannot steal the 7-day credential.
- `Path=/auth`: it is sent to the auth endpoints and nowhere else.
- Only its SHA-256 is stored server-side. Every use rotates it; replaying an old one revokes the family.

**CSRF.** A cookie _is_ attached automatically, so the two endpoints that accept it (`/auth/refresh`,
`/auth/logout`) are defended in layers: `SameSite=Strict` (the browser will not send it cross-site), an
`Origin` check against `CORS_ORIGINS` (a foreign origin gets `403 CSRF_REJECTED`), and a required
`Content-Type: application/json` (a plain HTML form post cannot set it). None of these endpoints changes
data an attacker could profit from, but logout and refresh are still guarded. Sign-in and
`POST /auth/password` get the same check, against login CSRF.

**Why not `localStorage` for everything?** It would be simpler and needs no CSRF defence, but any XSS
would then hand an attacker a 7-day credential. The cost of the cookie design is that the web app and API
must be the same _site_ (`localhost:3000` and `:3001` are; ports do not matter to `SameSite`), and a page
reload loses the in-memory access token, so the app calls `/auth/refresh` on load.

**Signing key.** `JWT_PRIVATE_KEY` is the base64 of an Ed25519 PKCS#8 PEM. Generate one with:

```bash
node -e "const {generateKeyPairSync:g}=require('crypto');console.log(Buffer.from(g('ed25519').privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))"
```

Outside production, if it is unset the service generates a throwaway key at boot, so nothing secret is ever
committed; every restart then invalidates existing access tokens (refresh sessions survive and re-issue).

**Known limits.** Logout and suspension take effect immediately _for this service_, because the access-token
guard checks the session in the database on every request. Other services get it through
`@foc/auth-client` (USR-06), which asks `GET /internal/introspect`, caches the answer for at most
5 seconds, and drops it on `user.suspended`, `user.reactivated` or `user.role-changed`. Rate
limiting is in memory, so it is per instance. A session ends 7 days after login, however often it refreshes: each rotation keeps the expiry set at login.

### Roles, profile and administration (USR-03)

| Endpoint                                                     | Who                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /users/me`                                            | The caller. Five editable fields; `id`, `email`, `roles`, `status` are refused (`422 FIELD_NOT_EDITABLE`)                                               |
| `GET /admin/directory`                                       | ADMIN. Find accounts: email, name, roles, status; not recorded per account                                                                              |
| `GET /admin/users`, `GET /admin/users/:id`                   | ADMIN. Full records; every other account read, opened or listed, is recorded (`GET /admin/reads`)                                                       |
| `POST /admin/users/:id/suspend`, `…/reactivate`              | ADMIN. Reason; audit row + event; suspension revokes all sessions; at most 20 per admin per hour; an admin target needs a seeded admin and the password |
| `PUT /admin/users/:id/role`                                  | ADMIN. Asks to appoint or downgrade (`202`); only a seeded admin may downgrade; never yourself; never the last admin                                    |
| `GET /admin/role-requests`, `POST …/:id/approve`, `…/reject` | ADMIN. A second admin approves or rejects (with the password); the requester may withdraw; the target decides nothing                                   |
| `POST /auth/step-up`                                         | Any signed-in user. Re-enter the password; role changes and suspending an admin need it within 5 minutes                                                |
| `POST /auth/password`                                        | Anyone who proves the current password. Replaces it and revokes every session; login's rate limits apply                                                |
| `GET /admin/audit-records`                                   | ADMIN. Read-only, append-only. Filters below                                                                                                            |
| `GET /admin/reads`, `GET /admin/alerts`                      | ADMIN. Who opened which account; unusual admin activity. Read-only, append-only                                                                         |

`GET /admin/audit-records` returns newest first and combines its filters with AND: `targetUserId`, `actorId`
(a UUID; bootstrap rows have no actor), `action` (`SUSPEND`, `REACTIVATE`, `ROLE_GRANT`, `ROLE_REVOKE`,
`ADMIN_BOOTSTRAP`, `ROLE_CHANGE_REQUESTED`, `ROLE_CHANGE_REJECTED`), and a window `from` (inclusive) to `to` (exclusive), each an ISO 8601 date-time with an
offset, such as `2026-10-13T00:00:00Z` or `2026-10-13T00:00:00%2B08:00` (encode `+` as `%2B`; a raw `+` in a
query string decodes to a space). A malformed filter, an unknown parameter, or `to` not after `from` returns
`422 VALIDATION_FAILED`. Paging uses `page` and `pageSize`, as on `/admin/users`.

**Controlling the admins** ([ADR 0008](../docs/adr/0008-controlling-administrators.md)): two people for
every role change, password re-entry for the riskiest actions, a record of every account an admin opens,
alerts on unusual activity, and a per-admin suspension limit. `test/admin-controls.test.ts` covers each.

**First admin.** Set `ADMIN_SEED_EMAILS` and `ADMIN_SEED_PASSWORD`; the accounts are created at boot, each
with an `ADMIN_BOOTSTRAP` audit row (actor `SYSTEM`). An address that already has an account is skipped,
never promoted. The bootstrap password cannot start a session: logging in with it returns
`403 PASSWORD_CHANGE_REQUIRED`, and the admin must first set their own password. Do it as soon as the
account exists — the secret is shared by every seeded address and proves no mailbox, so until then anyone
who knows it can claim the account:

```bash
curl -s localhost:3001/auth/password -H 'content-type: application/json' \
  -d '{"email":"admin@u.nus.edu","currentPassword":"<ADMIN_SEED_PASSWORD from .env>","newPassword":"<your own>"}'
```

In Compose the bootstrap admin is `admin@u.nus.edu`, and its password is `ADMIN_SEED_PASSWORD` in your
`.env`, which `./scripts-init-env.sh` generated on your machine. To recover from a
misbehaving appointed admin when no bootstrap admin is reachable, add a new address to `ADMIN_SEED_EMAILS`,
rotate `ADMIN_SEED_PASSWORD`, redeploy and claim the account at once (roles.md §4). The address must never
have been registered: the seed skips an existing account, even an unactivated one someone registered to
squat it. If the boot log reports it as skipped, pick another address.

Authorisation reads the caller's role from the database on every request, never from the token or a header.
`test/matrix.test.ts` runs every protected endpoint as four actors and fails if a route is added without a
row. Role design: `docs/user-service/roles.md`.

### Events

Every event is written to `outbox_events` in the transaction that caused it, and published by the
shared relay when `RABBITMQ_URL` is set.

- `user.activated`: on activation, on a password reset that activates a pending account, and for each
  seeded administrator. The Credit Service issues the wallet. It is the one event published as
  mandatory, so a broker with no queue bound for it refuses it rather than dropping it.
- `user.suspended`, `user.reactivated`, `user.role-changed`: every `@foc/auth-client` cache (Supplier,
  Order, Credit, Chat) drops that user. The Order Service also handles `user.suspended` for the user's
  errands (ORD-06). Chat also closes that user's chat sockets (#346).
