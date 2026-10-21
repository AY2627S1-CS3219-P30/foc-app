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
| `bun test` | Unit tests |
| `bun run e2e` | Account journey in a browser against the running stack (see below) |
| `bun run generate` | Regenerate `tokens.css` and the API types after editing `tokens.ts` or a contract |

## Design system

**Tokens.** `src/styles/tokens.ts` is the single source for colour, spacing, type, radius, shadow and
size. `bun run generate` writes them to `src/styles/tokens.css` as variables (`--color-primary`,
`--space-4`, `--text-md`, …). Use `var(--…)` in CSS modules and `vars.*` from `@/styles/tokens` in inline
styles. `bun test` fails on a literal colour, font size or weight, or a breakpoint other than the two
below.

**Breakpoints.** Mobile first. Base styles hold from **360 px**; `@media (min-width: 768px)` switches to
the top bar and sidebar; `@media (min-width: 1440px)` widens the gutters. Nothing scrolls sideways at
360, 768 or 1440, and controls are at least 44 px tall.

**Primitives** (`src/components/`):

| Component | Use |
| --- | --- |
| `Field` | Label, hint, error and required marker for one control; wires `id`, `aria-describedby` and `aria-invalid` for it |
| `Input`, `Select`, `Textarea`, `Slider` | Native controls with the shared focus, disabled and invalid looks. Work inside or outside a `Field` |
| `FormField` | Shorthand for `<Field><Input /></Field>` |
| `FormAlert` | Form-level live message (`error`, `info`, `success`) |
| `Button`, `buttonClass` | `primary`, `accent`, `outline`, `subtle`; `buttonClass()` styles a `<Link>` as a button |
| `LoadingState`, `Skeleton` | Skeleton rows announced as a status |
| `EmptyState` | Title, explanation and an optional action |
| `ErrorState` | `role="alert"` with a retry button |

```tsx
<Field label="Email" hint="Your NUS address" error={errors.email} required>
  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
</Field>
```

## End-to-end checks

`e2e/errand-journey.e2e.ts` runs WEB-02, WEB-03 and WEB-05 with three students: two couriers race to
accept one errand (the loser's card is replaced with the reason), the winner sees the delivery
instructions and records pickup and delivery, and the requester confirms receipt until the errand is
complete. The requester then opens the receipt, follows it to the payment in their wallet and back,
and the courier follows the same payment from their receipt to their wallet and back.

`e2e/account-journey.e2e.ts` runs the account journey (USR-05) in Chromium at 360, 768 and 1440 px against
the real User Service: sign-up with a failed submit, activation through the dev mailbox, sign-in with a
rejected password, the mode switch and log-out. Only the keyboard drives the forms, and every focus stop
must show a ring. Every screen must not scroll sideways and must have no critical axe issue; serious axe
issues are listed in the test annotations without failing. CI runs it in the `e2e` job.

```bash
docker compose up -d --build   # from the repo root; serves :3000 with the dev mailbox
cd web-app
bunx playwright install chromium   # once
bun run e2e
```

`E2E_BASE_URL` points it elsewhere. Each run registers one account per width, well inside the sign-up
limit of 20 an hour per address. Specs are named `*.e2e.ts` so `bun test` leaves them alone.

## API clients

Types come from the contracts in [`contracts/`](../contracts), generated into `src/lib/generated/` by
`bun run generate` — never edit them by hand, and `bun test` fails if they are stale. The Supplier
Service client (`src/lib/supplier-api.ts`) is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/)
over those types, so paths, parameters and bodies are checked against the contract at compile time.
`unwrap` turns a failure into the same `ApiError` the account screens use, and `authed` refreshes the
token on a `401`:

```ts
const { authed } = useAuth();
const page = await authed((token) =>
  unwrap(supplierApi.GET("/suppliers", { params: { query: { type: "CAFE" } }, headers: bearer(token) })),
);
```

`src/lib/user-api.ts` keeps its hand-written transport (the session rules depend on it) but takes its
types from the generated User Service contract. `NEXT_PUBLIC_SUPPLIER_SERVICE_URL` works like the User
Service's address below.

## Talking to the services

