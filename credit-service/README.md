# Credit Service

## Running this service

Owned by **Isaac**. Implements the closed credit economy — wallets, ledger, reservations.

### Prerequisites

Node 22.12 or later (`nvm use` picks it up from `.nvmrc`). Install dependencies
once from the repository root — this is an npm workspace, so a per-service
`npm install` is neither needed nor correct:

```bash
npm install
```

### Commands

Run these from the repository root.

| Command                                    | What it does                  |
| ------------------------------------------ | ----------------------------- |
| `npm run dev:credit`                       | Start with reload on change   |
| `npm run build -w @foc/credit-service`     | Compile TypeScript to `dist/` |
| `npm test -w @foc/credit-service`          | Run this service's tests      |
| `npm run typecheck -w @foc/credit-service` | Type-check without emitting   |
| `npm run lint`                             | Lint every service            |

### Required environment

| Variable       | Example          | Notes                                   |
| -------------- | ---------------- | --------------------------------------- |
| `SERVICE_NAME` | `credit-service` | Tags every log line                     |
| `PORT`         | `3004`           | Bind port                               |
| `NODE_ENV`     | `development`    | `development` \| `test` \| `production` |
| `LOG_LEVEL`    | `info`           | Defaults to `info`                      |

A missing required variable stops the service at boot and names the variable.
Nothing falls back to an insecure default.

```bash
SERVICE_NAME=credit-service PORT=3004 npm run dev:credit
curl -i http://localhost:3004/health
```

### What you get from `@foc/platform`

Importing `PlatformModule.forRoot(...)` gives this service a `GET /health`
endpoint, structured JSON logging where every line carries a correlation ID,
request logging, a shared error envelope, and graceful shutdown on `SIGTERM`.
Do not re-implement these per service — extend the shared package instead, so a
change lands once rather than four times.

### Docker

```bash
docker build -f credit-service/Dockerfile -t foc/credit-service .
```

The build context is the **repository root**, not this folder, because the image
needs the workspace manifests and `@foc/platform`. The image runs as a non-root
user and declares a `HEALTHCHECK`. `compose.yaml` wiring arrives with PLT-02.

### Next tickets

CRD-01, CRD-02, CRD-03
