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

### Sessions and tokens (USR-02)

| Endpoint                     | Purpose                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`           | Valid credentials on an `ACTIVE` account → 15-minute access token in the body, 7-day refresh token in an `HttpOnly` cookie. Rate limited per email (10 / 15 min) and per IP (50 / 15 min) |
| `POST /auth/refresh`         | Rotates the refresh token. Reusing an already-rotated token revokes the whole session family                                                                                              |
| `POST /auth/logout`          | Revokes the caller's whole session family. Idempotent                                                                                                                                     |
| `GET /users/me`              | The caller's account (read-only here; edits arrive with USR-03)                                                                                                                           |
| `GET /.well-known/jwks.json` | Public key other services use to verify access tokens                                                                                                                                     |

### Decision: where tokens live, and what that means for CSRF

**Access token** — a signed Ed25519 JWT (15 min), returned in the login response body and sent as
`Authorization: Bearer …`. The web app keeps it **in memory only**, never in `localStorage` or a cookie.
Because the browser does not attach an `Authorization` header by itself, every endpoint that uses it is
immune to CSRF, and because it is not in storage, an XSS bug cannot lift a long-lived credential.

**Refresh token** — an opaque 256-bit value, delivered _only_ as a cookie:
`foc_refresh; HttpOnly; SameSite=Strict; Path=/auth` (`Secure` in production; local development is plain http).

- `HttpOnly`: page JavaScript cannot read it, so XSS cannot steal the 7-day credential.
- `Path=/auth`: it is sent to the auth endpoints and nowhere else.
- Only its SHA-256 is stored server-side. Every use rotates it; replaying an old one revokes the family.

**CSRF.** A cookie _is_ attached automatically, so the two endpoints that accept it (`/auth/refresh`,
`/auth/logout`) are defended in layers: `SameSite=Strict` (the browser will not send it cross-site), an
`Origin` check against `CORS_ORIGINS` (a foreign origin gets `403 CSRF_REJECTED`), and a required
`Content-Type: application/json` (a plain HTML form post cannot set it). None of these endpoints changes
data an attacker could profit from, but logout and refresh are still guarded.

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
guard checks the session in the database on every request. Other services will get the same guarantee from
the shared middleware (USR-06), which must check session state rather than trust the JWT alone. Rate
limiting is in memory, so it is per instance. Refresh lifetime is sliding: each rotation issues a fresh 7 days.

### Next tickets

USR-03 (RBAC, profile edits, admin suspend/reactivate/roles), USR-06 (shared middleware for other services)
