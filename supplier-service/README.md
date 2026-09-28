# Supplier Service (SUP-01)

Owned by **Patrick** (Catalogue & Frontend). The campus supplier **catalogue**:
the stores, cafés, printing points, shops and landmarks a student can request an
errand from. This ticket delivers the data layer, the admin CRUD API, and an
idempotent seed. Search / filter / sort / pagination (SUP-02), the listing UI
(SUP-03), and the deletion-hold against live errands (SUP-04) are out of scope.

Built on the shared runtime: `@foc/platform` (config, logging, correlation,
health, the `{ error: { code, message, correlationId, details } }` envelope) and
`@foc/auth-client` (verifies a caller's token and resolves their live identity
from the User Service — this service never parses a token itself).

Design & rationale (D2 §1–§2: DB choice, full schema, opening-hours decision,
traceability): [`docs/supplier-service/schema.md`](../docs/supplier-service/schema.md).

## Data model

One `suppliers` row per supplier. Required (`NOT NULL`): `supplier_id`, `name`,
`type`, `building`, `floor`, `location_description`, `active`, `version`,
`created_at`, `updated_at`. Optional (nullable): `opening_hours` (JSONB),
`latitude`+`longitude` (a pair), `image_url`, `tags` (JSONB). `type` is the closed
enum `FOOD | CAFE | PRINTING | SHOPPING | LANDMARK`. Required-vs-optional, the
enum, coordinate ranges, and the duplicate rule are all enforced by database
constraints, not only the validator — see the schema doc.

**Opening hours** are `[{ day, opens, closes }]` with 24-hour `HH:MM` times;
`00:00`–`23:59` is open all day and a `closes ≤ opens` window runs past midnight
(schema doc §3).

## API

Base path `/suppliers`. All errors use the shared envelope.

| Method   | Path             | Who           | Notes                                                           |
| -------- | ---------------- | ------------- | --------------------------------------------------------------- |
| `GET`    | `/suppliers`     | any signed-in | Active suppliers only.                                          |
| `GET`    | `/suppliers/:id` | any signed-in | Resolves any supplier by id, **including deactivated** ones.    |
| `POST`   | `/suppliers`     | **admin**     | Create. Honors `Idempotency-Key`. `201` created / `200` replay. |
| `PUT`    | `/suppliers/:id` | **admin**     | Partial update. Requires `If-Match: <version>`.                 |
| `DELETE` | `/suppliers/:id` | **admin**     | Soft deactivation (`active = false`). Idempotent.               |

### Permission table (enforced server-side)

The role is always read from the identity `@foc/auth-client` resolves — never from
a header, a body, or the token.

| Action      | Anonymous | Student (signed-in) | Admin |
| ----------- | :-------: | :-----------------: | :---: |
| List active |  ✗ (401)  |          ✓          |   ✓   |
| View by id  |  ✗ (401)  |          ✓          |   ✓   |
| Create      |  ✗ (401)  |       ✗ (403)       |   ✓   |
| Update      |  ✗ (401)  |       ✗ (403)       |   ✓   |
| Deactivate  |  ✗ (401)  |       ✗ (403)       |   ✓   |

A non-admin mutation returns `403 FORBIDDEN` and changes nothing (proven by a
direct API call in `test/suppliers.test.ts`).

### Validation — `422 VALIDATION_FAILED`

Create/update bodies are validated with zod. **Every** invalid field is returned at
once as `422` with `details: [{ field, code, message }, …]`. Rejected: an invalid
`type`, a blank required field, a malformed or unpaired coordinate, an unknown
field, and a case-insensitive duplicate of `name`+`building` among active
suppliers (`DUPLICATE_NAME_BUILDING`).

### Retry safety

- **Idempotency-Key** (create): a repeated `POST` with the same header returns the
  original supplier (`200`) instead of creating a second row or `409`.
- **If-Match / version** (update): send `If-Match: <version>` (the row's `version`,
  also returned as the `ETag`). A stale value returns `412 STALE_VERSION` and
  changes nothing; a missing header is `428 PRECONDITION_REQUIRED`.
- **Atomicity**: every mutation runs in one transaction — it commits fully or not
  at all, and a failure surfaces through the error envelope with nothing
  half-written.

## Seed

Loaded at boot, idempotent and stable (schema doc §4): each supplier's id is a
UUIDv5 of `lower(name)|building`, so three runs produce the same rows and ids and
an admin's later edits are never overwritten. Source data:

- **`data/csv/supplier-seed-data.csv`** — the CS3219 FoC template
  (`CS3219-AY2627S1/FoC-Template`), 21 rows, kept verbatim (messy source encodings
  and all) so the normalizer is exercised against the real thing.
- **`data/csv/supplier-seed-additions.csv`** — this team's 12 supplementary
  records, including the LANDMARK pickup points the template lacks, taking the
  corpus to **33 active suppliers across 20 buildings and all five types** — past
  SS-FR4.1.1's floor of ≥30 across ≥10 buildings.

## Running this service

Node 22.12 or later (`nvm use` picks it up from `.nvmrc`). Install dependencies
once from the repository root — this is an npm workspace, so a per-service
`npm install` is neither needed nor correct:

```bash
npm install
```

### Commands

Run these from the repository root.

| Command                                      | What it does                  |
| -------------------------------------------- | ----------------------------- |
| `npm run dev:supplier`                       | Start with reload on change   |
| `npm run build -w @foc/supplier-service`     | Compile TypeScript to `dist/` |
| `npm test -w @foc/supplier-service`          | Run this service's tests      |
| `npm run typecheck -w @foc/supplier-service` | Type-check without emitting   |
| `npm run lint`                               | Lint every service            |

### Required environment

On top of the shared base (`SERVICE_NAME`, `PORT`, `NODE_ENV`, `LOG_LEVEL`,
`CORS_ORIGINS`, optional `RABBITMQ_URL`):

| Variable               | Example                                   | Notes                                                       |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`         | `postgres://…@postgres:5432/foc_supplier` | Migrations run at boot; the schema is never behind traffic. |
| `USER_SERVICE_URL`     | `http://user-service:3001`                | Base URL for identity introspection.                        |
| `INTERNAL_SERVICE_KEY` | one of the User Service's keys            | Presented as `X-Service-Key`.                               |

A missing required variable stops the service at boot and names the variable.
Nothing falls back to an insecure default.

```bash
curl -i http://localhost:3002/health
```

### What you get from `@foc/platform`

Importing `PlatformModule.forRoot(...)` gives this service a `GET /health`
endpoint, structured JSON logging where every line carries a correlation ID,
request logging, a shared error envelope, and graceful shutdown on `SIGTERM`.
Do not re-implement these per service — extend the shared package instead, so a
change lands once rather than four times.

### Tests

Mirror the User Service style: unit tests for the CSV parser, normalizer and
deterministic ids; integration tests boot the real modules against an **ephemeral**
in-memory PostgreSQL (PGlite) — never a shared database — with the authenticator
replaced by a test double so the permission logic is exercised directly.

### Docker

```bash
docker build -f supplier-service/Dockerfile -t foc/supplier-service .
```

The build context is the **repository root**, not this folder, because the image
needs the workspace manifests, `@foc/platform`, `@foc/auth-client`, and the seed
CSVs under `data/csv/`. The image runs as a non-root user and declares a
`HEALTHCHECK`; `compose.yaml` wires it into the stack.

### Next tickets

SUP-02 (search / filter / sort / pagination), SUP-03 (listing UI), SUP-04
(deletion-hold against live errands).
