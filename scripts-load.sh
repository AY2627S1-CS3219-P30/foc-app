#!/usr/bin/env bash
# Load and latency test (TST-03, #166) for the D1 targets that need a running stack:
#
#   US-NFR3.1.1  login p95 <= 500 ms, profile p95 <= 300 ms           100 users
#   US-NFR3.1.2  ready within 60 s of a restart; sessions still valid
#   SS-NFR2.1.1  list or search p95 <= 400 ms, lookup p95 <= 200 ms   1,000 suppliers, 100 users
#   SS-NFR2.1.2  the same query on unchanged data returns the same order
#   CS-NFR3.1.1  wallet lookup p95 <= 300 ms                          10,000 wallets, 100 users
#   CS-NFR3.1.2  ready within 60 s of a restart
#   N1.4 (#332)  live updates under load: 200 streams held while the above run; an accept reaches
#                its requester's stream within 1 s at p95
#
#   ./scripts-load.sh            measure, and write docs/reports/load-<date>.md
#   ./scripts-load.sh --quick    10 users for 10 s: checks the harness works; writes no report
#
# Either exits 1 when a check fails; the full run also when the report says a target was missed.
#   ./scripts-load.sh --keep     leave the stack up afterwards (tear it down with the command printed)
#
# It runs on a Compose project of its own ('foc-load') on ports of its own (13000-13005 and so
# on), so it can start beside the demo stack; stop that one first for figures worth quoting, as
# both share this machine. compose.load.yaml raises the User Service's sign-in limits on that
# stack only: every virtual user signs in from this one machine. The Order Service's targets
# (OS-NFR2) are ORD-12, #181, on the same harness.
#
# The virtual users are k6, in a container. Each pauses THINK_S seconds (default 1) between
# requests, as a person does; the report says so.
set -euo pipefail
cd "$(dirname "$0")"

QUICK=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --keep) KEEP=1 ;;
    *) echo "usage: $0 [--quick] [--keep]" >&2; exit 2 ;;
  esac
done

# Pinned like every other image: see the README's table of pre-built images.
K6='grafana/k6:0.55.0@sha256:b24f418fc99a26dd57904c952c03bfaf79462be18508acc45aafa07ff68e7df2'
# For load/live.mjs: the services' own base image (their Dockerfiles). k6 cannot read a response
# while it is still streaming.
NODE='node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402'

# A stack of its own. Exported, so they win over .env for every docker compose call below,
# scripts-lib.sh's included.
export COMPOSE_PROJECT_NAME=foc-load
export COMPOSE_FILE=compose.yaml:compose.load.yaml
export WEB_APP_PORT=13000 USER_SERVICE_PORT=13001 SUPPLIER_SERVICE_PORT=13002 ORDER_SERVICE_PORT=13003
export CREDIT_SERVICE_PORT=13004 GRAFANA_PORT=13005 PROMETHEUS_PORT=19090
export POSTGRES_PORT=56432 RABBITMQ_PORT=56672 RABBITMQ_MANAGEMENT_PORT=16672
export CORS_ORIGINS="http://localhost:${WEB_APP_PORT}"

if [[ $QUICK -eq 1 ]]; then
  STUDENTS=10 VUS=10 DURATION_S=10 SUPPLIERS=100 WALLETS=200
  LIVE_STUDENTS=10 STREAMS_EACH=5 LIVE_ERRANDS=6
else
  STUDENTS=100 VUS=100 DURATION_S=60 SUPPLIERS=1000 WALLETS=10000
  LIVE_STUDENTS=40 STREAMS_EACH=5 LIVE_ERRANDS=60
fi
THINK_S="${THINK_S:-1}"

# .env's logins and settings, after the ports above: scripts-env.sh never overrides a variable
# that is already set.
# shellcheck source=scripts-env.sh
. ./scripts-env.sh
# shellcheck source=scripts-lib.sh
. ./scripts-lib.sh

