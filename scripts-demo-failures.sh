#!/usr/bin/env bash
# Failure-handling demo for the containerized stack (EVT-03; D3 Part 3.4).
#
#   ./scripts-demo-failures.sh         against the stack that is already up
#   ./scripts-demo-failures.sh --up    bring up a separate copy, delete it after
#
# Each step forces one thing that goes wrong with messaging, then checks what the
# system did about it: a consumer killed mid-workflow, a duplicate, a stale
# reply, a message in a version no consumer supports, and a service forging
# another's event. It ends by checking that the wallets hold exactly the credits
# that were issued.
#
# Safe to run again and again: every run signs up its own students and creates
# its own errand, and compares counters before and after rather than expecting
# zero. Steps 4 and 5 each leave a dead letter waiting on purpose, so the
# DeadLetterWaiting alert and the admin console's Operations tab have something
# to show.
#
# Fails loudly with a non-zero exit code, like scripts-smoke.sh.
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh

. ./scripts-lib.sh
# The balances checked below (10/0, 7/3, ...) are for the default allocation of 10 credits.
REQUIRED_ALLOCATION=10

TEARDOWN=0
CREDIT_KILLED=0

# Set before anything is started or killed, so no way out of the script skips it.
cleanup() {
  local status=$?
  if [[ $TEARDOWN -eq 1 ]]; then
    if [[ $status -ne 0 ]]; then
      echo "Demo run failed. Last 60 log lines from each service:"
      docker compose logs --no-color --tail=60 user-service order-service credit-service || true
    fi
    echo "Tearing down..."
    docker compose down -v >/dev/null 2>&1 || true
  elif [[ $CREDIT_KILLED -eq 1 ]]; then
    # Step 1 was interrupted: never leave the developer's stack without its Credit Service.
    echo "Starting the Credit Service again..."
    docker compose start credit-service >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "${1:-}" == "--up" ]]; then
  # A Compose project of its own, as in scripts-smoke.sh: the teardown deletes
  # volumes, and under the default project that would be the developer's data.
  if [[ -n "$(docker compose -p foc ps -q 2>/dev/null)" ]]; then
    echo "Your own stack (project 'foc') is running and holds the ports this needs."
    echo "Stop it with 'docker compose stop', or run without --up to use it as it is."
    exit 1
  fi
  export COMPOSE_PROJECT_NAME=foc-demo
  TEARDOWN=1
  echo "Bringing up a separate copy of the stack (project 'foc-demo')..."
  docker compose up -d --build --wait >/dev/null
fi

# ---- helpers ------------------------------------------------------------------
# The shared ones (json, sql, wait_for, signup, wallet, errand) are in scripts-lib.sh.
# The sum of one counter's series for one queue, read straight from the service.
metric() { # port name queue
  { curl -fsS "http://localhost:$1/metrics" -H "$METRICS_AUTH" 2>/dev/null || true; } |
    awk -v name="$2" -v queue="queue=\"$3\"" 'index($0, name "{") == 1 && index($0, queue) { sum += $NF } END { print sum + 0 }'
}

# How far a counter has moved since `before`.
metric_since() { echo $(($(metric "$2" "$3" "$4") - $1)); } # before port name queue

# Publishes an envelope the way another service would, through the broker's API. The operator's
# account may publish under a service's name (it is the broker's one impersonator), which a
# consumer requires since PLT-06; no service's own account can.
publish() { # routing-key  (envelope JSON on stdin)
  python3 -c '
import json, sys
envelope = sys.stdin.read().strip()
print(json.dumps({"properties": {"delivery_mode": 2, "content_type": "application/json",
                                 "user_id": json.loads(envelope)["producer"]},
                  "routing_key": sys.argv[1], "payload": envelope, "payload_encoding": "string"}))' "$1" |
    curl -fsS -u "$RABBIT_AUTH" -H 'content-type: application/json' -X POST \
      "$RABBIT_API/exchanges/%2F/foc.events/publish" --data-binary @- 2>/dev/null | json 'd["routed"]' || true
}

waiting_dead_letters() { sql "$1" "SELECT count(*) FROM dead_letters WHERE redriven_at IS NULL"; }

