#!/usr/bin/env bash
# Smoke test for the containerized stack (PLT-02).
#
#   ./scripts-smoke.sh            assume the stack is already up
#   ./scripts-smoke.sh --up       bring up a separate copy, delete it after
#
# Fails loudly with a non-zero exit code, so CI can gate on it.
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh

# No request may hang the run: a port that never answers is a failure, not a wait.
curl() { command curl --max-time 20 "$@"; }

WEB_PORT="${WEB_APP_PORT:-3000}"
USER_PORT="${USER_SERVICE_PORT:-3001}"
SUPPLIER_PORT="${SUPPLIER_SERVICE_PORT:-3002}"
ORDER_PORT="${ORDER_SERVICE_PORT:-3003}"
CREDIT_PORT="${CREDIT_SERVICE_PORT:-3004}"
PROMETHEUS="http://localhost:${PROMETHEUS_PORT:-9090}"
GRAFANA="http://localhost:${GRAFANA_PORT:-3005}"
DEADLINE="${SMOKE_DEADLINE_SECONDS:-90}"

# A probe whose request fails records a FAIL and the run carries on: under `set -e`
# a failed command substitution would otherwise exit silently, so each probe
# below ends in `|| true` or `|| echo …`. The one deliberate exit is above: a
# stack that never became healthy has nothing to probe.
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0
TEARDOWN=0

if [[ "${1:-}" == "--up" ]]; then
  # A Compose project of its own. The teardown below deletes volumes, and under
  # the default project name ('foc', from compose.yaml) that would be the
  # developer's own databases.
  if [[ -n "$(docker compose -p foc ps -q 2>/dev/null)" ]]; then
    echo "Your own stack (project 'foc') is running and holds the ports this needs."
    echo "Stop it with 'docker compose stop' (your data is kept), or run without"
    echo "--up to check the running stack as it is."
    exit 1
  fi
  export COMPOSE_PROJECT_NAME=foc-smoke
  TEARDOWN=1
  echo "Bringing up a separate copy of the stack (project 'foc-smoke')..."
  docker compose up -d --build >/dev/null
fi