**Accounts are live (USR-05).** Register, activate, sign in, change password, profile and the
requester↔courier switch call the real User Service (`src/lib/user-api.ts`, `src/lib/auth.tsx`).
The supplier listing calls the real Supplier Service through `src/lib/supplier-api.ts`.
Search, type and building filters, sort order, and paging are sent to `GET /suppliers`;
the page then retrieves each visible supplier by ID for the location and hours on its card.
Admin create, edit, and delete use the same service with the signed-in access token.
The new-request composer picks a pickup point with `SupplierPicker` (search over active suppliers
only) and passes its `supplierId` on; the details step resolves it with `useSupplier` and explains a
deactivated or missing supplier (`SUPPLIER_UNAVAILABLE`) instead of hiding it (SUP-04).
Creating an errand, the feed, order history, the errand page, its receipt, the wallet and the credit
pill call the real Order and Credit Services (below). Nothing reads mock data.

### Request composer (WEB-01)

`/request/new` → `details` → `review`, then `/request/{orderId}`. The calls are in
`src/lib/order-api.ts`; the draft, checks and error mapping in `src/lib/composer.ts`.

- **Pick** with `SupplierPicker` (SUP-04); the chosen `supplierId` travels in the URL.
- **Details**: items (name, quantity, optional note), a delivery zone, delivery instructions and a
  reward of 1–5 credits, checked against the Order Service's rules before anything is sent.
- **Review** shows the supplier, items, zone, the 60-minute open period (`OPEN_PERIOD_MINUTES`), the
  reward, the **available** balance from `GET /wallets/me` and `available − reward`, which is what the
  Credit Service reserves. Zero available credits, or fewer than the reward, blocks posting and says
  why; with none, it says courier work is how credits are earned.
- **Submit** sends `POST /orders` with an `Idempotency-Key` made once per draft. The draft and its key
  live in `sessionStorage`, so a retry, a reload or a reconnect replays the same key and the Order
  Service returns the original order instead of a second one. The button is disabled while a send is
  in flight. `422 INVALID_SUPPLIER` shows SUP-04's message and goes back to the picker;
  `422 VALIDATION_FAILED` (or a `400` with details) marks the fields; a `503` or network failure
  offers "Try again" with the same key. The draft is cleared once the server returns the order.
- **Result**: `/request/{orderId}` reads `GET /orders/{orderId}` with `useOrder`
  (`src/lib/use-order.ts`) until the errand is `REJECTED`, `COMPLETED`, `CANCELLED` or `EXPIRED`:
  1, 2, 4, 8, then every 15 seconds in the `*_PENDING_CREDIT` states, every 30 seconds otherwise. A
  hidden tab pauses; showing it again or coming back online reads at once, even after an error
  stopped polling. In a settled state, polling also pauses after 10 minutes without a change until
  the tab is shown or back online. It says any `*_PENDING_CREDIT` state is taking longer than usual
  30 seconds after the order's `updatedAt`. `OPEN` shows the deadline from `acceptanceDeadlineAt`;
  `REJECTED` shows what to do for its reason, using `rejection.available` when present. `REJECTED`
  and `EXPIRED` offer "Post a new request", a copy under a new key.

#### Recovery (WEB-04)

Every retry below sends the draft's key again, and the Order Service answers a repeated key with the
order it already made, so none of them can create a second errand. Posting anything under a new key
always takes a click the student can see.

- **Lost response** (the server made the order, the page never heard): the review offers "Try
  again" and keeps the draft. The retry gets `200` with the same order, and the order page says "This
  request was already posted". So does a second tab posting the same draft.
- **Offline**: the send fails as a network error and offers "Try again"; the `online` event retries
  by itself, with the same key.
- **`IDEMPOTENCY_KEY_REUSED`** (the details changed after a lost response): the first body sent
  under the key is kept as `sentBody` and replayed, which finds the original errand. The review says
  the changes weren't applied and moves them to a new key, posted only if the student asks.
- **Reload**: the draft, key and `sentBody` are in `sessionStorage`, so Post replays the same key. It
  stays enabled when the balance no longer covers the reward, since the lost post may hold it.

`e2e/reconnect-journey.e2e.ts` runs each case and checks through the API that it made one order and
reserved its reward once.

### After posting: couriers and requesters (WEB-02, WEB-03, WEB-05)

- **Feed** (`/feed`): `GET /orders`, which already leaves out the student's own errands. Each card
  shows the supplier, items, zone, reward and time left, counted from `timeRemainingSeconds` so a
  wrong device clock cannot skew it, and goes at zero. The list is read again every 30 seconds, on
  returning to the tab and on reconnecting.