for port in "$USER_PORT" "$ORDER_PORT" "$CREDIT_PORT"; do
  curl -fsS -o /dev/null "http://localhost:${port}/health" 2>/dev/null || {
    echo "Nothing answers on port $port. Start the stack with 'docker compose up -d', or run with --up."
    exit 1
  }
done

# ---- 1. a consumer killed mid-workflow ----------------------------------------
# First, so that everything counted afterwards is still on the dashboard: a restarted
# service starts its counters again from zero.
step "1. The Credit Service is killed, then an errand is created" \
  "The errand must wait, not fail, and open once Credit is back, with the reward reserved once."
signup requester
REQUESTER_ID=$STUDENT_ID
REQUESTER_TOKEN=$STUDENT_TOKEN
supplier=$(first_supplier "$REQUESTER_TOKEN")
CREDIT_KILLED=1
docker compose kill credit-service >/dev/null 2>&1 || true
ORDER_ID=$(post_errand "$REQUESTER_TOKEN" "$supplier" 3 demo-errand)
if [[ -z "$ORDER_ID" ]]; then
  fail "the errand could not be created while Credit was down"
  docker compose start credit-service >/dev/null 2>&1 || true
  CREDIT_KILLED=0
else
  pass "the errand was accepted with Credit down ($ORDER_ID)"
  sleep 3
  [[ "$(errand "$REQUESTER_TOKEN" "$ORDER_ID")" == "PENDING_CREDIT 1" && "$(wallet "$REQUESTER_ID")" == "10/0" ]] &&
    pass "it waits as PENDING_CREDIT, hidden from couriers, with no credits moved" ||
    fail "expected PENDING_CREDIT 1 and 10/0, saw '$(errand "$REQUESTER_TOKEN" "$ORDER_ID")' and '$(wallet "$REQUESTER_ID")'"
  docker compose start credit-service >/dev/null 2>&1 || true
  CREDIT_KILLED=0
  wait_for 90 "OPEN 2" errand "$REQUESTER_TOKEN" "$ORDER_ID" &&
    pass "Credit came back and the errand opened by itself" ||
    fail "the errand did not open within 90 s (last: '${LAST:-nothing}')"
  reserves=$(sql foc_credit "SELECT count(*) FROM credit_transactions WHERE order_id = '$ORDER_ID' AND transaction_type = 'RESERVE'")
  [[ "$reserves" == "1" && "$(wallet "$REQUESTER_ID")" == "7/3" ]] &&
    pass "3 credits reserved exactly once (available 7, reserved 3)" ||
    fail "reserves=$reserves balance=$(wallet "$REQUESTER_ID")"
fi

# ---- 2. a duplicate -----------------------------------------------------------
step "2. The same event, delivered three times" \
  "A student's activation is published again, twice, with the same event id."
