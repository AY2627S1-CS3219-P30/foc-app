# Supplier Service

## Running this service

Owned by **Patrick**. Implements the campus supplier catalogue and its search surface.

### Prerequisites

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

| Variable       | Example            | Notes                                   |
| -------------- | ------------------ | --------------------------------------- |
| `SERVICE_NAME` | `supplier-service` | Tags every log line                     |
| `PORT`         | `3002`             | Bind port                               |
| `NODE_ENV`     | `development`      | `development` \| `test` \| `production` |
| `LOG_LEVEL`    | `info`             | Defaults to `info`                      |

A missing required variable stops the service at boot and names the variable.
Nothing falls back to an insecure default.

```bash
SERVICE_NAME=supplier-service PORT=3002 npm run dev:supplier
curl -i http://localhost:3002/health
```

### What you get from `@foc/platform`

Importing `PlatformModule.forRoot(...)` gives this service a `GET /health`
endpoint, structured JSON logging where every line carries a correlation ID,
request logging, a shared error envelope, and graceful shutdown on `SIGTERM`.
Do not re-implement these per service — extend the shared package instead, so a
change lands once rather than four times.

### Docker

```bash
docker build -f supplier-service/Dockerfile -t foc/supplier-service .
```

The build context is the **repository root**, not this folder, because the image
needs the workspace manifests and `@foc/platform`. The image runs as a non-root
user and declares a `HEALTHCHECK`. `compose.yaml` wiring arrives with PLT-02.

### Next tickets

SUP-01, SUP-02