- **History** (`/order-history`): `GET /orders/mine`, split into active and past. Each card shows the
  status, what it means for the student's part, their role, when it was posted, and until when it is
  open, when it last changed or when it ended. A complete errand links to its receipt. The list is read every 5 seconds while
  any errand is in a `*_PENDING_CREDIT` state, every 30 seconds while any is otherwise active, and on
  returning or reconnecting.
- **Receipt** (`/request/{orderId}/receipt`): `GET /orders/{orderId}/receipt`, readable by the
  requester and courier once the courier is paid. It shows the supplier, reward, both parties, every
  timestamp (`deliveredAt` is null when an administrator decided the errand for the courier) and links
  to the payment in the wallet. Before then it says there is no receipt yet.
- **Wallet** (`/wallet`): `GET /wallets/me` for the available, reserved and total figures, and
  `GET /wallets/me/ledger` paged by cursor with "Load more". Each entry shows its signed change to the
  total (`totalChange`: 0 for a reservation or release, which only move credits between available and
  reserved) and the total after it, and links to its errand, or to the receipt for a transfer.
  `/wallet?tx={transactionId}` (the receipt's `creditTransactionId`) loads pages until that entry is
  shown and focuses it, or says it isn't in the wallet. With nothing available, it explains that the
  student can't post but can still earn as a courier. Read again on returning or reconnecting.
- **Errand page** (`/request/{orderId}`): the role comes from the participant IDs, which only the
  requester and courier receive; anyone else is a prospective courier. Delivery instructions show
  only when the Order Service sends them, which it does once the errand is the courier's. The page
  reads the errand until it is final: on the backing-off schedule while the Credit Service has it,
  every 15 seconds otherwise, and at once on returning or reconnecting.
- **Actions** come from one table, `actionsFor(order, role, now)` in `src/lib/order-actions.ts`,
  which follows the Order Service's transition table:

  | Status | Requester | Courier | Anyone else |
  | --- | --- | --- | --- |
  | `OPEN` | Cancel | — | Accept, until the deadline |
  | `ACCEPTED` | Cancel | Record pickup, withdraw | — |
  | `PICKED_UP` | Report not delivered, from `nonDeliveryReportAt` | Record delivery | — |
  | `DELIVERED` | Confirm receipt; report not received until `autoConfirmAt` | — | — |
  | `DISPUTED` and the rest | — | — | — |

  A timer set for the governing deadline (`useNowAfter`) changes the offer at that moment, so the
  referral option appears exactly 2 hours after pickup. A referred errand says it is with an
  administrator and offers nothing.
- **Sending** goes through `useOrderAction`: every action is confirmed in a dialog, then sent with the
  version on screen as `expectedVersion`. A refusal because the errand moved on (`409`, `403`,
  `404`: someone else accepted it, it changed, or a report came too early or too late) closes the
  dialog, says what happened and re-reads, so the screen never keeps a button for a state that has
  gone. A network or server failure stays in the dialog to try again.

Every state's label and plain-language explanation is in `src/lib/order-status.ts`, typed from the
generated contract so all twelve are covered.

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
- `NEXT_PUBLIC_SUPPLIER_SERVICE_URL` is also inlined at build time. Local development defaults
  to `http://localhost:3002`; production builds require it. The Compose build already supplies
  the browser-facing address. To try the full stack, run `docker compose up --build` at the
  repository root, open `http://localhost:3000/suppliers`, and sign in. Rebuild after changing
  either service URL. The Supplier Service must allow the web app origin in `CORS_ORIGINS`.
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
ordering, the generated API client, `Field`'s accessibility wiring, generated files being current, the
design-token rules, and the session rules above (single-flight refresh, retry after `401`, which failures
sign out, pending sign-out, cross-tab sign-out) against a fake `fetch`, fake locks and a fake tab
channel. They use Bun's built-in runner, so `test/` is excluded from the Next typecheck. CI runs them
in the `web-app` job.

### Integration tests

`test/suppliers.integration.test.tsx` renders the supplier page against the real Supplier Service,
which verifies tokens with the real User Service. A fresh student (registered and activated through the
User Service's development mailbox) browses the seeded suppliers and is refused `POST /suppliers` with
`403`; the seeded admin creates, edits and deletes a supplier through the page. It is skipped unless
`SUPPLIER_SERVICE_URL` is set, so a plain `bun test` passes without a stack.

```bash
# From the repository root: just the two services and what they need (PostgreSQL, RabbitMQ).
docker compose -p foc-it --env-file .env.example up -d --build user-service supplier-service

cd web-app
SUPPLIER_SERVICE_URL=http://localhost:3002 bun test test/suppliers.integration.test.tsx

docker compose -p foc-it down -v   # from the repository root
```

Run the file on its own: the page's client reads its base URL when it is first imported, and another
test file may import it first. `USER_SERVICE_URL` defaults to `http://localhost:3001`. The User Service
must run in development mode (the Compose default), which mounts the mailbox.

The admin is `ADMIN_EMAIL` (default `admin@u.nus.edu`). On a fresh stack the test claims it, replacing
the bootstrap `ADMIN_SEED_PASSWORD` with `ADMIN_PASSWORD` (default `supplier-integration-admin`), as an
operator must before that account can sign in; later runs sign in with `ADMIN_PASSWORD`. Against your
own long-lived stack, set `ADMIN_PASSWORD` to the admin's current password, or the test will claim the
account with its default. Each run leaves a new student account behind and deactivates the supplier it
created.

CI runs it in the `Supplier listing integration` job when `supplier-service/`, the supplier page, its
client (`src/lib/supplier-*`, `SupplierCard`), the test itself, or anything shared or stack-wide changes
(`scripts-ci-detect.sh`).

The services run on ports 3001–3004 — see the root [README](../README.md). Every
service returns the same error envelope and echoes an `x-correlation-id` header,
so send one and log it alongside the response to trace a failure across services.

Order statuses are the twelve in
[`order-service/README.md`](../order-service/README.md), as generated into
`Order["status"]`; `src/lib/order-status.ts` labels and explains each one, for the requester, the
courier and anyone else. `statusWording(order, role)` takes the order because a
`RELEASE_PENDING_CREDIT` errand reads as cancelling or expiring from its `releaseReason`; the badge,
the cards and the errand page all use it, and none of the waiting states shows a spinner.

## Structure

```text
src/
├── app/           routes — (app) group for the authenticated shell
├── components/    shared UI and the form, button and state primitives
├── lib/           auth, API clients (generated/ from contracts), store, navigation
└── styles/        design tokens (tokens.ts → generated tokens.css)
```

## Admin console (ADM-02)

`/admin` sits in the `(app)` group, so it needs a session, and shows the console to administrators
only: a student who visits is told it is not for them, and the menu entry appears for administrators
alone. That is presentation. Every page calls real endpoints (`src/lib/admin-api.ts`), and each of them
refuses a student with `403` on its own.

| Page | Calls |
| --- | --- |
| Overview | Role requests and alerts (User Service); stuck errands and reconciliation (Order Service) |
| Users, one account | `GET /admin/directory` to find, `GET /admin/users/{userId}` to open (recorded), suspend, reactivate, role change; its errands from `GET /admin/orders?requesterId=` and `?courierId=` (Order Service, ORD-15), each list loading on its own (ADM-05) |
| Role requests | `GET /admin/role-requests`, approve, reject |
| Audit trail | `GET /admin/audit-records`, by administrator, account, action and dates |
| Admin activity | `GET /admin/alerts`, `GET /admin/reads` |
| Errands | `GET /admin/orders/pending-credit`, `GET /admin/orders/reconciliation-attempts`; referrals arrive with ORD-11 (#171) |
| Wallets | `GET /admin/wallets/{userId}` and its ledger (Credit Service; read-only, every read recorded) |
| Operations | Placeholder until PLT-05 (#154) |

**Controls on administrators** ([ADR 0008](../docs/adr/0008-controlling-administrators.md)). Every
write asks for a reason first. Requesting or approving a role change, and suspending an administrator,
can answer `401 STEP_UP_REQUIRED`: `useStepUp()` then asks for the password (`POST /auth/step-up`) and
runs the action once more (`src/lib/step-up.ts`). `session.ts` hands `STEP_UP_REQUIRED` and
`INVALID_CREDENTIALS` straight back to the caller instead of refreshing, since neither is about the
token. A role change answers `202` while it waits for a second administrator, and the account page
shows who may approve it.

**Names, not ids.** Tables name accounts from the directory (`_components/Directory.tsx`): email,
name, roles and status, which is not recorded per account. Opening an account, or listing full
records, is.

`NEXT_PUBLIC_ORDER_SERVICE_URL` and `NEXT_PUBLIC_CREDIT_SERVICE_URL` work like the User Service's
address: inlined at build time, with `http://localhost:3003` and `:3004` as the development defaults.

## Deployment

Pushes to `main` that touch `web-app/**` deploy to Vercel via
[`.github/workflows/deploy-web-app.yml`](../.github/workflows/deploy-web-app.yml).
