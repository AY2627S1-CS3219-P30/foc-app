#!/usr/bin/env bash
# Smoke test for the containerized stack (PLT-02).
#
#   ./scripts-smoke.sh            assume the stack is already up
#   ./scripts-smoke.sh --up       bring it up first, tear it down after
#
# Fails loudly with a non-zero exit code, so CI can gate on it.
set -euo pipefail

WEB_PORT="${WEB_APP_PORT:-3000}"
USER_PORT="${USER_SERVICE_PORT:-3001}"
SUPPLIER_PORT="${SUPPLIER_SERVICE_PORT:-3002}"
ORDER_PORT="${ORDER_SERVICE_PORT:-3003}"
CREDIT_PORT="${CREDIT_SERVICE_PORT:-3004}"
DEADLINE="${SMOKE_DEADLINE_SECONDS:-90}"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0
TEARDOWN=0

if [[ "${1:-}" == "--up" ]]; then
  TEARDOWN=1
  echo "Bringing the stack up..."
  docker compose up -d --build >/dev/null
fi

cleanup() {
  if [[ $TEARDOWN -eq 1 ]]; then
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
    elif not health and state != 'running':
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

# ---- the web app serves ------------------------------------------------------
code=$(curl -fsS -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null || echo 000)
[[ "$code" == "200" ]] && pass "web app responds 200" || fail "web app returned $code"

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "All smoke checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
