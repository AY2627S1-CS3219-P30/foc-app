# Accessibility and web vitals, 2026-11-03

TST-03, [#166](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/166), the web part of the
22 Oct split: accessibility (UI-NFR2.1.1, UI-NFR2.1.2) and Lighthouse LCP/INP and feedback latency
(UI-NFR3.1.1, UI-NFR3.1.2). The load and latency targets are in
[the report of 29 Oct](load-2026-10-29.md). Measured from commit `7ca335e` plus the changes this
report ships with.

- **Machine:** Apple M5, macOS 26.5.1; Docker with 10 CPUs and 7.7 GiB. Browser and stack share it.
- **Browser:** Playwright 1.56.1's Chromium 141 (headless), for both Playwright and Lighthouse.
- **Web app:** the Compose image, a production build (`next build`, `NODE_ENV=production`, checked
  by the script before it measures).
- **Stacks:** Compose projects of their own, never `foc`. The browser specs ran on `foc-a11y-166`
  (the release runner's environment on ports 15500+). Lighthouse ran on `foc-lighthouse` (ports 14600+),
  started from empty volumes by its script.

## Reproduce

```bash
# axe and the keyboard journey: in the release suite, so CI runs them on every pull request
./scripts-e2e-release.sh --once
# or just these specs, against a release-style stack already up (E2E_RELEASE=1 and its E2E_* URLs)
(cd web-app && bunx playwright test e2e/accessibility.e2e.ts e2e/keyboard-journey.e2e.ts)

# The 3:1 token checks
(cd web-app && bun test test/contrast.test.ts)

# Lighthouse: builds and starts foc-lighthouse, seeds it, three mobile runs per screen.
# The results go under .lighthouse-results/<time>/ (git-ignored): every flow result and summary.json.
./scripts-lighthouse.sh
./scripts-lighthouse.sh --stop
```

The whole release suite, these specs included, also passed once from clean volumes on
`foc-a11y-166`: **57 passed; zero failures, flakes, skips or runner errors** (3.8 min). That is
the release runner's own check.

## Automated accessibility scans (UI-NFR2.1.1)

`web-app/e2e/accessibility.e2e.ts` runs axe-core 4.11 (`@axe-core/playwright`) with the
`wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` rules plus `best-practice`, which holds the
landmark and heading rules. It runs at 360, 768 and 1440 px. The release suite allows no skipped
test, so 768 px runs too. Each screen is scanned once its content has loaded.

- **Student screens:** a requester and a courier walk one errand through, so every screen holds
  real data. The change-password page is scanned last.
- **Admin console:** every page, plus one account and one errand.

The test scans every screen first and asserts at the end. It fails on any finding, at any
impact. Each screen's findings are attached to the test result.

Counts are axe rules violated (a rule may flag several elements). The columns give 360 / 768 / 1440 px.

| Screen                                         | Before                                             | After     | Rules before the fix                                    |
| ---------------------------------------------- | -------------------------------------------------- | --------- | ------------------------------------------------------- |
| Feed, as requester                             | 3 moderate / 1 moderate / 1 moderate               | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Feed, as courier (the board)                   | 3 moderate / 1 moderate / 1 moderate               | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Composer: pickup point                         | 1 moderate each                                    | 0 / 0 / 0 | region                                                  |
| Composer: details                              | 1 moderate / 1 serious + 1 moderate / 1 serious + 1 moderate | 0 / 0 / 0 | **color-contrast** (serious), region           |
| Composer: review                               | 1 moderate / 1 serious + 1 moderate / 1 serious + 1 moderate | 0 / 0 / 0 | **color-contrast** (serious), region           |
| Active errand, requester (open)                | 3 moderate each                                    | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Active errand, courier (accept dialog open)    | 0 each                                             | 0 / 0 / 0 |                                                         |
| Active errand, courier (accepted)              | 3 moderate each                                    | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Active errand, requester (delivered)           | 3 moderate each                                    | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Errand, requester (complete)                   | 3 moderate each                                    | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Receipt                                        | 3 moderate each                                    | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Wallet                                         | 1 moderate each                                    | 0 / 0 / 0 | region                                                  |
| History                                        | 3 moderate / 1 moderate / 1 moderate               | 0 / 0 / 0 | landmark-one-main, page-has-heading-one, region         |
| Suppliers                                      | 1 moderate each                                    | 0 / 0 / 0 | region                                                  |
| Profile                                        | 1 moderate each                                    | 0 / 0 / 0 | region                                                  |
| Admin: each of overview, users, account, role requests, audit trail, admin activity, errands, errand, wallets, operations | 1 moderate each | 0 / 0 / 0 | region |

The "before" run was on the same stack at the same commit, before the fixes below. Its account
page was scanned with a malformed account id (the spec read a field the list does not return), so
it scanned the page's error state. The "after" run scanned a real account. Totals: **0 critical**
before and after; **2 serious** (one rule on two screens, at 768 and 1440 px) before and 0 after;
every moderate finding fixed. 75 screen scans in the final run (25 screens at three widths)
report nothing at any impact. The change-password page (a 26th screen, 78 scans) was added to the
spec after that run and has not been measured yet.

### What was fixed

- **Text contrast** (serious). `--color-text-subtle` (`#64748b`) is 4.76:1 on a white surface but
  4.34:1 on the page background (`#f1f5f9`). The details and review rows' labels and the field
  hints sit on the page from 768 px. It is now `#5f6d81`: 5.26:1 on the surface and 4.80:1 on the
  page. The colour barely changes (`web-app/src/styles/tokens.ts`; `tokens.css` regenerated).
- **Landmarks and headings** (moderate):
  - The phone app bar (`AppBar`), the desktop top bar (`TopBar`) and the errand and receipt
    headers (`ScreenHeader`, `DesktopPanel`) are now `<header>`.
  - The phone content area (`ScreenContent`) and the errand panel's body are now `<main>`.
  - The errand and receipt titles are `<h1>`. On the phone feed and history, the app bar's title
    is the `<h1>` (`AppBar heading`). Pages in `ResponsiveShell` already had one.
  - Styling is unchanged: same classes, and the global reset already zeroes heading margins.

## Contrast (UI-NFR2.1.1)

Text at 4.5:1 is checked on the rendered screens by axe's `color-contrast` rule, above.

axe does not check the 3:1 that WCAG 1.4.11 asks of non-text UI. `web-app/test/contrast.test.ts`
computes it from the design tokens, with the WCAG 2.1 formula. The app has one theme (there is no
dark mode), so each pair is checked once. The test also re-checks the text tokens at 4.5:1 on the
backgrounds they sit on.

| What is drawn                                        | Token on background             | Ratio   | Needs |
| ---------------------------------------------------- | ------------------------------- | ------- | ----- |
| Text field, select and text area border              | `controlBorder` on `surface`    | 3.50:1  | 3:1   |
| The same on a phone screen's page                    | `controlBorder` on `page`       | 3.19:1  | 3:1   |
| Invalid field border                                 | `danger` on `surface`           | 6.47:1  | 3:1   |
| Focus ring, on the page / on a card                  | `primary` on `page` / `surface` | 9.29:1 / 10.18:1 | 3:1 |
| Focus ring and icons (☰ ← +) on the phone app bar    | `onPrimary` on `primary`        | 10.18:1 | 3:1   |
| Select chevron                                       | `textMuted` on `surface`        | 7.58:1  | 3:1   |
| Chosen option in the mode switch, against its track  | `primary` ring on `border`      | 8.25:1  | 3:1   |
| Selected filter chip against an unselected one       | `primary` on `border`           | 8.25:1  | 3:1   |
| Slider thumb and filled track (`accent-color`)       | `primary` on `surface`          | 10.18:1 | 3:1   |
| Back arrow and list chevrons                         | `text` on `surface`             | 17.85:1 | 3:1   |

Fixed:

- **Field borders.** Every field drew its border in `--color-border` (`#e2e8f0`), 1.23:1 on white.
  For an empty text field, that border is the only sign the field is there. A new token,
  `--color-control-border` (`#7c8aa0`), now draws only the controls (`Control.module.css`).
  Cards and dividers keep the light `--color-border`: they are decorative, and WCAG does not
  require them to stand out.
- **Mode switch.** The chosen option was a white pill on a `#e2e8f0` track, 1.23:1. It now also
  has a 1px `primary` inner ring (`ModeSwitch.module.css`).

Not changed, by WCAG's own exceptions:

- The `subtle` and `outline` buttons have low-contrast fills and edges, but their text names
  them, and a text label is enough to identify a control.
- The unfilled part of the native range track is drawn by Chromium, not by a token.

## Keyboard-only errand journey (UI-NFR2.1.2)

`web-app/e2e/keyboard-journey.e2e.ts` runs once per width. Only `page.keyboard` drives the
pages: Tab, Enter, Home and the arrow keys. There is no `click()` and no `fill()`. Every focus stop
on the way is checked for a visible outline. The Tab helpers moved from the account journey into
`e2e/keyboard-helpers.ts`, unchanged, and both specs use them.

1. **Sign in** through the form.
2. **Compose:** Tab to New request; type the pickup point into the search and Tab to it; type the
   item, delivery zone and instructions; set the credits slider with Home and the arrow keys;
   review; post.
3. **Accept:** a courier Tabs to the errand's Accept on the board, opens it with Enter and
   confirms in the dialog. Focus is checked on the dialog's button.
4. **Pickup and delivery:** the courier records each by Tab, Enter and confirm.
5. **Confirm receipt:** the requester Tabs to Confirm receipt and confirms. This dialog opens on
   Go back, so the test Tabs to the confirm button.
6. **Wallet review:** Tab to View receipt, then See it in your wallet. The payment row has focus
   and reads "Paid your courier".
7. **No focus trap:** from there, Tab never stays on one element and comes back round the page.

**Result: passed at 360, 768 and 1440 px.** Each run took 4.2 to 4.9 s. No keyboard trap or
unreachable control was found, so the web app needed no keyboard fix.

## Feedback within 100 ms (UI-NFR3.1.2)

The keyboard journey times each submit and state change inside the page:

- **Start:** a capture-phase listener records the keydown's `timeStamp`.
- **Change:** a `MutationObserver` catches the control going disabled or away (e.g. "Posting…",
  "Working…") or a dialog opening.
- **End:** the time taken at the next animation frame plus one task, which approximates the frame
  that shows the change.

The test runner's own latency is not counted. The test fails above 100 ms. Times from the final
run, at 360 / 768 / 1440 px:

| Action                                | 360 px  | 768 px  | 1440 px |
| ------------------------------------- | ------- | ------- | ------- |
| Post request (button → "Posting…")    | 13.2 ms | 8.9 ms  | 8.0 ms  |
| Accept on the board (dialog opens)    | 5.6 ms  | 9.4 ms  | 13.8 ms |
| Confirm Accept                        | 9.0 ms  | 7.9 ms  | 8.9 ms  |
| I've picked it up (dialog opens)      | 9.3 ms  | 8.0 ms  | 9.2 ms  |
| Confirm Record pickup                 | 9.5 ms  | 7.4 ms  | 9.3 ms  |
| Mark as delivered (dialog opens)      | 4.4 ms  | 2.6 ms  | 4.4 ms  |
| Confirm Record delivery               | 9.0 ms  | 4.6 ms  | 9.1 ms  |
| Confirm receipt (dialog opens)        | 10.3 ms | 9.4 ms  | 3.2 ms  |
| Confirm Confirm receipt               | 4.5 ms  | 12.2 ms | 10.0 ms |

Every one is within 100 ms; the slowest is 13.8 ms. These figures are from desktop-class hardware
without CPU throttling. The Lighthouse INP figures below are the same kind of interaction latency
measured under 4x CPU slowdown.

## Lighthouse, mobile (UI-NFR3.1.1)

Targets: median LCP ≤ 2.5 s and median INP ≤ 200 ms, across three lab runs per core screen on a
mobile profile (D1 backlog).

- **Tool:** `./scripts-lighthouse.sh`, which runs `web-app/scripts/lighthouse.mts` with Lighthouse
  13.5.0 and puppeteer-core 25.12.0. Each run is a Lighthouse **user flow** in a fresh Chromium
  profile, so nothing is cached and there is no service worker.
- **LCP, CLS, TBT:** the flow's navigation step. Lighthouse's default mobile settings: an emulated
  412 px phone, and *simulated* slow 4G (150 ms RTT, 1.6 Mb/s) with 4x CPU slowdown.
- **INP:** a navigation has no INP, so a *timespan* step follows, around real input on the loaded
  page: typing into a field, or opening a dialog and pressing Escape. Lighthouse applies DevTools
  throttling there (4x CPU slowdown); each result records this in its `configSettings`. TBT is
  not used as a proxy.
- **Signed-in screens:** the session is a refresh cookie from an API sign-in, set on the browser
  before the load, as a returning student has it. Lighthouse's storage reset is off so the cookie
  survives. The script fails if a screen lands on `/login`.
- **Seeded data:** a requester with one completed errand, one accepted and five open, and a courier
  (see Exceptions).

| Screen (who)                         | Path               | LCP, runs 1 / 2 / 3 (ms) | Median LCP | INP, runs (ms) | Median INP | Median TBT | Median CLS | LCP target |
| ------------------------------------ | ------------------ | ------------------------ | ---------- | -------------- | ---------- | ---------- | ---------- | ---------- |
| Sign in (signed out)                 | `/login`           | 2173 / 2173 / 2168       | **2173**   | 38 / 37 / 52   | **38**     | 5 ms       | 0.000      | Met        |
| Feed, courier board (courier)        | `/feed`            | 2506 / 2647 / 2647       | **2647**   | 56 / 58 / 53   | **56**     | 8 ms       | 0.000      | Missed     |
| Composer, pickup point (requester)   | `/request/new`     | 2642 / 2493 / 2645       | **2642**   | 38 / 38 / 38   | **38**     | 8 ms       | 0.000      | Missed     |
| Active errand (requester)            | `/request/:id`     | 2580 / 2582 / 2575       | **2580**   | 55 / 55 / 56   | **55**     | 9 ms       | 0.000      | Missed     |
| Wallet (requester)                   | `/wallet`          | 2674 / 2646 / 2638       | **2646**   | 51 / 53 / 56   | **53**     | 8 ms       | 0.000      | Missed     |
| History (requester)                  | `/order-history`   | 2643 / 2496 / 2795       | **2643**   | 56 / 60 / 46   | **56**     | 6 ms       | 0.000      | Missed     |
| Admin console, users (administrator) | `/admin/users`     | 2890 / 2891 / 2740       | **2890**   | 38 / 38 / 41   | **38**     | 9 ms       | 0.000      | Missed     |

**INP: met on every screen** (worst median 56 ms, against 200 ms). **CLS: 0 everywhere.**
**LCP: met on sign-in only.** Every signed-in screen is 80 to 390 ms over 2.5 s; see Exceptions.

## Exceptions

1. **LCP on signed-in screens: missed by 80 to 390 ms (UI-NFR3.1.1).** Two costs add up.
   - **The JavaScript, on every screen.** Sign-in makes no API call, and its largest element (the
     `NUQueSt` logo) is in the server's HTML. Its LCP is still 2173 ms against a 920 ms FCP. Under
     simulated slow 4G (150 ms RTT, 1.6 Mb/s, 4x CPU), Lighthouse's model puts the page's script
     chunks on the path to that paint: the observed paint came after they ran.
   - **The session chain, on signed-in screens.** These screens add 400 to 720 ms on top.
     - Their server HTML holds only "Loading your account…". Their content renders in the browser
       after three serial calls, which start once the JavaScript has run:
       1. the cold-load refresh (`/api/user/auth/refresh`);
       2. the account read (`/users/me`), which `lib/auth.tsx` waits for before it shows the screen;
       3. the screen's own data.
     - On the feed, composer, wallet and history, the largest element is data from that last call:
       an errand card, a supplier name, a ledger row. On the console it is static section text that
       still waits for the first two calls.

   Server time is not the problem: TTFB is under 10 ms, the observed element render delay is 60 to
   160 ms, and TBT is under 15 ms.

   Cutting one call from the chain, for example by having the refresh return the account, would
   save roughly one 150 ms round trip. That would bring most screens to about 2.43 to 2.50 s; the
   console (2890 ms) would still miss. Meeting the target with margin means one of two things:
   - render the signed-in screens on the server;
   - take most of the JavaScript off the path to the first paint.

   Either changes the session contract between the User Service and the web app (PLT-10), or the
   app's rendering model, which is beyond this ticket. The miss is recorded here, not hidden.
2. **"The agreed seeded dataset" (UI-NFR3.1) is not defined anywhere in the repository.**
   - **Used:** each run seeds its own small, fixed set: one requester with one completed, one
     accepted and five open errands; one courier; the catalogue's default suppliers.
   - **Why it matters:** larger data would lengthen the last hop above, not shorten it.
   - **To do:** fix the dataset in the backlog, and seed it in `seed()` in the script.
3. **Lighthouse's stack uses development services.** `scripts-lighthouse.sh` runs the services in
   development so that activation mail reaches Mailpit, and raises the sign-in limits
   (`compose.load.yaml`), since every run signs in again. The **web app** is still the production
   image, and the script checks that. Neither setting changes what the browser loads.
4. **Feedback latency is measured without CPU throttling.** That measurement times the keyboard
   journey's actions on the test machine's own CPU. INP above covers the same kind of interaction
   on the throttled mobile profile.
5. **The "before" scan of `/admin/users/:id`** scanned the page's error state (see the axe section).
