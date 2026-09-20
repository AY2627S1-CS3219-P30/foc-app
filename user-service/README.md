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

| Variable       | Example        | Notes                                   |
| -------------- | -------------- | --------------------------------------- |
| `SERVICE_NAME` | `user-service` | Tags every log line                     |
| `PORT`         | `3001`         | Bind port                               |
| `NODE_ENV`     | `development`  | `development` \| `test` \| `production` |
| `LOG_LEVEL`    | `info`         | Defaults to `info`                      |

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

### Next tickets

USR-01, USR-02, USR-03
