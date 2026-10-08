#!/usr/bin/env bash
# Smoke test for the containerized stack (PLT-02).
#
#   ./scripts-smoke.sh            assume the stack is already up
#   ./scripts-smoke.sh --up       bring up a separate copy, delete it after
#
# Fails loudly with a non-zero exit code, so CI can gate on it.
set -euo pipefail

WEB_PORT="${WEB_APP_PORT:-3000}"
USER_PORT="${USER_SERVICE_PORT:-3001}"
SUPPLIER_PORT="${SUPPLIER_SERVICE_PORT:-3002}"
ORDER_PORT="${ORDER_SERVICE_PORT:-3003}"
CREDIT_PORT="${CREDIT_SERVICE_PORT:-3004}"
PROMETHEUS="http://localhost:${PROMETHEUS_PORT:-9090}"
GRAFANA="http://localhost:${GRAFANA_PORT:-3005}"
DEADLINE="${SMOKE_DEADLINE_SECONDS:-90}"

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
done

# ---- the browser can actually call them -------------------------------------
for pair in "user-service:$USER_PORT" "supplier-service:$SUPPLIER_PORT" \
  "order-service:$ORDER_PORT" "credit-service:$CREDIT_PORT"; do
  name="${pair%%:*}"
  port="${pair##*:}"
  allow=$(curl -fsS -o /dev/null -D - "http://localhost:${port}/health" \
    -H "Origin: http://localhost:${WEB_PORT}" 2>/dev/null |
    tr -d '\r' | awk 'tolower($1)=="access-control-allow-origin:"{print $2}')
  if [[ "$allow" == "http://localhost:${WEB_PORT}" ]]; then
    pass "$name allows the web app origin"
  else
    fail "$name CORS allow-origin was '${allow:-missing}'"
  fi
done

# ---- correlation id is echoed so one request can be traced ------------------
echoed=$(curl -fsS -o /dev/null -D - "http://localhost:${USER_PORT}/health" \
  -H 'x-correlation-id: smoke-probe' 2>/dev/null |
  tr -d '\r' | awk 'tolower($1)=="x-correlation-id:"{print $2}')
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
for ex in foc.events foc.events.dlx foc.credit-service.delay.1 foc.user-service.delay.1; do
  # `docker compose exec` leaves carriage returns behind, which defeat grep -x.
  if docker compose exec -T rabbitmq rabbitmqctl -q list_exchanges name 2>/dev/null |
    tr -d '\r' | grep -qx "$ex"; then
    pass "exchange $ex declared"
  else
    fail "exchange $ex missing"
  fi
done
for queue in foc.credit.wallet-provisioning foc.credit.reservations foc.credit.completions foc.credit.releases; do
  if docker compose exec -T rabbitmq rabbitmqctl -q list_queues name 2>/dev/null |
    tr -d '\r' | grep -qx "${queue}.dlq"; then
    pass "$queue has a dead-letter queue"
  else
    fail "$queue dead-letter queue missing"
  fi
done

# ---- the web app serves ------------------------------------------------------
code=$(curl -fsS -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null || echo 000)
[[ "$code" == "200" ]] && pass "web app responds 200" || fail "web app returned $code"

# ---- metrics reach the dashboard (PLT-04) ------------------------------------
METRICS_AUTH="Authorization: Bearer ${METRICS_TOKEN:-dev-only-metrics-token-change-me}"
for pair in "user-service:$USER_PORT" "supplier-service:$SUPPLIER_PORT" \
  "order-service:$ORDER_PORT" "credit-service:$CREDIT_PORT"; do
  name="${pair%%:*}"
  port="${pair##*:}"
  if curl -fsS "http://localhost:${port}/metrics" -H "$METRICS_AUTH" 2>/dev/null |
    grep -q '^# TYPE http_request_duration_seconds histogram'; then
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

title=$(curl -fsS "${GRAFANA}/api/dashboards/uid/foc-platform" 2>/dev/null |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["dashboard"]["title"])' 2>/dev/null) || title=""
[[ "$title" == "FoC Platform" ]] && pass "Grafana serves the FoC Platform dashboard" ||
  fail "Grafana dashboard missing (got '${title:-nothing}')"

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "All smoke checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