signup duplicate
DUP_ID=$STUDENT_ID
before=$(metric "$CREDIT_PORT" foc_events_duplicate_total foc.credit.wallet-provisioning)
activation=$(sql foc_user "
  SELECT json_build_object(
           'eventId', id, 'eventType', event_type, 'schemaVersion', schema_version,
           'aggregateId', aggregate_id,
           'occurredAt', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
           'producer', 'user-service', 'correlationId', correlation_id,
           'causationId', coalesce(causation_id, correlation_id), 'payload', payload)::text
    FROM outbox_events WHERE aggregate_id = '$DUP_ID' AND event_type = 'user.activated'")
if [[ -z "$activation" ]]; then
  fail "the activation event was not found in the User Service's outbox"
else
  r1=$(publish user.activated <<<"$activation")
  r2=$(publish user.activated <<<"$activation")
  [[ "$r1" == "True" && "$r2" == "True" ]] || fail "the broker did not route the repeated activation"
  wait_for 30 2 metric_since "$before" "$CREDIT_PORT" foc_events_duplicate_total foc.credit.wallet-provisioning &&
    pass "Credit counted both repeats as duplicates" ||
    fail "expected 2 more duplicates on the wallet queue, saw ${LAST:-none}"
  wallets=$(sql foc_credit "SELECT count(*) FROM wallets WHERE user_id = '$DUP_ID'")
  issues=$(sql foc_credit "SELECT count(*) FROM credit_transactions WHERE wallet_user_id = '$DUP_ID' AND transaction_type = 'ISSUE'")
  [[ "$wallets" == "1" && "$issues" == "1" && "$(wallet "$DUP_ID")" == "10/0" ]] &&
    pass "still one wallet, one issue of 10 credits: the repeats moved no additional credits" ||
    fail "wallets=$wallets issues=$issues balance=$(wallet "$DUP_ID")"
fi

# ---- 3. a stale reply ---------------------------------------------------------
step "3. A second copy of Credit's reply arrives after the errand has moved on" \
  "A courier accepts the errand, then 'credit.reserved' is delivered again under a new event id."
if [[ -n "${ORDER_ID:-}" ]]; then
  signup courier
  accepted=$(errand_action "$STUDENT_TOKEN" "$ORDER_ID" accept 2)
  [[ "$accepted" == "201" ]] && pass "a courier accepted the errand" || fail "acceptance returned $accepted"
  state=$(errand "$REQUESTER_TOKEN" "$ORDER_ID")
  stale_before=$(metric "$ORDER_PORT" foc_events_stale_total foc.order.reservation-results)
  dead_before=$(waiting_dead_letters foc_order)
  reply=$(sql foc_credit "
    SELECT json_build_object(
             'eventId', gen_random_uuid(), 'eventType', event_type, 'schemaVersion', schema_version,
             'aggregateId', aggregate_id,
             'occurredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
             'producer', 'credit-service', 'correlationId', correlation_id,
             'causationId', coalesce(causation_id, correlation_id), 'payload', payload)::text
      FROM outbox_events WHERE aggregate_id = '$ORDER_ID' AND event_type = 'credit.reserved' ORDER BY seq LIMIT 1")
  [[ "$(publish credit.reserved <<<"$reply")" == "True" ]] || fail "the broker did not route the repeated reply"
  wait_for 30 "$((stale_before + 1))" metric "$ORDER_PORT" foc_events_stale_total foc.order.reservation-results &&
    pass "Order counted it as stale and ignored it" ||
    fail "expected one more stale event, counter is ${LAST:-unknown} (was $stale_before)"
  [[ "$(errand "$REQUESTER_TOKEN" "$ORDER_ID")" == "$state" && "$(waiting_dead_letters foc_order)" == "$dead_before" ]] &&
    pass "the errand is unchanged ($state) and nothing was set aside for an operator" ||
    fail "errand '$(errand "$REQUESTER_TOKEN" "$ORDER_ID")' (was '$state'), dead letters $(waiting_dead_letters foc_order) (was $dead_before)"
else
  fail "skipped: there is no errand from step 1"
fi

# ---- 4. an unsupported version -------------------------------------------------
step "4. An activation arrives in version 2, which no consumer supports" \
  "It must be set aside whole, with the reason, and create no wallet."
ghost=$(python3 -c 'import uuid; print(uuid.uuid4())')
v2_event=$(python3 -c 'import uuid; print(uuid.uuid4())')
v2=$(python3 -c '
import json, sys, datetime
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
print(json.dumps({"eventId": sys.argv[1], "eventType": "user.activated", "schemaVersion": 2,
                  "aggregateId": sys.argv[2], "occurredAt": now, "producer": "user-service",
                  "correlationId": "demo-unsupported-version", "causationId": "demo-unsupported-version",
                  "payload": {"userId": sys.argv[2], "activatedAt": now}}))' "$v2_event" "$ghost")
[[ "$(publish user.activated <<<"$v2")" == "True" ]] || fail "the broker did not route the version 2 activation"
wait_for 30 1 sql foc_credit "SELECT count(*) FROM dead_letters WHERE event_id = '$v2_event'" &&
  pass "it was set aside as a dead letter" ||
  fail "no dead letter for the version 2 activation after 30 s"
reason=$(sql foc_credit "SELECT failure_reason FROM dead_letters WHERE event_id = '$v2_event'")
[[ "$reason" == "unsupported schema version 2 for user.activated; supported: 1" ]] &&
  pass "with its reason: $reason" ||
  fail "unexpected reason: '${reason:-none}'"
[[ "$(sql foc_credit "SELECT count(*) FROM wallets WHERE user_id = '$ghost'")" == "0" ]] &&
  pass "and no wallet was created from it" ||
  fail "a wallet was created from an unsupported message"

# ---- 5. a forged event ----------------------------------------------------------
step "5. The Order Service tries to pass off an activation as the User Service's" \
  "The broker will not let it publish 'user.activated', so it binds an exchange of its own into the shared one."
forged_user=$(python3 -c 'import uuid; print(uuid.uuid4())')
forged_event=$(python3 -c 'import uuid; print(uuid.uuid4())')
attempt=$(docker compose exec -T -e FORGED_USER="$forged_user" -e FORGED_EVENT="$forged_event" order-service \
  node --input-type=module -e "
import amqp from 'amqplib';
const conn = await amqp.connect(process.env.RABBITMQ_URL);
conn.on('error', () => undefined);
const now = new Date().toISOString();
const body = Buffer.from(JSON.stringify({
  eventId: process.env.FORGED_EVENT, eventType: 'user.activated', schemaVersion: 1,
  aggregateId: process.env.FORGED_USER, occurredAt: now, producer: 'user-service',
  correlationId: 'demo-forged', causationId: 'demo-forged',
  payload: { userId: process.env.FORGED_USER, activatedAt: now },
}));
// Signing the message with the User Service's name: the broker checks user-id against the login.
const named = await conn.createConfirmChannel();
const naming = await new Promise((resolve) => {
  named.on('error', (err) => resolve(/PRECONDITION_FAILED|406/.test(String(err.message)) ? 'refused' : String(err.message)));
  named.on('close', () => resolve('closed'));
  named.publish('foc.order-service.requeue', 'nowhere', body, { userId: 'user-service' });
  named.waitForConfirms().then(() => resolve('accepted'), (err) => resolve(String(err.message)));
});
// Around the routing-key rule: an exchange of its own, bound into the shared one.
const ch = await conn.createConfirmChannel();
await ch.assertExchange('foc.order-service.forged', 'fanout', { durable: false, autoDelete: true });
await ch.bindExchange('foc.events', 'foc.order-service.forged', '');
ch.publish('foc.order-service.forged', 'user.activated', body, { userId: 'order-service', persistent: true });
await ch.waitForConfirms();
await ch.unbindExchange('foc.events', 'foc.order-service.forged', '');
await ch.deleteExchange('foc.order-service.forged');
console.log(naming + ' delivered');
process.exit(0);
" 2>/dev/null | tr -d '\r' | tail -1 || true)
[[ "$attempt" == refused* ]] &&
  pass "the broker refuses it a message signed with the User Service's name" ||
  fail "signing a message as the User Service was '${attempt:-not tried}'"
if [[ "$attempt" == *delivered ]]; then
  wait_for 30 1 sql foc_credit "SELECT count(*) FROM dead_letters WHERE event_id = '$forged_event'" &&
    pass "its message did reach Credit's queue, and Credit set it aside" ||
    fail "the forged activation was not set aside (dead letters for it: ${LAST:-none})"
  reason=$(sql foc_credit "SELECT failure_reason FROM dead_letters WHERE event_id = '$forged_event'")
  [[ "$reason" == "sender order-service may not publish user.activated: only user-service may" ]] &&
    pass "because of who really sent it: $reason" ||
    fail "unexpected reason: '${reason:-none}'"
else
  fail "could not try the binding route (got '${attempt:-nothing}')"
fi
[[ "$(sql foc_credit "SELECT count(*) FROM wallets WHERE user_id = '$forged_user'")" == "0" ]] &&
  pass "and no wallet was created: no credits were minted" ||
  fail "the forged activation created a wallet: 10 credits minted by the Order Service"

# ---- 6. conservation ----------------------------------------------------------
step "6. After all of that, the closed economy still balances" \
  "Every wallet's available and reserved credits add up to exactly what was issued."
totals=$(sql foc_credit "
  SELECT (SELECT coalesce(sum(available + reserved), 0) FROM wallets) || ' held, ' ||
         (SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE transaction_type = 'ISSUE') || ' issued'")
held=${totals%% held*}
issued=${totals##*, }
issued=${issued%% issued}
[[ -n "$held" && "$held" == "$issued" ]] && pass "$totals" || fail "credits not conserved: ${totals:-no answer}"

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "All demo checks passed."
  echo "Left for the dashboard and the Operations tab: two dead letters waiting (steps 4 and 5)."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
