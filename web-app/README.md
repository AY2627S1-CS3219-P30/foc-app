# Web App

The Friend on Campus (FoC) front end — a responsive Next.js application covering the requester and
courier journeys. It installs as an app (`src/app/manifest.ts`: "Friend on Campus", short name "FoC",
icon letter "F"), and `public/sw.js` (cache `foc-shell-v1`) serves pages network-first, cached for
offline use; API calls are never cached.

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

Open <http://localhost:3000>. The Compose stack's edge also publishes port 3000, so run one or the
other.

| Command | What it does |
| --- | --- |
| `bun dev` | Development server with hot reload |
| `bun run build` | Production build |
| `bun start` | Serve the production build |
| `bun run lint` | Lint |
| `bun test` | Unit tests |
| `bun run typecheck:contracts` | Type-check the generated API clients against the contracts |
| `bun run e2e` | Account journey in a browser against the running stack (see below) |
| `bun run generate` | Regenerate `tokens.css` and the API types after editing `tokens.ts` or a contract |

## Design system

**Tokens.** `src/styles/tokens.ts` is the single source for colour, spacing, type, radius, shadow,
size and motion. `bun run generate` writes them to `src/styles/tokens.css` as variables (`--color-primary`,
`--space-4`, `--text-md`, …). Use `var(--…)` in CSS modules and `vars.*` from `@/styles/tokens` in inline
styles. `bun test` fails on a literal colour, font size or weight, a breakpoint other than the two
below, a token pair under 4.5:1 contrast (text) or 3:1 (non-text), or a `<ul>`/`<ol>` without a class
or style.

**Motion.** `motion.*` holds the durations (`fast` 120 ms, `base` 200 ms, `slow` 320 ms), the
easings and the travel distance: routine changes are quick, arrivals ease out, and exits are faster
than entrances. Under `prefers-reduced-motion`, `globals.css` sets the distance to 0, so motion keeps
its fades and drops its travel. Nothing that takes focus fades in from invisible.

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
| `Button`, `buttonClass` | `primary`, `accent`, `outline`, `subtle`; `buttonClass()` styles a `<Link>` as a button. A press state, off under reduced motion; `outline` uses the 3:1 control border |
| `Icon` | The app's drawn SVG icons (`menu`, `back`, `plus`), in one stroke and `currentColor`. Always decorative: the control that holds one carries the name |
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

`e2e/live-journey.e2e.ts` (N1.4) checks what only the live-update stream can do, since a settled
page polls every 30 seconds: a new errand reaches a courier's open board within 3 s, and the
courier's accept reaches the requester's open errand page within 3 s. Refused its stream first, the
page says *Updating every 30 s* and still works, at every width.

`e2e/mobile-layout.e2e.ts` (TST-04, release suite) measures the core screens, from sign-in to the wallet: at
every width no sideways scroll and no control cut off, and at 360 px every control at least 44 by 44
px, with the screen's primary action clear of the app bar. A failure names the screen and the control.

`e2e/dispute-outcome.e2e.ts` covers both administrative dispute decisions at all three widths.
The requester reports non-receipt, the referred administrator decides through the console, and
both participants read the outcome, reason and time on their errand page and expand its status
history. The test also verifies the actual transfer/refund and an outsider's HTTP refusal and
absence of private history in the page.