cleanup() {
  local status=$?
  if [[ -n "${LIVE:-}" ]]; then docker rm -f "$LIVE" >/dev/null 2>&1 || true; fi
  if [[ $KEEP -eq 1 ]]; then
    echo "The stack is still up. Tear it down with:"
    echo "  COMPOSE_PROJECT_NAME=foc-load COMPOSE_FILE=$COMPOSE_FILE docker compose down -v"
  else
    echo "Tearing down the load stack..."
    docker compose down -v >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

psql_run() { # database; SQL on stdin; stops on the first error
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "$1" -v ON_ERROR_STOP=1 -qtAX -f -
}

step "Starting the load stack" "Project foc-load, the User Service's sign-in limits raised (compose.load.yaml)."
if ! docker compose up -d --build --wait >/dev/null 2>&1; then
  fail "the stack did not come up healthy"
  docker compose ps -a
  exit 1
fi
pass "the stack is healthy"

# ---- seed -----------------------------------------------------------------------------------
step "Seeding" "$STUDENTS students who can sign in, $SUPPLIERS suppliers, $WALLETS wallets."
SIGNUP_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export SIGNUP_PASSWORD
for n in $(seq 1 "$STUDENTS"); do
  signup "load-$n"
  if [[ $n -eq 1 ]]; then TEMPLATE="$STUDENT_ID"; fi
done

# The rest of the data, as copies of what the services made: a seeded supplier (cycling through
# all of them), and the first student's wallet with its issue transaction and ledger lines. Same
# shape, so every constraint and the double-entry ledger still hold. `sql` prints nothing when a
# query fails, so each count is checked before the SQL uses it.
have=$(sql foc_supplier "SELECT count(*) FROM suppliers WHERE active")
if ! [[ "$have" =~ ^[1-9][0-9]*$ ]]; then
  fail "no active supplier to copy (counted '${have}'): the Supplier Service's seed did not load"
  exit 1
fi
psql_run foc_supplier <<SQL
INSERT INTO suppliers (supplier_id, name, type, building, floor, location_description,
                       opening_hours, latitude, longitude, image_url, tags)
SELECT gen_random_uuid(), left(s.name, 180) || ' ' || g, s.type, s.building, s.floor,
       s.location_description, s.opening_hours, s.latitude, s.longitude, s.image_url, s.tags
  FROM generate_series(1, greatest(0, $SUPPLIERS - $have)) AS g
  CROSS JOIN LATERAL (
    SELECT * FROM suppliers WHERE active ORDER BY supplier_id OFFSET (g % $have) LIMIT 1
  ) AS s;
SQL

have=$(sql foc_credit "SELECT count(*) FROM wallets")
if ! [[ "$have" =~ ^[0-9]+$ ]]; then
  fail "could not count the wallets (got '${have}')"
  exit 1
fi
psql_run foc_credit <<SQL
BEGIN;
CREATE TEMP TABLE load_wallets AS
  SELECT 'load-' || lpad(g::text, 6, '0') AS user_id, gen_random_uuid() AS tx
    FROM generate_series(1, greatest(0, $WALLETS - $have)) AS g;
INSERT INTO wallets (user_id, available, reserved)
  SELECT l.user_id, w.available, w.reserved FROM load_wallets l, wallets w WHERE w.user_id = '$TEMPLATE';
INSERT INTO credit_transactions (transaction_id, transaction_type, wallet_user_id, amount)
  SELECT l.tx, t.transaction_type, l.user_id, t.amount
    FROM load_wallets l, credit_transactions t
   WHERE t.wallet_user_id = '$TEMPLATE' AND t.transaction_type = 'ISSUE';
INSERT INTO ledger_entries (entry_id, transaction_id, entry_no, wallet_user_id, account, direction,
                            amount, resulting_available, resulting_reserved)
  SELECT gen_random_uuid(), l.tx, e.entry_no,
         CASE WHEN e.wallet_user_id IS NULL THEN NULL ELSE l.user_id END,
         e.account, e.direction, e.amount, e.resulting_available, e.resulting_reserved
    FROM load_wallets l, ledger_entries e
    JOIN credit_transactions t ON t.transaction_id = e.transaction_id
   WHERE t.wallet_user_id = '$TEMPLATE' AND t.transaction_type = 'ISSUE';
COMMIT;
SQL

# What was made, counted, rather than what was asked for: these go in the report.
seeded() { # what count target
  if [[ "$2" =~ ^[0-9]+$ ]] && ((10#$2 >= $3)); then
    pass "$2 $1"
  else
    fail "$1: ${2:-none counted}, below the $3 wanted"
  fi
}
SEEDED_STUDENTS=$(sql foc_user "SELECT count(*) FROM users WHERE status = 'ACTIVE' AND email LIKE 'demo-load-%-${RUN}@%'")
seeded "students who can sign in" "$SEEDED_STUDENTS" "$STUDENTS"
SEEDED_SUPPLIERS=$(sql foc_supplier "SELECT count(*) FROM suppliers WHERE active")
seeded "active suppliers" "$SEEDED_SUPPLIERS" "$SUPPLIERS"
# A wallet copied without its issue transaction would break the ledger, so count only whole ones.
SEEDED_WALLETS=$(sql foc_credit "SELECT count(*) FROM wallets w WHERE EXISTS (
  SELECT 1 FROM credit_transactions t WHERE t.wallet_user_id = w.user_id AND t.transaction_type = 'ISSUE')")
seeded "wallets, each with its issue transaction" "$SEEDED_WALLETS" "$WALLETS"

# ---- measure --------------------------------------------------------------------------------
OUT=$(mktemp -d)
# Anything else on this machine competes with the stack for its CPUs, so the report says what.
OTHER_CONTAINERS=$(docker ps --format '{{.Names}}' | grep -vc '^foc-load-' || true)
# As this machine's user: on Docker Engine a bind mount keeps the host's owner, and k6's own user
# could not write its summary into the directory mktemp made.
# On the stack's own network, to each service directly: their ports here are on 127.0.0.1, which a
# container cannot reach through the host on Linux, and the edge (PLT-10) would count every
# virtual user as one address against its write limit. This measures the services, not the edge.
k6() { # script
  docker run --rm --user "$(id -u):$(id -g)" --network "${COMPOSE_PROJECT_NAME}_gateway" \
    -v "$PWD/load:/load:ro" -v "$OUT:/out" \
    -e USER_URL=http://user-service:3001 \
    -e SUPPLIER_URL=http://supplier-service:3002 \
    -e CREDIT_URL=http://credit-service:3004 \
    -e ORIGIN="$CORS_ORIGINS" -e RUN="$RUN" -e EMAIL_DOMAIN="$EMAIL_DOMAIN" -e PASSWORD="$SIGNUP_PASSWORD" \
    -e STUDENTS="$STUDENTS" -e VUS="$VUS" -e DURATION_S="$DURATION_S" -e THINK_S="$THINK_S" \
    "$K6" run --quiet --no-usage-report "/load/$1.js"
}
# N1.4 (#332): live updates under load. LIVE_STUDENTS students hold STREAMS_EACH streams each, the
# Order Service's own cap per user, for the whole of the scenarios below, so those are measured
# with the streams open. Meanwhile an errand is posted and accepted at a steady rate, and each
# accept is timed to its nudge on the requester's stream. Straight to the Order Service, like k6:
# the edge would cap one address at ten streams. It writes live.json beside k6's summaries.
step "Holding live-update streams" "$LIVE_STUDENTS students x $STREAMS_EACH streams; $LIVE_ERRANDS accepts timed to their nudge, while the scenarios run."
LIVE=$(docker run -d --user "$(id -u):$(id -g)" --network "${COMPOSE_PROJECT_NAME}_gateway" \
  -v "$PWD/load:/load:ro" -v "$OUT:/out" \
  -e USER_URL=http://user-service:3001 \
  -e SUPPLIER_URL=http://supplier-service:3002 \
  -e ORDER_URL=http://order-service:3003 \
  -e ORIGIN="$CORS_ORIGINS" -e RUN="$RUN" -e EMAIL_DOMAIN="$EMAIL_DOMAIN" -e PASSWORD="$SIGNUP_PASSWORD" \
  -e LIVE_STUDENTS="$LIVE_STUDENTS" -e STREAMS_EACH="$STREAMS_EACH" -e LIVE_ERRANDS="$LIVE_ERRANDS" \
  -e LIVE_SECONDS="$((DURATION_S * 3))" \
  "$NODE" node /load/live.mjs)
for script in user supplier credit; do
  step "Measuring: $script" "$VUS virtual users for $DURATION_S s per scenario, ${THINK_S} s between requests."
  # k6 exits 99 when a threshold is missed: a result for the report, which then fails the run,
  # not a reason to stop measuring.
  status=0
  k6 "$script" || status=$?
  if [[ $status -ne 0 && $status -ne 99 ]]; then
    fail "k6 did not run $script.js (exit $status)"
  fi
done

step "Live updates" "Waiting for the streams' client to finish its last accept."
live_status=$(docker wait "$LIVE" 2>/dev/null || echo 1)
docker logs "$LIVE" 2>&1 | tail -3 | sed 's/^/  /'
docker rm "$LIVE" >/dev/null 2>&1 || true
LIVE=""
if [[ "$live_status" == 0 && -s "$OUT/live.json" ]]; then
  pass "the live-update client finished: live.json written"
else
  fail "the live-update client stopped (exit $live_status), so live updates are not measured"
fi

# Student 1 signs in again: a token from seeding is too old by now (they live 15 minutes), and
# the restart checks below need one from before the restart.
FIRST_TOKEN=$(curl -fsS -X POST "http://localhost:${USER_PORT}/auth/login" -H 'content-type: application/json' \
  -H "Origin: http://localhost:${WEB_PORT}" \
  -d "{\"email\":\"demo-load-1-$RUN@$EMAIL_DOMAIN\",\"password\":\"$SIGNUP_PASSWORD\"}" 2>/dev/null | json 'd["accessToken"]') || true
if [[ -z "$FIRST_TOKEN" ]]; then
  fail "student 1 could not sign in again for the ordering and restart checks"
fi

# SS-NFR2.1.2: the same query, twice, on unchanged data.
ids() { curl -fsS "http://localhost:${SUPPLIER_PORT}/suppliers?$1" -H "Authorization: Bearer $FIRST_TOKEN" | json '",".join(i["supplierId"] for i in d["items"])'; }
stable=yes
for query in "page=3&pageSize=20&sort=name" "q=Cafe&pageSize=20" "type=FOOD&sort=building&order=desc&pageSize=20"; do
  [[ "$(ids "$query")" == "$(ids "$query")" && -n "$(ids "$query")" ]] || stable=no
done
if [[ $stable == yes ]]; then
  pass "repeated supplier queries return the same order"
else
  fail "a repeated supplier query came back in another order"
fi

# US-NFR3.1.2 and CS-NFR3.1.2: restart, and time until the service says it is healthy again.
seconds_until_healthy() { # service port
  local start
  start=$(python3 -c 'import time; print(time.time())')
  docker compose restart "$1" >/dev/null 2>&1
  wait_for 120 200 curl -s -o /dev/null -w '%{http_code}' "http://localhost:$2/health" >/dev/null || true
  python3 -c "import time; print(round(time.time() - $start, 1))"
}
step "Restarting" "Each service is restarted and timed until /health answers 200 again."
USER_READY=$(seconds_until_healthy user-service "$USER_PORT")
SESSION=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${USER_PORT}/users/me" -H "Authorization: Bearer $FIRST_TOKEN")
CREDIT_READY=$(seconds_until_healthy credit-service "$CREDIT_PORT")
WALLET=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${CREDIT_PORT}/wallets/me" -H "Authorization: Bearer $FIRST_TOKEN")
echo "  user-service ready after ${USER_READY} s (a session from before: $SESSION); credit-service after ${CREDIT_READY} s (wallet read: $WALLET)"

# ---- report ---------------------------------------------------------------------------------
if [[ $QUICK -eq 1 ]]; then
  echo
  if [[ $FAILURES -eq 0 ]]; then
    echo "Quick run: the harness works. Figures from 10 users are not the D1 targets; no report written."
    exit 0
  fi
  echo "Quick run: $FAILURES check(s) failed; see above. No report written."
  exit 1
fi
REPORT="docs/reports/load-$(date +%F).md"
# report.py exits 3 when the report says a target was missed.
missed=0
STUDENTS="$SEEDED_STUDENTS" SUPPLIERS="$SEEDED_SUPPLIERS" WALLETS="$SEEDED_WALLETS" USER_READY="$USER_READY" \
  SESSION="$SESSION" CREDIT_READY="$CREDIT_READY" WALLET="$WALLET" STABLE="$stable" \
  OTHER_CONTAINERS="$OTHER_CONTAINERS" python3 load/report.py "$OUT" "$REPORT" || missed=$?
case $missed in
  0) pass "report written to $REPORT: every target met (k6's own results are in $OUT)" ;;
  3) fail "report written to $REPORT: a target was missed, as it says (k6's own results are in $OUT)" ;;
  *) fail "the report could not be written (exit $missed)" ;;
esac
echo
if [[ $FAILURES -eq 0 ]]; then
  echo "Done. Read $REPORT."
else
  echo "$FAILURES check(s) failed; see above and $REPORT."
  exit 1
fi
