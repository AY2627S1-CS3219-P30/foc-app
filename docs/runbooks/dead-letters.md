# Dead letters: find, fix, redrive (PLT-05, #154)

A **dead letter** is an event a service could not apply, set aside for an operator instead of being
retried forever or lost. Two services consume events, and each keeps its own:

| Service | Its dead letters are                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------- |
| Credit  | `user.activated` (a new student's wallet), and the Order Service's reserve, transfer and release requests |
| Order   | the Credit Service's answers to those requests, and `user.suspended` (a suspended user's errands)         |

Each service drains its own `.dlq` queues into a `dead_letters` table in its own database. A dead
letter is therefore kept and searchable, and never lost to a queue purge. Its row cannot be deleted
and changes once, to record its redrive. The README's
[Dead letters and alerts](../../README.md#dead-letters-and-alerts-plt-05) says how this is built.

## How a message becomes one

| Failure reason      | When                                                                                                  | Retried first?                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| the handler's error | the handler failed every attempt: a database that was down, a row in a state it did not expect, a bug | yes: after 1, 5, 15 and 60 s, five attempts in all |
| unparseable         | not JSON, not a valid envelope, or a payload that fails its schema                                    | no: it would fail the same way                     |
| unsupported version | a major `schemaVersion` the consumer was not written for                                              | no                                                 |
| untrusted sender    | published by a broker account not allowed to send that event type                                     | no                                                 |
| `broker: …`         | set aside by RabbitMQ itself, with its own `x-death` reason, not by the consumer                      | no                                                 |

The dead letter's `failureReason` is that text: for an exhausted handler, its last error, such as
`role "credit_service" is not permitted to log in`. `foc_events_dead_lettered_total` counts them by
`reason` (`exhausted`, `unparseable`, `unsupported_version`, `untrusted_sender`).

## The alerts that send you here

They show on the Grafana dashboard's **Firing alerts** panel and at <http://localhost:9090/alerts>.
Nothing is sent anywhere: no Alertmanager runs.

- **`DeadLetterWaiting`**: a dead letter is waiting, in either service. Follow the steps below.
- **`DeadLetterNotParked`**: a `.dlq` queue has held a message for two minutes, so the service that
  consumes it is not draining it. It is down, or cannot reach its database. Fix that service; once
  it is back it parks what waited, and the queue is durable, so nothing is lost. Then
  `DeadLetterWaiting` takes over.

## 1. Find it

**In the admin console:** sign in as an administrator at <http://localhost:3000> and open
**Admin → Operations** (`/admin/operations`). Search by correlation ID, errand ID, user ID or event
ID, in either service.

**Through the API**, with an administrator's access token in `$ADMIN`. The password is read at a
prompt, so it stays out of your shell history; a token lasts 15 minutes. The bootstrap
administrator (`ADMIN_SEED_EMAILS`) must replace its seed password once before it can sign in,
which the console asks for.

```bash
read -rp 'Administrator email: ' EMAIL; read -rsp 'Password: ' PASSWORD; echo
ADMIN=$(curl -s -X POST localhost:3000/api/user/auth/login -H 'content-type: application/json' \
  -H 'Origin: http://localhost:3000' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" |
  python3 -c 'import sys, json; print(json.load(sys.stdin)["accessToken"])')
unset PASSWORD
```

```bash
curl -s 'localhost:3000/api/credit/admin/dead-letters?status=WAITING' -H "Authorization: Bearer $ADMIN"
curl -s 'localhost:3000/api/order/admin/dead-letters?status=WAITING' -H "Authorization: Bearer $ADMIN"
```

`?q=` matches a correlation ID, an errand or user ID, or an event ID exactly; `?queue=`,
`?page=` and `?pageSize=` (up to 100) narrow it further. Each item gives the `queue` it failed on,
the `eventType`, the `aggregateId` (the errand or user), the `correlationId`, the `failureReason`,
the `attempts` and its `status` (`WAITING` or `REDRIVEN`).

## 2. Inspect it, and decide

```bash
curl -s localhost:3000/api/credit/admin/dead-letters/<id> -H "Authorization: Bearer $ADMIN"
```

adds the message exactly as it arrived (`body`) and its `headers`. Then decide by its reason:

| Reason              | Redrive?                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| the handler's error | **Yes, once the cause is fixed.** Redriving before then only fails it again.                                                               |
| unsupported version | **Yes, once a consumer that understands that version is running.**                                                                         |
| unparseable         | **No.** A redrive sends the same bytes, which fail the same way. The producer that sent it has a bug; a correct event has to come from it. |
| untrusted sender    | **No.** Something published what it may not. Treat it as a security incident: check the broker accounts (`rabbitmq-init.sh`).              |
| `broker: …`         | Find out why RabbitMQ set it aside first.                                                                                                  |

## 3. See what happened around it

In **Operations**, **Trace an errand** from its ID: every state change, every event sent or still
waiting, reconciliation, alerts and dead letters from both services, in order. A `user.activated`
is about an account: the student it names has no wallet yet. The logs tell the same story by
correlation ID:

```bash
docker compose logs --no-log-prefix | grep '<correlation-id>'
```

## 4. Fix the cause, then redrive

Fix what the reason points to first: start the service or database that was down, deploy the fix,
or correct the state that made the handler refuse. Then redrive it, from **Operations** with a
reason, or:

```bash
curl -s -X POST localhost:3000/api/credit/admin/dead-letters/<id>/redrive \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"reason":"Credit lost its database login; restored at 10:31"}'
```

The service publishes the stored message, unedited, to the queue it failed on and nowhere else,
waits for the broker to confirm it, and records who redrove it, when and why. The consumer's
attempts start again. The answer is the dead letter, now `REDRIVEN`.

| Answer                    | It means                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `200`, `status: REDRIVEN` | sent and recorded                                                                        |
| `409 ALREADY_REDRIVEN`    | it was redriven before. If it failed again, it is waiting as a new dead letter.          |
| `503 BROKER_UNAVAILABLE`  | the service has no broker connection; nothing was sent. Try again once RabbitMQ is back. |

Redriving twice is harmless: the consumer recognises the event ID, so a second delivery has no
second effect. A redriven `user.activated` issues exactly one wallet, however often it arrives.

## 5. Check the outcome

- The effect is there: the errand moved on in its trace, or the student now has a wallet.
- Nothing is waiting: `?status=WAITING` is empty, and `DeadLetterWaiting` clears at Prometheus's
  next evaluation.
- If it failed again, it is back as a new dead letter with the new reason, and the old one stays
  `REDRIVEN`: start again from step 2.

## Never

- **Never move or purge messages in RabbitMQ's management UI.** That bypasses the record, and a
  message on a `.dlq` queue that has not been parked yet is the only copy.
- **Never edit or delete a `dead_letters` row.** A database trigger refuses it.
- **Never edit a message to make it pass.** A redrive sends exactly what arrived; a corrected event
  must come from the service that publishes it.
- **Never correct a credit balance by hand.** A balance changes only through the Credit Service's
  four event subscriptions; if the books look wrong, follow the
  [financial audit runbook](credit-ledger-audit.md).

## Rehearse it

`./scripts-demo-journey.sh --up --redrive` does all of this on a stack of its own; the dead-letter
part takes about two minutes. It takes Credit's database login away, activates a student, waits
while the activation is retried and set aside, gives the login back, then redrives the dead letter
through the API. It checks that the student's wallet arrives, that the credits were issued exactly
once, and that a second redrive is refused.
