# Nice-to-have features

What Group 30 builds beyond the four core services: the problem each feature addresses, its value
to Friend on Campus, its design and how it joins the rest of the application, and who is
responsible ([DOC-03 #237](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/237); D3
instructions, Part 5). The same allocation is presented again at the final presentation.

Five features, chosen to deepen the errand and credit workflows rather than to add breadth. Three
are built or in review; two are built in Sprint 4.

| Feature                                         | Owners                    | State on 13 Oct                                         |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| N1.1 Admin operations and dispute console       | Jonus, Anselm, Zhang Yuan | In review: #226, #228, #229                             |
| N1.2 Participant chat                           | Patrick, Zhang Yuan, Anselm | Sprint 4. Design proposed below, not yet agreed       |
| N3.1 Concurrency, load and conservation evidence | Isaac                    | Merged (#165)                                           |
| N3.2 Automated credit reconciliation            | Isaac                     | Merged (#152)                                           |
| N4.1 CI/CD pipeline                             | Jonus                     | CI merged (#118); build, scan and publish in Sprint 4 (#164) |

> **Status of this page.** The N1.1 and N4.1 sections are written by their owner. The N3.1 and N3.2
> sections describe what is merged, from the code and its documentation, for Isaac to confirm. The
> N1.2 section is a **proposal** drawn from the three chat tickets and the existing architecture;
> its owners have not agreed it. The team has not yet signed the page off.

## N1.1 Admin operations and dispute console

**Problem.** A closed credit economy needs someone who can suspend an abusive account, decide a
disputed delivery and deal with a message the system could not process. Without tooling those are
database edits: unaudited, easy to get wrong, and a way to move credits by hand.

**Value.** Support work is done through the same rules as everything else. An administrator can
act, but cannot edit a wallet, cannot change their own role, and leaves a record of everything.

**Design.**

- A console in the web app (`/admin`) with seven areas: users, role requests, the audit log,
  activity alerts, wallets (read-only), errands, and operations.
- Controls on administrators themselves
  ([ADR 0008](adr/0008-controlling-administrators.md)): a role change needs a second administrator
  to approve it, the riskiest actions need the password again, and unusual activity (many
  suspensions, many account or wallet reads in an hour) raises an alert.
- A disputed delivery is referred to one administrator, who decides it for the courier or the
  requester. The decision is a state transition in the Order Service like any other, and the
  credits move through the same transfer or release.
- Operations: every message that failed all its retries is kept as a dead letter with its reason,
  shown in the console, and can be redriven once its cause is fixed. A dashboard shows latency,
  queues, retries and firing alerts.

**Integration.** The console holds no data and has no back end of its own. Each area calls the
service that owns the data, with the administrator's token: the User Service for accounts, roles
and the audit log; the Order Service for errands, disputes and its dead letters; the Credit
Service for wallet reads and its dead letters. Each service checks the `ADMIN` role itself, by
asking the User Service who the caller is. Nothing in the console can change a balance.

**Owners and how the work is shared.**

| Owner      | Part                                                                                       | Tickets                              |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| Jonus      | The console, the controls on administrators, the wallet-read alert, dead letters and redrive, the dashboard | #218-#221 (ADM-01 to 04), #154, #235 |
| Anselm     | The User Service side: admin endpoints, the audit log and its filters, log privacy          | #156                                 |
| Zhang Yuan | Dispute referral and the administrator's decision; one account's errands for the console    | #171, #233                           |

**State.** Console and controls: #226. Operations and redrive: #228. Referral and decision: #229.
All in review. One account's errands (#233, #235) follows.

## N1.2 Participant chat

**Problem.** Once a courier accepts an errand, the two students have no way to say "the stall is
closed" or "I am at the wrong lobby" inside the application. They would swap phone numbers, and a
later dispute would have no record of what was agreed.

**Value.** The requester and the courier can coordinate an errand without sharing contact details,
and what they said is kept with the errand for an administrator reviewing a dispute.

**Proposed design.** Not yet agreed by the owners.

- **Scope.** One channel per errand, between its requester and its assigned courier. Text only: no
  voice, video, attachments or translation.
- **Its own service and container**, `chat-service`, with its own database and role
  (`foc_chat`), broker account and internal key, like the other four
  ([README, "One service, one of everything"](../README.md#one-service-one-of-everything)).
- **Transport.** A WebSocket for live messages, and an HTTP endpoint to page through history, which
  is also how a client catches up after reconnecting.
- **Lifecycle.** A channel opens when its errand becomes `ACCEPTED` and closes at any terminal
  state. Chat learns both from the Order Service's `order.status-changed` event, which it consumes
  through its own queue. The event carries the errand's version, so a late or repeated event
  cannot reopen a closed channel. No message and no chat action can change an errand's state.
- **Authorization.** The caller is identified exactly as in the other services, by asking the User
  Service. Whether the caller is a participant is the Order Service's rule (OS-FR2.1.2), not a
  second copy of it: chat asks the Order Service who the requester and courier of the errand are.
  Only they may send, and only while the channel is open; they and an administrator may read.
- **Retention and limits.** Messages are kept with the errand for dispute review, for a period the
  owners still have to set. Sending is rate-limited per participant.

**Integration.** Chat consumes one event from the Order Service and calls one internal endpoint
on it. It publishes nothing the other services depend on, so the errand and credit workflows are
unaffected if it is down. In the web app it is a panel on the active-errand view.

**Open questions for the owners.** Whether chat is a fifth service or a module of the Order
Service; the retention period; the rate limit; whether `order.status-changed` gains its first
durable consumer here (it then joins the events that must reach a consumer); and how an
administrator reads a channel from the console.

**Owners and how the work is shared.**

| Owner      | Slice                                                                 | Ticket | Size |
| ---------- | --------------------------------------------------------------------- | ------ | ---- |
| Patrick    | The chat panel, paging on reconnect, unread state, responsive layout  | #161   | L    |
| Zhang Yuan | Channel lifecycle bound to the errand; messages kept with the errand  | #162   | M    |
| Anselm     | Who may read and send, retention, rate limiting                       | #163   | M    |

**State.** Sprint 4. No code, contract or decision record yet.

## N3.1 Concurrency, load and credit-conservation evidence

**Problem.** "Credits are never created or lost" and "only one courier can accept" are claims
about every interleaving of requests and messages, not about the cases someone thought to write a
test for.

**Value.** The invariants that make the credit economy trustworthy are checked by a machine
against thousands of generated sequences, with messages dropped and duplicated, and the result is
a dated report anyone can reproduce.

**Design.** A `system-tests` package runs the real Order and Credit code together, on their own
PostgreSQL databases, over a broker that can drop, duplicate and reorder deliveries.

- A property-based test generates random errand lifecycles from a seed and checks after every
  step: no balance is negative, every ledger transaction balances, credits held equal credits
  issued, each errand is reserved at most once and has at most one outcome.
- Race tests: 100 couriers accepting one errand at once, of whom one succeeds and is paid; a
  transfer and a release arriving together for one reservation, of which exactly one wins;
  concurrent reservations that must not overspend one wallet.
- A broker-replay test and a fault matrix: each message lost or repeated at each step.
- `npm run report:conservation` writes the report
  ([the run of 1 Oct](reports/credit-conservation-2026-10-01.md): 20 seeds of 150 steps, 804
  errands, 10% of deliveries dropped and 15% duplicated, every invariant held).

**Integration.** It tests the services through their own code and contracts and adds nothing to
them at run time. The bounded suite runs in CI on every pull request that touches a service or
shared code.

**Owner.** Isaac (#165). Merged.

## N3.2 Automated credit reconciliation

**Problem.** Order and Credit agree by exchanging messages. If a request or a reply is lost for
good, an errand waits for ever in a "pending credit" state: the requester's credits stay
reserved, or the courier is never paid.

**Value.** A stuck errand repairs itself without an operator, and one that cannot be repaired
safely is reported instead of guessed at.

**Design.** A job in the Order Service runs on an interval and looks at errands that have waited
on Credit longer than the limit. For each it asks the Credit Service what it has recorded for that
errand, and either sends the request again or raises one operator alert when the two services
disagree in a way a resend cannot fix.

- Resending is the only repair. Credit applies each operation at most once per errand and answers
  a repeat with its recorded result, so the job can never move credits twice.
- The job changes no errand and no balance itself. Each decision is recorded in an append-only
  table, under the errand's lock, so two runs at once act once.
- If Credit cannot be reached, nothing is repaired and the attempt is recorded as such.

**Integration.** It uses Credit's read-only internal endpoint, with the Order Service's own key,
and the same events as the normal workflow. Administrators see recent decisions and alerts in the
console (N1.1). `system-tests` shows every lost request or reply converging with exactly one
Credit transaction.

**Owner.** Isaac (#152). Merged.

## N4.1 CI/CD pipeline

**Problem.** Five people merge into one repository of four services, a web app and shared code. A
change that breaks another service, a contract, the container setup or a secret rule has to be
caught before it merges, not on demo day.

**Value.** `main` always builds, starts and passes its own demo. Every image can be traced to a
commit and rebuilt.

**What exists** (PLT-03, #118, extended by later tickets). On every pull request:

- a path filter runs only what a change can affect, and fails closed for a path it does not know;
- lint, format, typecheck, and each service's and shared package's tests, with a real PostgreSQL
  and RabbitMQ for the integration suites;
- a contract check: a breaking change to an API or event contract against `main` fails;
- each changed service's image is built;
- on a Compose stack: a secret scan of the repository and the built images, the smoke test, the
  failure demo, the restart check and the demo journey.

**Planned** (NTH-04, #164, Sprint 4).

- **Scan.** Trivy over each built image and the dependency lockfiles. A critical vulnerability
  with a fix available fails the pull request, as a failed test does (PL-NFR4.1.2).
- **Publish.** On a merge to `main`, each service's image is pushed to the GitHub Container
  Registry, tagged with the commit and `main`.
- **Cache.** Image layers are cached between runs, so an unchanged service is not rebuilt.
- **The demo commit.** The final demonstration commit is tagged, and its images are recorded by
  digest, so the stack that was demonstrated can be pulled and started again exactly.

**Integration.** The pipeline is what the Compose setup already assumes: base images pinned to a
digest, secrets generated and never committed, and each service built from its own Dockerfile so
one can be built, scanned and published without the others. Deployment stays local Compose, which
is the mandatory scope; the published images are what a hosted deployment would start from.

**Owner.** Jonus (#118, #164).

## Does every member carry a feature's worth?

The rule is at least one nice-to-have feature's worth of implementation each, on top of a core
service.

| Member     | Core service            | Nice-to-have work                                                     |
| ---------- | ----------------------- | --------------------------------------------------------------------- |
| Anselm     | User                    | N1.1 User Service side (#156); N1.2 authorization and retention (#163) |
| Patrick    | Supplier, web app       | N1.2 the chat interface (#161)                                        |
| Zhang Yuan | Order                   | N1.1 dispute referral and decision (#171, #233); N1.2 lifecycle (#162) |
| Isaac      | Credit                  | N3.1 evidence (#165); N3.2 reconciliation (#152)                      |
| Jonus      | Integration and platform | N1.1 console, controls and operations; N4.1 pipeline (#164)          |

Every member owns part of at least one feature. Two points for the team to settle before D3:

- **Chat is one feature in three slices.** Patrick's is the largest and is his only nice-to-have.
  Anselm and Zhang Yuan each also hold a part of N1.1. Whether each chat slice is a feature's
  worth on its own is a judgement the three owners should make together; if not, the split to
  revisit is between the lifecycle (#162) and authorization (#163) slices.
- **Isaac's two are already merged.** Nothing further is planned for him in Sprint 4 under a
  nice-to-have.

## Considered and not selected

The scope above is final. These were considered for D1 and set aside, so that the mandatory
product and the five features above are finished rather than more being started
([execution plan](EXECUTION-PLAN.md), "Deferred"):

| Considered                                             | Why not                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| AI: natural-language or voice errand composition, RAG  | Novel, but adds no assurance to the errand or credit workflow     |
| Translation and third-party moderation of chat         | Sends students' messages to an outside service                    |
| Route maps and navigation                              | An errand already names the supplier's building and the drop-off  |
| Grouped runs (one courier, several errands)            | Changes the errand and credit model the core services depend on   |
| Voice and video calls                                  | Text is enough to coordinate a handover                           |
| Kubernetes, autoscaling, cloud hosting                 | Local Compose is the mandatory scope; nothing here needs more     |

## For the D3 slides

Two slides, drawn from this page.

**Slide 1: what and why.**

| Feature                         | The problem it solves                                         |
| ------------------------------- | ------------------------------------------------------------- |
| Admin and dispute console       | Support without database edits; admins are controlled too      |
| Participant chat                | Coordinating an errand without swapping phone numbers          |
| Conservation evidence           | "Credits are never created or lost", checked by a machine      |
| Credit reconciliation           | An errand stuck between Order and Credit repairs itself        |
| CI/CD pipeline                  | `main` always builds, starts and passes its own demo           |

**Slide 2: who and when.** The table at the top of this page, with one line each on how the
feature joins the application: the console calls each service's own admin endpoints; chat
consumes one Order event and asks Order who the participants are; the evidence suite runs the real
Order and Credit code; reconciliation reads Credit and resends; the pipeline builds each service
from its own Dockerfile.