The participant history panel (WEB-06, #281) reads the existing authenticated
`GET /orders/{id}/history`; no new backend route or contract field is needed. It shows only the
server's participant projection, hides cached history immediately when the identity or errand
changes, ignores stale replies, and offers retry on failure. System causes and raw actor IDs are
not displayed. Administrative decisions show their actual reason and recorded time; an ordinary
cancellation or completion is not labelled as an administrative decision.

`e2e/account-journey.e2e.ts` runs the account journey (USR-05) in Chromium at 360, 768 and 1440 px against
the real User Service: sign-up with a failed submit, activation from the link in the email (read from
Mailpit) by choosing a password, with a mismatched confirmation first, sign-in with a rejected password, the mode switch and log-out. A second test asks for a new
link on `/activate`, then checks the old link is refused and the new one activates. Only the keyboard drives the forms, and every focus stop
must show a ring. Every screen must not scroll sideways and must have no critical axe issue; serious axe
issues are listed in the test annotations without failing. CI runs it in the `e2e` job.

```bash
docker compose up -d --build   # from the repo root; serves :3000, and Mailpit on :8025
cd web-app
bunx playwright install chromium   # once
bun run e2e
```

`E2E_BASE_URL` points it elsewhere, and `E2E_MAILPIT_URL` the inbox. The specs call the services through the edge too, at
`$E2E_BASE_URL/api/<service>`, as the page does: a sign-in there sets the refresh cookie for
`/api/user/auth`, where the page refreshes (`E2E_USER_SERVICE_URL` and the like override one). Each run
registers two accounts per width, well inside the sign-up limit of 20 an hour per address. Specs are
named `*.e2e.ts` so `bun test` leaves them alone. The admin specs (`dispute-outcome` and
`ledger-audit`, plus three release-only ones) claim the seeded administrator from `../.env` on a fresh stack, replacing its bootstrap password;
against a stack whose admin you already claimed, set `E2E_ADMIN_PASSWORD` to its current password.

`E2E_BROWSER_CHANNEL=chrome` drives an installed Google Chrome instead of Playwright's Chromium, so
nothing needs installing. CI does that: GitHub's Ubuntu runners come with Chrome and its system
libraries, which keeps the `e2e` job from downloading a browser or running `apt` each time. The job
builds the stack's images from CI's shared layer cache; each smoke/release matrix job has a
40-minute ceiling.

### Full release suite (TST-02 #160)

From the repository root, with Docker running, Node and Bun 1.4.2 installed:

```bash
npm ci
(cd web-app && bun install --frozen-lockfile && bunx playwright install chromium)
./scripts-e2e-release.sh --twice
# One clean run while debugging:
./scripts-e2e-release.sh --once
# Stop only this test project, preserving its last data and evidence:
./scripts-e2e-release.sh --stop
```

This resets **only `foc-e2e-release` and its volumes**, on ports 14500–14511 (override with
`E2E_PORT_BASE`). It generates `.env` if absent, builds the stack, runs its API smoke, and creates
activated test identities through public APIs for each clean run. It does not reset `foc` or
`foc-d4-demo`. There are 63 browser cases (21 per width) across 360, 768 and 1440 px, with no
retries in release mode. CI requires both `Browser journeys (smoke)` (24 baseline cases,
release-only cases skipped) and `Browser journeys (release)` (all 63 cases from clean volumes: twice
on a push to `main`, once otherwise). The latter reuses the job's
baked images with `E2E_IMAGE_TAG=ci`; leave that unset for local source builds.

`release-journeys.e2e.ts` covers the composer, withdrawal/reacceptance and cancellation before
pickup, both participants' order history, a non-receipt dispute, courier suspension/reassignment
with exact wallet checks, supplier search/filters, and login/opening every admin area. Withdrawal
keeps the reservation for a replacement courier; cancellation releases it. That is the implemented
state-machine contract, clarifying the audit checklist's ambiguous “with credits returned.”
`zz-release-clock.e2e.ts` covers server expiry/refund, automatic confirmation/payment without a
requester click, and non-delivery reporting only after its period followed by an admin decision.
`accessibility.e2e.ts` runs axe (WCAG 2.0/2.1 A and AA plus best practices) on every student
screen, the composer to the wallet, and every admin console page, and fails on a critical or
serious issue; `keyboard-journey.e2e.ts` completes the errand journey from sign-in to the wallet by
keyboard alone and times each action's feedback (UI-NFR2.1.1, UI-NFR2.1.2, UI-NFR3.1.2). Both pay
from a requester of their own. Lighthouse is not in CI: `./scripts-lighthouse.sh` (see the
[report of 3 Nov](../docs/reports/accessibility-and-web-vitals-2026-11-03.md)).
The existing suites supply registration, the acceptance race, receipt/ledger navigation, both
dispute outcomes and outsider denial, reconnection idempotency and the admin financial audit.

The explicit `compose.e2e.yaml` override mounts `test-harness/e2e-clock.mjs` into the five backend
services. A guarded non-secret offset file advances implicit Node time and explicit SQL `now()` /
`clock_timestamp()` reads together. Ordinary PostgreSQL defaults and the browser clock are not
rewritten. Tests read each order's actual server deadline, advance beyond it, wait until each container observes the mounted offset, and sign in normally
again (old tokens can expire), and wait for real lifecycle workers and RabbitMQ credit replies.
No application data is injected or modified directly, and no HTTP clock-control endpoint exists.
The fixture requires the disposable development configuration and is not baked into any image.
Release-only login budgets accommodate the repeated independent sessions; normal smoke and User
Service tests retain the default rate limits. Auth, activation, roles and step-up remain enabled.
Clock cases run last in each width with one worker; changing parallelism would race the shared clock.

Each successful JSON report must have zero failures, flakes, skips and runner errors. Reports are
in `.release-results/run-1.json` and `run-2.json`, with HTML in `html-1/` and `html-2/`. Failures retain
screenshots/traces under `web-app/test-results` and bounded container logs under `.release-results`.
CI uploads release evidence even on success, and failure traces/screenshots separately. Treat those
artifacts as private test data: they can include disposable credentials and session contents.
They are ignored by Git and excluded from Docker build contexts.

This suite certifies the paths listed in #160 and the chat journey (#161); the two human non-owner
rehearsals required by #167 are outside it.

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

**Accounts are live (USR-05).** Register, activate, sign in, change or reset password, profile and the
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
- **Review** shows the supplier, items, zone, that it stays open for a set time once the credits are
  reserved (the errand page shows the deadline), the reward, the **available** balance and
  `available − reward`, which is what the Credit Service reserves. The balance is the credits pill's
  own `GET /wallets/me` (`useCredits()`), read again on opening the step, on retry and before
  posting. Zero available credits, or fewer than the reward, blocks posting and says
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
  wrong device clock cannot skew it, and goes at zero. The list is read again every 30 seconds (in
  requester mode every 5 seconds while any errand is waiting on credits), on returning to the tab
  and on reconnecting. A failed refresh keeps the cards on screen and tries again in 30 seconds. In courier mode it is narrowed by pickup building and
  minimum reward; in requester mode the feed is *Active requests*,
  `GET /orders/mine?role=REQUESTER&active=true`. A card with 5 minutes or less left shows its time
  in the warning colour. When the filters hide every errand, the feed says so and offers **Clear
  filters**, which empties them and puts focus back on the first one; an invalid minimum reward is
  not sent, so it does not count as a filter.
- **History** (`/order-history`): `GET /orders/mine`, split into active and past. Each card shows the
  status, what it means for the student's part, their role, when it was posted, and until when it is
  open, when it last changed or when it ended. A complete errand links to its receipt. The list is
  read every 5 seconds while any errand is in a `*_PENDING_CREDIT` state, every 30 seconds while any
  is otherwise active, and on returning or reconnecting; it stops once every errand is final. *Load
  more requests* and *Load more errands* page each list, one at a time, and a mode change cancels a
  page still loading. Feed and history share this in `src/lib/use-paged-poll.ts` (#269). Switching
  mode, or changing a courier filter, keeps the last loaded screen up, as read for its mode, until the
  new lists arrive (`useKeptWhileLoading`), so no skeleton flashes between them; the kept screen
  dims, takes no input, and its *Load more* is off. A failed first read for the new mode still shows
  its error.
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
  every 30 seconds otherwise, pausing after 10 minutes without a change, and at once on returning or
  reconnecting.
- **Progress track** (`ErrandProgress`, on the errand page): the requester and courier see five
  stops, Posted, Accepted, In transit, Delivered and Complete, up to the one the errand has reached.
  An errand off that route (cancelled, expired, not placed, with an administrator, returning
  credits) has no track; its status wording says what happened. When a live update moves the errand
  on, the rail fills to the new stop, and an errand that completes while the page is open lands on
  the last stop once, showing the courier `+N`. It is an `<ol>` with `aria-current="step"` and
  screen-reader "done" and "not yet" text on each stop; reduced motion keeps the colour change and
  drops the movement.
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
  gone. A network or server failure stays in the dialog to try again. Each command sends an
  `Idempotency-Key`, and confirming it again at the same version, from the dialog or after closing
  it, sends the same one, so a send whose answer was lost is answered as done rather than refused.
  An administrator's dispute decision keeps its key the same way while its dialog is open.

Every state's label and plain-language explanation is in `src/lib/order-status.ts`, typed from the
generated contract so all twelve are covered.

### Live updates (N1.4)

Every page above polls, and still does. On top of that, each tab holds one live-update stream,
`GET /api/order/live` ([ADR 0011](../docs/adr/0011-live-updates.md)), so a change shows at once
instead of at the next poll. The stream sends nudges, never an errand: on one, a page reads again
through the endpoints above, under their rules.

| Page | Reads again on |
| --- | --- |
| errand page (`useOrder`) | `errand` for its errand at a newer version than shown; `board` while it is `ACCEPTED`, since a courier who withdrew or missed the pickup deadline is no longer named on it |
| feed, courier mode | `board`, after a random wait of up to a second, so open feeds do not all read at once |
| feed, requester mode; order history; wallet; the credits pill | any `errand` |
| all of them | `ready`, sent each time the stream (re)opens: the catch-up |

- `src/lib/live/sse.ts` parses the stream; `src/lib/live/connection.ts` keeps it open. It is read with
  `fetch`, not `EventSource`, which cannot send the `Authorization` header (a token in the URL
  would be written to the edge's log). It reconnects after 1, 2, 4, 8, then every 10 seconds,
  closes while the tab is hidden, and retries at once when the network is back. The stream's own
  refusals (`429`, `503 LIVE_UNAVAILABLE`) leave the page polling, asking again a minute later.
- `src/lib/live/live.tsx` is the `LiveProvider` in `(app)/layout.tsx` (the student's pages; the
  console polls) and `useLive`, which does nothing outside it.
- `LiveLabel` says *Live*, *Reconnecting…* or *Updating every 30 s* in every header: the top bar,
  the phone's app bar, and the errand page's own headers. Text, not only colour, as a polite status.
- Turned off on the server (`ORDER_LIVE_UPDATES_ENABLED=false`), every page behaves as before.

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
  the `web-app` build args in `compose.yaml` (the Dockerfile
  takes it as an `ARG`; setting it on a running container does nothing). Unset, a development build
  uses `http://localhost:3001`; a production build shows a configuration error on the account
  screens rather than calling localhost. The build itself still succeeds.
- `NEXT_PUBLIC_SUPPLIER_SERVICE_URL` is also inlined at build time. Local development defaults
  to `http://localhost:3002`; production builds require it. Rebuild after changing either service
  URL.
- **In Compose every service address is a path on the one origin** (`/api/user`, `/api/supplier`,
  `/api/order`, `/api/credit`, `/api/chat`): the edge in front of the stack routes each to its service
  ([ADR 0010](../docs/adr/0010-api-edge.md)), so the same image works on any host and port. To
  try the full stack, run `docker compose up --build` at the repository root, open
  `http://localhost:3000/suppliers`, and sign in. A web app run with `bun dev` calls each service
  on its own port instead, so each service must allow `http://localhost:3000` in `CORS_ORIGINS`.
- **The web app and the User Service must be same-site** (same registrable domain, e.g.
  `app.example.com` and `api.example.com`; the port does not matter, so `localhost:3000` and
  `localhost:3001` are fine). The refresh cookie is `SameSite=Strict`
  (`user-service/src/auth/cookies.ts`), so across sites the browser never sends it and every reload
  signs the user out. Note that each `*.vercel.app` subdomain is its own site. Behind the edge they
  are one origin, so this always holds; the edge serves the cookie at `/api/user/auth`, the path
  the browser sends it to. The User Service's `CORS_ORIGINS` must also list the web app's origin,
  which its sign-in checks.

### Activation email

The activation email is real: the User Service sends it over SMTP, and in the Compose stack it lands in
Mailpit's inbox at <http://localhost:8025>. Its link opens `/activate?token=…`, where the student
**chooses their password** (#309): sign-up asks for none, because whoever signs up has not yet proven
the inbox. Opening the link activates nothing; the form sends `POST /auth/activate` with the token and
the password (typed twice, checked by the reset page's rules), and leads to sign-in. Without a link,
or once the link's own token is refused (expired, or replaced by a newer email), the page asks for the
pasted code. A used link opened again says the account is already active and its
password unchanged, with a link to reset it. The activation and reset pages set
`Referrer-Policy: no-referrer`, since their address carries the token. Links last 30 minutes.
`/activate` also offers **Send a new link** (`POST /auth/activation/resend`) for an email that never
came or a link that expired or was replaced. Its confirmation reads the same whether or not the address
has an account, as the service's answer does.

### Password reset

**Forgot your password?** on `/login` opens `/forgot-password`, which asks `POST /auth/password-reset`
for a link and then says the same thing whatever the address. The emailed link opens
`/reset-password?token=…`: a new password and its confirmation, checked by the activation rules, then
`POST /auth/password-reset/confirm` and a link to sign in (it does not sign in by itself, as activation
does not). The reset also activates an account still waiting for activation, so when sign-up answers
that an address is taken, the page links to `/forgot-password?email=…`: a student whose address someone
else registered gets a link either way (#309).

### Tests

`bun test` runs the unit tests in `test/`: validation, error-envelope parsing, redirect safety, nav
ordering, the generated API client, `Field`'s accessibility wiring, generated files being current, the
design-token rules, the errand progress track's stops and states, and the session rules above (single-flight refresh, retry after `401`, which failures
sign out, pending sign-out, cross-tab sign-out) against a fake `fetch`, fake locks and a fake tab
channel. They use Bun's built-in runner, so `test/` is excluded from the Next typecheck. CI runs them
in the `web-app` job.

### Integration tests

`test/suppliers.integration.test.tsx` renders the supplier page against the real Supplier Service,
which verifies tokens with the real User Service. A fresh student (registered, then activated with the token from the
email Mailpit caught) browses the seeded suppliers and is refused `POST /suppliers` with
`403`; the seeded admin creates, edits and deletes a supplier through the page. It is skipped unless
`SUPPLIER_SERVICE_URL` is set, so a plain `bun test` passes without a stack.

```bash
# From the repository root: just the two services and what they need (PostgreSQL, RabbitMQ, Mailpit).
./scripts-init-env.sh   # if there is no .env yet
docker compose -p foc-it up -d --build user-service supplier-service

cd web-app
ADMIN_SEED_PASSWORD="$(grep '^ADMIN_SEED_PASSWORD=' ../.env | cut -d= -f2-)" \
  SUPPLIER_SERVICE_URL=http://localhost:3002 bun test test/suppliers.integration.test.tsx

docker compose -p foc-it down -v   # from the repository root
```

Run the file on its own: the page's client reads its base URL when it is first imported, and another
test file may import it first. `USER_SERVICE_URL` defaults to `http://localhost:3001`, and `MAILPIT_URL`, where the
activation email is read, to `http://localhost:8025`.

The admin is `ADMIN_EMAIL` (default `admin@u.nus.edu`). On a fresh stack the test claims it, replacing
the bootstrap `ADMIN_SEED_PASSWORD` with `ADMIN_PASSWORD` (default `supplier-integration-admin`), as an
operator must before that account can sign in; later runs sign in with `ADMIN_PASSWORD`. Against your
own long-lived stack, set `ADMIN_PASSWORD` to the admin's current password, or the test will claim the
account with its default. Each run leaves a new student account behind and deactivates the supplier it
created.

CI runs it in the `Supplier listing integration` job when `supplier-service/`, the supplier page, its
client (`src/lib/supplier-*`, `SupplierCard`), the test itself, or anything shared or stack-wide changes
(`scripts-ci-detect.sh`).

The services run on ports 3001–3004 and 3006 (chat), with Grafana on 3005 — see the root
[README](../README.md). Every
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
| Errands | Disputes: `GET /admin/orders/referred`, and `GET /admin/orders/decisions` for the latest decisions. One dispute (`/admin/errands/{orderId}`): `GET /orders/{orderId}?view=private`, which only the referred administrator is given, and `POST /admin/orders/{orderId}/resolve` with a reason (ORD-11, #271). Also `GET /admin/orders/pending-credit` and `GET /admin/orders/reconciliation-attempts` |
| Wallets | `GET /admin/wallets/{userId}` and its ledger (Credit Service; read-only, every read recorded) |
| Operations | Dead letters on either service: `GET /admin/dead-letters`, one with `GET /admin/dead-letters/{id}`, and `POST /admin/dead-letters/{id}/redrive` with a reason. An errand's trace: `GET /admin/orders/{orderId}/timeline` (Order Service) and `GET /admin/orders/{orderId}/credit` (Credit Service). Operator alerts: `GET /admin/orders/alerts` (PLT-05, #154) |

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
address: inlined at build time, with `http://localhost:3003` and `:3004` as the development defaults,
and `/api/order` and `/api/credit` behind the edge in Compose. `NEXT_PUBLIC_GRAFANA_URL` is the
Operations page's Grafana link, `http://localhost:3005` by default; Compose sets it from
`GRAFANA_PORT`.

**Changing a password.** `/change-password` asks for the current one (`POST /auth/password`), and every
session then ends. Sign-in sends a bootstrap administrator there first (`PASSWORD_CHANGE_REQUIRED`).

## Deployment

The web app is deployed with the rest of the stack, in local containers (`docker compose up`, see
the [repository README](../README.md#6-run-the-whole-stack-in-docker)). That is the D4 deployment
mode. There is no hosted deployment: the Vercel workflow was removed in
[PLT-11 #286](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/286), because a hosted web app
had no hosted back end to call, and its `SameSite=Strict` refresh cookie is not sent across sites.

## Participant chat (N1.2, #161)

An errand's detail page has one `ChatPanel` and one `useChat` lifecycle across all widths:
collapsible with unread count at 360px, expanded below the details at 768px, and beside details and
history at 1440px. Drafts survive resizing. The admin errand page independently asks the Chat Service
for the same history in read-only mode, even when the Order Service refuses private errand details.
The Chat Service decides authorization; console reads never send or mark read. The admin view
fetches once and has a Refresh conversation button instead of a recurring timer, including after
transient errors. Order revisions, tab return and reconnect still refresh its history.

`src/lib/chat-api.ts` uses generated `chat-service` contract types and the shared authentication,
timeout, correlation and error handling. Set **NEXT_PUBLIC_CHAT_SERVICE_URL=/api/chat at build time**
for deployments behind the edge; Compose and the Dockerfile pass it through. Local development
without that setting uses `http://localhost:3006`. Errors retain response headers, including
`Retry-After`, for rate-limit feedback.

Messages merge by channel `seq`; optimistic sends carry a browser UUID `clientId`. A retry preserves
that UUID and the exact original body, and both 200 replays and 201 creations confirm it. Failed sends
remain visibly failed. Validation counts 1–280 Unicode code points and rejects whitespace-only text.
Two-second polling pages `after` until caught up, including on reconnect; older history uses `before`.
The fetch cursor advances only through GET pages, so a send cannot skip concurrent incoming messages.
Initial reads also fetch every unread message, even beyond the latest history page. Metadata refreshes
pick up reads made on another device. Timed polling stops when closed; order revisions and returning
online recheck availability.

A participant's panel on an open channel also holds the Chat Service's notify-only socket (#346,
ADR 0012; contract in `chat-service/README.md`, "The socket"). `src/lib/chat-socket.ts` connects to
`${NEXT_PUBLIC_CHAT_SERVICE_URL}/socket` on `ws:`/`wss:` and signs in with the first frame, never
the URL. `ready` reads once and slows polling to a 30 s backstop; a `messages` nudge reads only
when its `latestSeq` is past the panel's. A `4401` refreshes the token through the session and
reconnects. Any other close, or a socket the network blocks, returns to two-second polling at once
and reconnects on the live stream's 1–10 s backoff. The socket closes while the tab is hidden and
retries at once when the network is back. The edge's `connect-src 'self'` allows the same-origin
socket in Chromium and WebKit.

Unread counts exclude your own messages. Read positions advance only for a visible, expanded
conversation at the bottom of its scroll area, using messages fetched through GET. New messages
follow automatically while at the bottom; otherwise a New messages button returns there. Loading
older messages preserves the scroll offset. A 404 hides unavailable chat; a closed channel keeps its
history readable. Final errands, closed channels and CHANNEL_CLOSED responses disable sending with
a reason. Account/order changes replace all private state and stale async responses are ignored.

`test/chat-state.test.ts` covers paging, merges, reconciliation, retries, read positions, access,
closure and identity cleanup. `test/chat-socket.test.ts` covers the auth frame, nudges, every close
code, backoff and the `4401` refresh. `test/chat-panel.test.tsx` uses Happy DOM for responsive
lifecycle, read visibility, nudged reads and the fall back to polling. `e2e/chat-journey.e2e.ts`
runs only in the dedicated release suite at every width: send/receive in two sessions within 1 s
over the socket, and again with one socket blocked, on polling; offline catch-up, outsider refusal
and final-state closure. Run the real stack with `./scripts-e2e-release.sh --twice` from the
repository root; it requires Docker and sets `E2E_RELEASE=1`. Ordinary smoke runs skip this journey
to stay within their shared login limits.