cleanup() {
  local status=$?
  if [[ $TEARDOWN -eq 1 ]]; then
    # Logs before teardown: once the containers are removed there is nothing
    # left to read, which is why CI could never show why a smoke run failed.
    if [[ $status -ne 0 ]]; then
      echo "Smoke run failed. Last 100 log lines from each container:"
      docker compose logs --no-color --tail=100 || true
    fi
    echo "Tearing down..."
    docker compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Waiting for every container to report healthy (deadline ${DEADLINE}s)..."
START=$(date +%s)
while true; do
  ELAPSED=$(($(date +%s) - START))
  UNHEALTHY=$(docker compose ps -a --format json 2>/dev/null |
    python3 -c "
import sys, json
bad = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    health, state = d.get('Health'), d.get('State')
    if health and health != 'healthy':
        bad.append(d['Service'])
    elif not health and state != 'running' and not (state == 'exited' and d.get('ExitCode') == 0):
        bad.append(d['Service'])
print(' '.join(bad))
" 2>/dev/null || echo "pending")
  [[ -z "$UNHEALTHY" ]] && break
  if [[ $ELAPSED -gt $DEADLINE ]]; then
    fail "stack did not reach healthy within ${DEADLINE}s (waiting on: $UNHEALTHY)"
    docker compose ps
    exit 1
  fi
  sleep 3
done
pass "stack healthy in ${ELAPSED}s (limit ${DEADLINE}s)"

# ---- every service answers /health with its own identity --------------------
for pair in "user-service:$USER_PORT" "supplier-service:$SUPPLIER_PORT" \
  "order-service:$ORDER_PORT" "credit-service:$CREDIT_PORT"; do
  name="${pair%%:*}"
  port="${pair##*:}"
  body=$(curl -fsS "http://localhost:${port}/health" 2>/dev/null || echo '{}')
  if [[ "$(printf '%s' "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("service",""))' 2>/dev/null)" == "$name" ]]; then
    pass "$name /health identifies itself"
  else
    fail "$name /health returned: $body"
  fi
  # PLT-06: health is about the service's dependencies too, not only its process.
  deps=$(printf '%s' "$body" | python3 -c 'import sys,json;d=json.load(sys.stdin).get("dependencies",{});print(d.get("database"),d.get("broker"))' 2>/dev/null || true)
  [[ "$deps" == "up up" ]] && pass "$name reports its database and the broker as up" ||
    fail "$name reports its dependencies as '${deps:-nothing}'"
done

# ---- the browser can actually call them -------------------------------------
for pair in "user-service:$USER_PORT" "supplier-service:$SUPPLIER_PORT" \
  "order-service:$ORDER_PORT" "credit-service:$CREDIT_PORT"; do
  name="${pair%%:*}"
  port="${pair##*:}"
  allow=$(curl -fsS -o /dev/null -D - "http://localhost:${port}/health" \
    -H "Origin: http://localhost:${WEB_PORT}" 2>/dev/null |
    tr -d '\r' | awk 'tolower($1)=="access-control-allow-origin:"{print $2}') || true
  if [[ "$allow" == "http://localhost:${WEB_PORT}" ]]; then
    pass "$name allows the web app origin"
  else
    fail "$name CORS allow-origin was '${allow:-missing}'"
  fi
done

# ---- correlation id is echoed so one request can be traced ------------------
echoed=$(curl -fsS -o /dev/null -D - "http://localhost:${USER_PORT}/health" \
  -H 'x-correlation-id: smoke-probe' 2>/dev/null |
  tr -d '\r' | awk 'tolower($1)=="x-correlation-id:"{print $2}') || true
[[ "$echoed" == "smoke-probe" ]] &&
  pass "correlation id echoed" ||
  fail "correlation id was '${echoed:-missing}'"

# ---- each service reaches only its own database -----------------------------
for pair in "user_service:foc_user" "supplier_service:foc_supplier" \
  "order_service:foc_order" "credit_service:foc_credit"; do
  role="${pair%%:*}"
  db="${pair##*:}"
  if docker compose exec -T postgres psql -U "$role" -d "$db" -c 'SELECT 1' >/dev/null 2>&1; then
    pass "$role can reach $db"
  else
    fail "$role cannot reach its own database $db"
  fi
done
if docker compose exec -T postgres psql -U user_service -d foc_credit -c 'SELECT 1' >/dev/null 2>&1; then
  fail "user_service can reach foc_credit — databases are NOT isolated"
else
  pass "user_service is denied another service's database"
fi

# ---- the broker topology exists ---------------------------------------------
# Delay (retry) exchanges are namespaced per service, so two services can tune
# their own backoff without colliding on a queue's fixed TTL.
for ex in foc.events foc.events.dlx foc.credit-service.delay.1 foc.user-service.delay.1 \
  foc.credit-service.requeue foc.order-service.requeue; do
  # `docker compose exec` leaves carriage returns behind, which defeat grep -x.
  exchanges=$(docker compose exec -T rabbitmq rabbitmqctl -q list_exchanges name 2>/dev/null | tr -d '\r' || true)
  if grep -qx "$ex" <<<"$exchanges"; then
    pass "exchange $ex declared"
  else
    fail "exchange $ex missing"
  fi
done
for queue in foc.credit.wallet-provisioning foc.credit.reservations foc.credit.completions foc.credit.releases; do
  queues=$(docker compose exec -T rabbitmq rabbitmqctl -q list_queues name 2>/dev/null | tr -d '\r' || true)
  if grep -qx "${queue}.dlq" <<<"$queues"; then
    pass "$queue has a dead-letter queue"
  else
    fail "$queue dead-letter queue missing"
  fi
done

# ---- an activation reaches the Credit Service --------------------------------
# The queues above can exist with nothing flowing through them. This signs up a
# throwaway student, activates them through the dev mailbox, and waits for the
# wallet the Credit Service issues on `user.activated`: User Service, outbox
# relay, broker and Credit Service, end to end.
#
# Each step is checked where it happens, so a broken registration, mailbox or
# sign-in is reported as that, not as a wallet that never arrived.
SMOKE_EMAIL="smoke-$(date +%s)-$RANDOM@u.nus.edu"
SMOKE_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
# What a new student is issued: INITIAL_CREDIT_ALLOCATION in .env when it is set, otherwise the
# default in credit-service/src/credits/types.ts. Set SMOKE_INITIAL_CREDITS when checking a build
# that changes the default.
INITIAL_CREDITS="${SMOKE_INITIAL_CREDITS:-${INITIAL_CREDIT_ALLOCATION:-10}}"
json_field() { python3 -c "import sys,json; print(json.load(sys.stdin).get('$1', ''))" 2>/dev/null || true; }
# POSTs JSON to the User Service and prints the HTTP status; the body goes to the file named in $3.
post_json() { # path json body-file [extra curl arguments...]
  local path=$1 json=$2 out=$3
  shift 3
  curl -s -o "$out" -w '%{http_code}' -X POST "http://localhost:${USER_PORT}${path}" \
    -H 'content-type: application/json' "$@" -d "$json" 2>/dev/null || true
}
wallet_step=""
response=$(mktemp)

registered=$(post_json /auth/register "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\",\"displayName\":\"Smoke test\"}" "$response")
[[ "$registered" == 2* ]] || wallet_step="registering returned ${registered:-no answer}"

activation_token=""
if [[ -z "$wallet_step" ]]; then
  activation_token=$(curl -fsS "http://localhost:${USER_PORT}/dev/mailbox?to=$SMOKE_EMAIL" 2>/dev/null | json_field token) || true
  # The dev mailbox exists only outside production. A stack this script can check is not in
  # production, so no token means the mailbox or the registration is broken: a failure, not a skip.
  [[ -n "$activation_token" ]] || wallet_step="the dev mailbox gave no activation token (is NODE_ENV production?)"
fi
if [[ -z "$wallet_step" ]]; then
  activated=$(post_json /auth/activate "{\"token\":\"$activation_token\"}" "$response" -H 'x-correlation-id: smoke-wallet')
  [[ "$activated" == 2* ]] || wallet_step="activating returned ${activated:-no answer}"
fi
access_token=""
if [[ -z "$wallet_step" ]]; then
  signed_in=$(post_json /auth/login "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\"}" "$response" -H "Origin: http://localhost:${WEB_PORT}")
  access_token=$(json_field accessToken <"$response")
  [[ "$signed_in" == 2* && -n "$access_token" ]] || wallet_step="signing in returned ${signed_in:-no answer}"
fi
rm -f "$response"

if [[ -n "$wallet_step" ]]; then
  fail "activation → wallet: $wallet_step"
else
  # The wallet arrives by event, so it is waited for: as long as the stack was given to start.
  available=""
  for _ in $(seq 1 "$((DEADLINE * 2))"); do
    available=$(curl -fsS "http://localhost:${CREDIT_PORT}/wallets/me" -H "Authorization: Bearer $access_token" \
      2>/dev/null | json_field available) || true
    [[ "$available" == "$INITIAL_CREDITS" ]] && break
    sleep 0.5
  done
  [[ "$available" == "$INITIAL_CREDITS" ]] &&
    pass "an activation issues a ${INITIAL_CREDITS}-credit wallet" ||
    fail "no ${INITIAL_CREDITS}-credit wallet ${DEADLINE}s after activation (last available: '${available:-none}')"
fi

# ---- the web app serves ------------------------------------------------------
code=$(curl -fsS -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null || echo 000)
[[ "$code" == "200" ]] && pass "web app responds 200" || fail "web app returned $code"

# ---- metrics reach the dashboard (PLT-04) ------------------------------------
METRICS_AUTH="Authorization: Bearer ${METRICS_TOKEN:?}"
for pair in "user-service:$USER_PORT" "supplier-service:$SUPPLIER_PORT" \
  "order-service:$ORDER_PORT" "credit-service:$CREDIT_PORT"; do
  name="${pair%%:*}"
  port="${pair##*:}"
  # Read whole before it is searched: `grep -q` stops at the first match, and once a service's
  # metrics outgrow the pipe (a stack that has been used for a while) curl is cut off mid-write,
  # which under pipefail turned a healthy endpoint into a failure.
  metrics=$(curl -fsS "http://localhost:${port}/metrics" -H "$METRICS_AUTH" 2>/dev/null || true)
  if grep -q '^# TYPE http_request_duration_seconds histogram' <<<"$metrics"; then
    pass "$name serves /metrics"
  else
    fail "$name /metrics missing or not Prometheus format"
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/metrics" 2>/dev/null || echo 000)
  [[ "$code" == "401" ]] && pass "$name refuses /metrics without the scrape token" ||
    fail "$name served /metrics without the token ($code)"
done

# Prometheus scrapes every 15 s, so a fresh stack may not have reached every
# target yet: wait up to 45 s for all five (four services and RabbitMQ).
up=0
for _ in $(seq 1 45); do
  up=$(curl -fsS "${PROMETHEUS}/api/v1/targets?state=active" 2>/dev/null |
    python3 -c 'import sys,json; print(sum(t["health"] == "up" for t in json.load(sys.stdin)["data"]["activeTargets"]))' \
      2>/dev/null) || up=0
  [[ "$up" == "5" ]] && break
  sleep 1
done
[[ "$up" == "5" ]] && pass "Prometheus scrapes all 5 targets" || fail "Prometheus has ${up:-0} of 5 targets up"

queues=$(curl -fsS "${PROMETHEUS}/api/v1/query" --data-urlencode 'query=count(rabbitmq_detailed_queue_messages)' \
  2>/dev/null | python3 -c 'import sys,json; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else 0)' \
  2>/dev/null) || queues=0
[[ "${queues:-0}" -gt 0 ]] && pass "Prometheus sees RabbitMQ queue depths ($queues queues)" ||
  fail "no RabbitMQ queue depths in Prometheus"

# ---- dead letters are parked, and alerted on (PLT-05) -------------------------
rules=$(curl -fsS "${PROMETHEUS}/api/v1/rules" 2>/dev/null |
  python3 -c 'import sys,json; print(" ".join(r["name"] for g in json.load(sys.stdin)["data"]["groups"] for r in g["rules"]))' \
    2>/dev/null) || rules=""
[[ "$rules" == *DeadLetterWaiting* && "$rules" == *ErrandWaitingForCredit* ]] &&
  pass "Prometheus loaded the alert rules" || fail "alert rules not loaded (got '${rules:-nothing}')"

# Order (4) and Credit (4) each drain their own dead-letter queues into their database, where an
# operator redrives them. A queue nobody consumes would hold dead letters out of the console's sight.
RABBIT_API="http://localhost:${RABBITMQ_MANAGEMENT_PORT:-15672}/api/queues/%2F?columns=name,consumers"
RABBIT_AUTH="${RABBITMQ_USER:-foc}:${RABBITMQ_PASSWORD:?}"
dlqs=""
for _ in $(seq 1 15); do
  dlqs=$(curl -fsS -u "$RABBIT_AUTH" "$RABBIT_API" 2>/dev/null |
    python3 -c 'import sys,json; q=[x for x in json.load(sys.stdin) if x["name"].endswith(".dlq")]; print(len(q), sum(x.get("consumers", 0) > 0 for x in q))' \
      2>/dev/null) || dlqs=""
  [[ "$dlqs" == "8 8" ]] && break
  sleep 1
done
[[ "$dlqs" == "8 8" ]] && pass "all 8 dead-letter queues are consumed" ||
  fail "dead-letter queues and consumers: expected '8 8', got '${dlqs:-nothing}'"

title=$(curl -fsS "${GRAFANA}/api/dashboards/uid/foc-platform" 2>/dev/null |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["dashboard"]["title"])' 2>/dev/null) || title=""
[[ "$title" == "FoC Platform" ]] && pass "Grafana serves the FoC Platform dashboard" ||
  fail "Grafana dashboard missing (got '${title:-nothing}')"

# ---- containers get only what they need (PLT-06, PL-NFR2.1.2) ----------------
# Every container's main process is unprivileged.
rootful=""
for id in $(docker compose ps -q); do
  name=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null || true)
  uid=$(docker exec "$id" sh -c "awk '/^Uid:/{print \$2}' /proc/1/status" 2>/dev/null | tr -d '\r' || true)
  [[ -n "$uid" && "$uid" != "0" ]] || rootful="$rootful $name(uid ${uid:-unknown})"
done
[[ -z "$rootful" ]] && pass "every container runs as non-root" || fail "not shown to be non-root:$rootful"

# The data stores answer on this machine only.
for spec in "postgres 5432" "rabbitmq 5672" "rabbitmq 15672"; do
  bound=$(docker compose port ${spec} 2>/dev/null | tr -d '\r' || true)
  [[ "$bound" == 127.0.0.1:* ]] && pass "${spec/ /:} is published on 127.0.0.1 only" ||
    fail "${spec/ /:} is published on '${bound:-nothing}'"
done

# A role's password is asked for over the network (inside the container, Postgres trusts itself).
wrong=$(docker compose exec -T order-service node --input-type=module -e "
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
url.password = 'not-the-password';
const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
client.connect().then(() => console.log('accepted'), (e) => console.log(e.code === '28P01' ? 'refused' : (e.code ?? e.message)))
  .finally(() => client.end().catch(() => undefined));
" 2>/dev/null | tr -d '\r' | tail -1 || true)
[[ "$wrong" == "refused" ]] && pass "Postgres refuses a service role with the wrong password" ||
  fail "a wrong database password was '${wrong:-not tried}'"

# /internal/** is not served where a browser reaches a service ...
for probe in "user-service:$USER_PORT:/internal/introspect" "credit-service:$CREDIT_PORT:/internal/orders/x/credit-status"; do
  IFS=: read -r name port path <<<"$probe"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}${path}" 2>/dev/null || true)
  [[ "$code" == "404" ]] && pass "$name hides $path on its public port" || fail "$name answered $code for $path on its public port"
done
# ... its internal port is not published ...
published=$(docker compose port user-service 4001 2>/dev/null | tr -d '\r' || true)
[[ -z "$published" || "$published" == ":0" ]] && pass "the internal port is not published" ||
  fail "the User Service's internal port is published on $published"
# ... and another service reaches it there (401: it got as far as the service-key check).
inside=$(docker compose exec -T order-service node -e "fetch('http://user-service:4001/internal/introspect').then((r) => console.log(r.status), () => console.log('unreachable'))" 2>/dev/null | tr -d '\r' | tail -1 || true)
[[ "$inside" =~ ^[0-9]+$ && "$inside" != "404" ]] && pass "the Order Service reaches the User Service's internal routes ($inside without a key)" ||
  fail "from the Order Service, /internal/introspect was '${inside:-not tried}'"

# The web app's container is on a network of its own: it has no route to the database.
reach=$(docker compose exec -T web-app node -e "
const s = require('net').connect({ host: 'postgres', port: 5432, timeout: 2000 });
const say = (w) => { console.log(w); process.exit(0); };
s.on('connect', () => say('reached')); s.on('error', () => say('unreachable')); s.on('timeout', () => say('unreachable'));
" 2>/dev/null | tr -d '\r' | tail -1 || true)
[[ "$reach" == "unreachable" ]] && pass "the web app's container cannot reach Postgres" ||
  fail "from the web app's container, Postgres was '${reach:-not tried}'"

# ---- one broker account per service (PLT-06) ---------------------------------
# What the broker says when a service, signed in as itself, does something on a
# confirm channel: "accepted", or "refused" for a 403.
broker_says() { # service  javascript-using-`ch`
  docker compose exec -T "$1" node --input-type=module -e "
import amqp from 'amqplib';
const conn = await amqp.connect(process.env.RABBITMQ_URL);
conn.on('error', () => undefined);
const ch = await conn.createConfirmChannel();
const outcome = await new Promise((resolve) => {
  ch.on('error', (err) => resolve(String(err.message)));
  ch.on('close', () => resolve('closed'));
  Promise.resolve($2).then(() => ch.waitForConfirms()).then(() => resolve('accepted'), (err) => resolve(String(err.message)));
});
console.log(/ACCESS_REFUSED|403/.test(outcome) ? 'refused' : outcome);
process.exit(0);
" 2>/dev/null | tr -d '\r' | tail -1 || true
}
said=$(broker_says order-service "ch.publish('foc.events', 'user.activated', Buffer.from('{}'))")
[[ "$said" == "refused" ]] && pass "the broker refuses user.activated from the Order Service" ||
  fail "user.activated from the Order Service was '${said:-not tried}'"
said=$(broker_says order-service "ch.publish('', 'foc.credit.wallet-provisioning', Buffer.from('{}'))")
[[ "$said" == "refused" ]] && pass "the broker refuses the Order Service a direct write to a Credit queue" ||
  fail "a direct write to a Credit queue by the Order Service was '${said:-not tried}'"
said=$(broker_says order-service "ch.consume('foc.credit.wallet-provisioning', () => undefined)")
[[ "$said" == "refused" ]] && pass "the Order Service cannot read a Credit queue" ||
  fail "reading a Credit queue as the Order Service was '${said:-not tried}'"
said=$(broker_says order-service "ch.publish('foc.events', 'order.smoke-probe', Buffer.from('{}'))")
[[ "$said" == "accepted" ]] && pass "the Order Service may publish under its own routing keys" ||
  fail "an order.* publish by the Order Service was '${said:-not tried}'"
said=$(broker_says supplier-service "ch.publish('foc.events', 'supplier.anything', Buffer.from('{}'))")
[[ "$said" == "refused" ]] && pass "the Supplier Service, which publishes nothing, may publish nothing" ||
  fail "a publish by the Supplier Service was '${said:-not tried}'"

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "All smoke checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
