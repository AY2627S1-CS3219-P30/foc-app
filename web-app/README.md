# Web App

The FoC front end — a responsive Next.js application covering the requester and
courier journeys.

## Toolchain

This package uses **Bun**, and is deliberately **outside** the repository's npm
workspace so the two package managers never contend for one `node_modules`.
Do not run `npm install` here.

## Getting started

```bash
cd web-app
bun install
bun dev
```

Open <http://localhost:3000>.

| Command | What it does |
| --- | --- |
| `bun dev` | Development server with hot reload |
| `bun run build` | Production build |
| `bun start` | Serve the production build |
| `bun run lint` | Lint |

## Talking to the services

**Accounts are live (USR-05).** Register, activate, sign in, change password, profile and the
requester↔courier switch call the real User Service (`src/lib/user-api.ts`, `src/lib/auth.tsx`).
Errands, wallet and suppliers still run on the in-memory mock store (`src/lib/store.tsx`); replacing
that is [WEB-01](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/146).

### Sessions

The rules live in `src/lib/session.ts` (no React, so they are unit-tested); `src/lib/auth.tsx`
holds the React state around them.

- The access token is kept **in memory only** (never `localStorage`); the refresh token is an
  `HttpOnly` cookie the page cannot read. Every cold load calls `/auth/refresh`.
- Refresh **rotates** the cookie and a reused cookie revokes the session, so refresh is
  single-flight: one promise per tab, and a Web Lock (`foc-auth-refresh`) across tabs. Without the
  lock, two tabs restored together sign each other out — verified in a browser both ways.
- An API call that gets `401` refreshes once and retries — with the newer token if another call
  already refreshed, so the cookie is not rotated twice. A refresh that comes back for a different
  account (signed in from another tab) reloads the user and does not replay the call.
- Only the service **refusing** the cookie (`401`/`403`) signs you out. Offline, a timeout (10 s on
  every call, so a hung service cannot hold the lock) or a `5xx` shows "Try again" instead.
- Signing out must reach the service, or the cookie stays live for the next person at a shared
  computer. If it cannot, a non-secret `foc-logout-pending` flag goes into `localStorage`, the sign-in
  screen says so (with a retry), and the next load revokes the cookie instead of refreshing it.
  Signing out in one tab signs out the others.
- Screens in the `(app)` group need a session; a signed-out visitor goes to `/login?next=…` and
  comes back afterwards (`next` must resolve to a path on this site).

### Configuration

- `NEXT_PUBLIC_USER_SERVICE_URL` is inlined at **build** time, so set it where the app is built:
  the Vercel project's environment, or the `web-app` build args in `compose.yaml` (the Dockerfile
  takes it as an `ARG`; setting it on a running container does nothing). Unset, a development build
  uses `http://localhost:3001`; a production build shows a configuration error on the account
  screens rather than calling localhost. The build itself still succeeds.
- **The web app and the User Service must be same-site** (same registrable domain, e.g.
  `app.example.com` and `api.example.com`; the port does not matter, so `localhost:3000` and
  `localhost:3001` are fine). The refresh cookie is `SameSite=Strict`
  (`user-service/src/auth/cookies.ts`), so across sites the browser never sends it and every reload
  signs the user out. Note that each `*.vercel.app` subdomain is its own site. The User Service's
  `CORS_ORIGINS` must also list the web app's origin.
- `NEXT_PUBLIC_DEV_MAILBOX=true` lets a production build use the User Service's development mailbox
  (the Compose stack does, since its User Service runs in development mode). A development build
  always may; nothing else calls it.

### Waiting on the User Service

- **Resend activation.** There is no endpoint to send a fresh activation link, and registering again
  is refused (`409 EMAIL_ALREADY_REGISTERED`), so an expired link is a dead end: the activate screen
  can only say to contact support. It needs something like `POST /auth/activation/resend` (rate
  limited, answering the same whether or not the email exists).

### Tests

`bun test` runs the unit tests in `test/`: validation, error-envelope parsing, redirect safety, nav
ordering, and the session rules above (single-flight refresh, retry after `401`, which failures
sign out, pending sign-out, cross-tab sign-out) against a fake `fetch`, fake locks and a fake tab
channel. They use Bun's built-in runner, so `test/` is excluded from the Next typecheck. CI runs them
in the `web-app` job.

When you do wire it up, the services run on ports 3001–3004 — see the root
[README](../README.md). Every service returns the same error envelope and echoes
an `x-correlation-id` header, so send one and log it alongside the response to
trace a failure across services.

> **Note:** `src/lib/types.ts` defines `RequestStatus` with five values. That does
> not match the order status model in
> [`order-service/README.md`](../order-service/README.md). Reconciling the two is
> part of WEB-01 — do not add screens against the current shape without reading
> that first.

## Structure

```text
src/
├── app/           routes — (app) group for the authenticated shell
├── components/    shared UI
└── lib/           auth + User Service client, store, types, navigation, mock data
```

## Deployment

Pushes to `main` that touch `web-app/**` deploy to Vercel via
[`.github/workflows/deploy-web-app.yml`](../.github/workflows/deploy-web-app.yml).
