# User Service

## Running this service

Owned by **Anselm**. Implements identity, authentication, RBAC, and account status.

### Prerequisites

Node 22.12 or later (`nvm use` picks it up from `.nvmrc`). Install dependencies
once from the repository root — this is an npm workspace, so a per-service
`npm install` is neither needed nor correct:

```bash
npm install
```

### Commands

Run these from the repository root.

| Command                                  | What it does                  |
| ---------------------------------------- | ----------------------------- |
| `npm run dev:user`                       | Start with reload on change   |
| `npm run build -w @foc/user-service`     | Compile TypeScript to `dist/` |
| `npm test -w @foc/user-service`          | Run this service's tests      |
| `npm run typecheck -w @foc/user-service` | Type-check without emitting   |
| `npm run lint`                           | Lint every service            |

### Required environment

| Variable                     | Example                                            | Notes                                                         |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `SERVICE_NAME`               | `user-service`                                     | Tags every log line                                           |
| `PORT`                       | `3001`                                             | Bind port                                                     |
| `NODE_ENV`                   | `development`                                      | `development` \| `test` \| `production`                       |
| `LOG_LEVEL`                  | `info`                                             | Defaults to `info`                                            |
| `DATABASE_URL`               | `postgres://user_service:…@postgres:5432/foc_user` | Supplied by Compose                                           |
| `ALLOWED_EMAIL_DOMAINS`      | `u.nus.edu,nus.edu.sg`                             | Registration is limited to these domains                      |
| `INTERNAL_SERVICE_KEYS`      | (16+ chars each)                                   | Keys other services send as `X-Service-Key` on `/internal/**` |
| `ACTIVATION_TOKEN_TTL_HOURS` | `24`                                               | Optional; 1–168                                               |

A missing required variable stops the service at boot and names the variable.
Nothing falls back to an insecure default.

```bash
SERVICE_NAME=user-service PORT=3001 npm run dev:user
curl -i http://localhost:3001/health
```

### What you get from `@foc/platform`

Importing `PlatformModule.forRoot(...)` gives this service a `GET /health`
endpoint, structured JSON logging where every line carries a correlation ID,
request logging, a shared error envelope, and graceful shutdown on `SIGTERM`.
Do not re-implement these per service — extend the shared package instead, so a
change lands once rather than four times.

### Docker

```bash
docker build -f user-service/Dockerfile -t foc/user-service .
```

The build context is the **repository root**, not this folder, because the image
needs the workspace manifests and `@foc/platform`. The image runs as a non-root
user and declares a `HEALTHCHECK`. `compose.yaml` wiring arrives with PLT-02.

### What is implemented (USR-01)

| Endpoint                              | Purpose                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                 | Normalise the email, enforce the domain allowlist, reject duplicates, hash the password with Argon2id, issue a one-time activation token |
| `POST /auth/activate`                 | Single-use, expiring, replay-idempotent; publishes exactly one `UserActivated` to the outbox                                             |
| `GET /internal/users/:id`             | Least-data identity lookup (`X-Service-Key` required)                                                                                    |
| `GET /internal/users/:id/permissions` | Effective permissions for admin authorisation (`X-Service-Key` required)                                                                 |
| `GET /dev/mailbox?to=`                | **Development only.** Reads the activation token that would be emailed. Refused in production                                            |

The contract is `contracts/user-service.openapi.yaml`; role and schema design are in
`docs/user-service/`. Migrations run at boot and are forward-only (`src/db/migrations.ts`).

**Tests run on PGlite** (PostgreSQL compiled to WASM), so `npm test -w @foc/user-service` needs no
database server or Docker. Runtime uses `pg` against the Compose Postgres.

**Try it** (needs the Compose stack): register, read the token from the dev mailbox, activate:

```bash
curl -s localhost:3001/auth/register -H 'content-type: application/json' \
  -d '{"email":"e0123456@u.nus.edu","password":"correct-horse-battery","displayName":"Alex"}'
curl -s 'localhost:3001/dev/mailbox?to=e0123456@u.nus.edu'
curl -s localhost:3001/auth/activate -H 'content-type: application/json' -d '{"token":"<token>"}'
```

### Next tickets

USR-02 (login, refresh rotation, logout), USR-03 (RBAC, profile, admin controls)
