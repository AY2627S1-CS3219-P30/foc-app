#!/usr/bin/env bash
# Restart, recreate and dependency-loss check for the containerized stack
# (PLT-06; PL-NFR3.1.1, PL-NFR3.1.2; D3 Part 4.2 and 4.3).
#
#   ./scripts-restart-check.sh         against the stack that is already up
#   ./scripts-restart-check.sh --up    bring up a separate copy, delete it after
#
# It builds some state, leaves a message waiting in a queue, and then does to
# the stack what an operator or a power cut would:
#
#   1. stops every container and starts them again;
#   2. removes every container and creates them again (`down`, then `up`: the
#      volumes are kept);
#   3. stops Postgres under the running services, then starts it.
#
# After each it checks that nothing committed was lost, that the waiting message
# was handled, and handled once. During 3 it checks that every service says it
# is unavailable (health 503, a write 503) rather than accepting a change it
# cannot record, and that it recovers by itself.
#
# Without --up this restarts and recreates the containers of YOUR running stack.
# Its data is kept (no volume is removed), but it is down for a minute or two,
# and the run leaves two students and three errands of its own in it.
#
# Fails loudly with a non-zero exit code, like scripts-smoke.sh.
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh
. ./scripts-lib.sh
# The balances checked below (10/0, 7/3, ...) are for the default allocation of 10 credits.
REQUIRED_ALLOCATION=10

TEARDOWN=0
DISRUPTED=0
SERVICES=(user-service supplier-service order-service credit-service chat-service)
PORTS=("$USER_PORT" "$SUPPLIER_PORT" "$ORDER_PORT" "$CREDIT_PORT" "$CHAT_PORT")
# What all_health says with every service up, and with every one refusing: one code per port.
ALL_UP="${PORTS[*]/*/200}"
ALL_DOWN="${PORTS[*]/*/503}"

# Set before anything is started or stopped, so no way out of the script skips it.
cleanup() {
  local status=$?
  if [[ $TEARDOWN -eq 1 ]]; then
    if [[ $status -ne 0 ]]; then
      echo "Restart check failed. Last 60 log lines from each container:"
      docker compose logs --no-color --tail=60 || true
    fi
    echo "Tearing down..."
    docker compose down -v >/dev/null 2>&1 || true
  elif [[ $DISRUPTED -eq 1 ]]; then
    # Once this has stopped anything, leave the stack running rather than half stopped,
    # however the run ended. Before that it has changed nothing and starts nothing.
    echo "Making sure every container is running again..."
    docker compose up -d >/dev/null 2>&1 || true
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
  export COMPOSE_PROJECT_NAME=foc-restart
  TEARDOWN=1
  echo "Bringing up a separate copy of the stack (project 'foc-restart')..."
  docker compose up -d --build >/dev/null
fi

# ---- helpers ------------------------------------------------------------------
# Runs a Compose command that changes the stack. A failure is recorded with what Compose said:
# under `set -e` a bare failing command would end the run without a word.
compose_do() {
  local out
  DISRUPTED=1
  out=$(docker compose "$@" 2>&1) || fail "docker compose $* failed: $(tail -1 <<<"$out")"
}

health_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$1/health" 2>/dev/null || true; }

# "$ALL_UP" when every service is healthy.
all_health() {
  local codes=() port
  for port in "${PORTS[@]}"; do codes+=("$(health_code "$port")"); done
  echo "${codes[*]}"
}

# Every table of every service's database, with its row count: "db.table=n ...".
snapshot() {
  local db
  for db in foc_user foc_supplier foc_order foc_credit foc_chat; do
    sql "$db" "
      SELECT coalesce(string_agg(format('%s.%s=%s', current_database(), c.relname,
               (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, true, '')))[1]::text),
               ' ' ORDER BY c.relname), '')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'"
  done | tr '\n' ' '
}

# Tables that hold fewer rows now than in the earlier snapshot; nothing if none.
lost_rows() { # before after
  python3 -c '
import sys
before = dict(pair.split("=") for pair in sys.argv[1].split())
after = dict(pair.split("=") for pair in sys.argv[2].split())
lost = []
for table in sorted(before):
    now = after.get(table)
    if now is None or int(now) < int(before[table]):
        lost.append("%s %s->%s" % (table, before[table], "gone" if now is None else now))
print(", ".join(lost))' "$1" "$2" 2>/dev/null || echo "could not compare"
}

# Creates an errand worth 3 credits as the requester. Sets ERRAND_ID (empty on failure).
create_errand() { # label
  ERRAND_ID=$(post_errand "$REQUESTER_TOKEN" "$SUPPLIER_ID" 3 "restart-$1")
}

reserves() { sql foc_credit "SELECT count(*) FROM credit_transactions WHERE order_id = '$1' AND transaction_type = 'RESERVE'"; }
queue_depth() { # queue
  curl -fsS -u "$RABBIT_AUTH" "$RABBIT_API/queues/%2F/$1" 2>/dev/null | json 'd.get("messages", 0)'
}
# A durable queue of the check's own holding one persistent message that nothing consumes: what
# the broker itself kept, whatever the services then do about their own queues.
MARKER_QUEUE="foc.restart-check.$RUN"
leave_marker() {
  curl -fsS -u "$RABBIT_AUTH" -H 'content-type: application/json' -X PUT \
    "$RABBIT_API/queues/%2F/$MARKER_QUEUE" -d '{"durable":true}' >/dev/null 2>&1 || true
  curl -fsS -u "$RABBIT_AUTH" -H 'content-type: application/json' -X POST \
    "$RABBIT_API/exchanges/%2F/amq.default/publish" \
    -d "{\"properties\":{\"delivery_mode\":2},\"routing_key\":\"$MARKER_QUEUE\",\"payload\":\"kept\",\"payload_encoding\":\"string\"}" \
    2>/dev/null | json 'd["routed"]' || true
}
drop_marker() {
  curl -fsS -u "$RABBIT_AUTH" -X DELETE "$RABBIT_API/queues/%2F/$MARKER_QUEUE" >/dev/null 2>&1 || true
}
started_at() { docker inspect -f '{{.State.StartedAt}}/{{.RestartCount}}' "$(docker compose ps -q "$1")" 2>/dev/null || true; }

# What must hold after the stack has come back: nothing lost, the waiting errand
# opened, its reward reserved once, the wallet where the arithmetic puts it.
check_recovered() { # what waiting-errand expected-wallet
  local now
  wait_for 180 "$ALL_UP" all_health &&
    pass "every service is healthy again after $1" ||
    fail "after $1, health is '${LAST:-unknown}'"
  now=$(snapshot)
  local lost
  lost=$(lost_rows "$BEFORE" "$now")
  [[ -z "$lost" ]] && pass "no table in any of the five databases lost a row" || fail "rows lost: $lost"
  wait_for 60 1 queue_depth "$MARKER_QUEUE" &&
    pass "the broker still holds the message that was left in a queue" ||
    fail "the message left in $MARKER_QUEUE is gone (the queue holds '${LAST:-nothing}')"
  [[ "$(errand "$REQUESTER_TOKEN" "$FIRST_ERRAND")" == "OPEN 2" ]] &&
    pass "the errand from before is as it was (OPEN), read with the token issued before" ||
    fail "the earlier errand reads '$(errand "$REQUESTER_TOKEN" "$FIRST_ERRAND")'"
  wait_for 120 "OPEN 2" errand "$REQUESTER_TOKEN" "$2" &&
    pass "the errand that was waiting for Credit opened by itself" ||
    fail "the waiting errand did not open within 120 s (last: '${LAST:-nothing}')"
  [[ "$(reserves "$2")" == "1" && "$(wallet "$REQUESTER_ID")" == "$3" ]] &&
    pass "its 3 credits were reserved exactly once (wallet $3)" ||
    fail "reserves=$(reserves "$2") wallet=$(wallet "$REQUESTER_ID"), expected 1 and $3"
  BEFORE=$now
}

echo "Waiting for the stack to be healthy..."
wait_for 240 "$ALL_UP" all_health || {
  echo "The stack is not healthy (health: '${LAST:-nothing}'). Start it with 'docker compose up -d', or run with --up."
  exit 1
}

# ---- 0. some state to keep -----------------------------------------------------
step "0. State to keep" \
  "A student with a wallet, and an errand whose reward is reserved."
signup requester
REQUESTER_ID=$STUDENT_ID
REQUESTER_TOKEN=$STUDENT_TOKEN
SUPPLIER_ID=$(first_supplier "$REQUESTER_TOKEN")
create_errand first
FIRST_ERRAND=$ERRAND_ID
if [[ -z "$FIRST_ERRAND" ]]; then
  echo "Could not create an errand; nothing to check." >&2
  exit 1
fi
wait_for 60 "OPEN 2" errand "$REQUESTER_TOKEN" "$FIRST_ERRAND" && [[ "$(wallet "$REQUESTER_ID")" == "7/3" ]] &&
  pass "an errand is open with 3 credits reserved (wallet 7/3)" ||
  fail "setup: errand '$(errand "$REQUESTER_TOKEN" "$FIRST_ERRAND")', wallet '$(wallet "$REQUESTER_ID")'"
BEFORE=$(snapshot)
tables=$(wc -w <<<"$BEFORE" | tr -d ' ')
[[ "$tables" -ge 8 ]] && pass "counted the rows of $tables tables across the five databases" ||
  fail "could only count $tables tables: '$BEFORE'"
[[ "$(leave_marker)" == "True" ]] && wait_for 30 1 queue_depth "$MARKER_QUEUE" &&
  pass "left one persistent message in a durable queue that nothing consumes" ||
  fail "could not leave a message in $MARKER_QUEUE"

# ---- 1. every container stopped, then started -----------------------------------
step "1. Every container is stopped and started again" \
  "With a request to Credit still waiting in its queue."
compose_do stop credit-service
create_errand restarted
SECOND=$ERRAND_ID
[[ -n "$SECOND" && "$(errand "$REQUESTER_TOKEN" "$SECOND")" == "PENDING_CREDIT 1" ]] &&
  pass "a second errand waits for Credit, which is stopped" ||
  fail "the second errand reads '$(errand "$REQUESTER_TOKEN" "${SECOND:-none}")'"
wait_for 30 1 queue_depth foc.credit.reservations &&
  pass "its reservation request is waiting in the broker" ||
  fail "foc.credit.reservations holds ${LAST:-nothing}, expected 1"
compose_do stop
[[ -z "$(docker compose ps -q --status running)" ]] && pass "every container is stopped" || fail "some container is still running"
compose_do start
check_recovered "a full stop and start" "$SECOND" "4/6"

# ---- 2. every container removed, then created ------------------------------------
step "2. Every container is removed and created again (down, then up)" \
  "The volumes are kept. A request to Credit is waiting in its queue again."
compose_do stop credit-service
create_errand recreated
THIRD=$ERRAND_ID
[[ -n "$THIRD" && "$(errand "$REQUESTER_TOKEN" "$THIRD")" == "PENDING_CREDIT 1" ]] &&
  pass "a third errand waits for Credit, which is stopped" ||
  fail "the third errand reads '$(errand "$REQUESTER_TOKEN" "${THIRD:-none}")'"
wait_for 30 1 queue_depth foc.credit.reservations &&
  pass "its reservation request is waiting in the broker" ||
  fail "foc.credit.reservations holds ${LAST:-nothing}, expected 1"
compose_do down
[[ -z "$(docker compose ps -aq)" ]] && pass "every container is gone" || fail "some container was not removed"
compose_do up -d
check_recovered "being recreated" "$THIRD" "1/9"

# PLT-10: one service recreated while the edge keeps running. The edge asks Docker's DNS again
# every 10 s, so it reaches the new container, at whatever address it got, with no restart of
# its own.
through_edge() { curl -s -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/api/$1/health" 2>/dev/null || echo 000; }
edge_started=$(started_at edge)
compose_do up -d --force-recreate --no-deps order-service
wait_for 90 200 through_edge order &&
  pass "the edge reaches the recreated Order Service without restarting" ||
  fail "after recreating the Order Service, /api/order/health through the edge is '${LAST:-nothing}'"
[[ "$(started_at edge)" == "$edge_started" ]] && pass "the edge itself was not restarted" ||
  fail "the edge was restarted ($edge_started, now $(started_at edge))"

drop_marker

# ---- 3. the database goes away under the running services -------------------------
step "3. Postgres is stopped while the services run" \
  "Each must say it is unavailable, refuse to accept what it cannot record, and recover by itself."
declare -a STARTED
for i in "${!SERVICES[@]}"; do STARTED[i]=$(started_at "${SERVICES[i]}"); done
compose_do stop postgres
wait_for 60 "$ALL_DOWN" all_health &&
  pass "every service's health check fails with 503" ||
  fail "with Postgres stopped, health is '${LAST:-unknown}'"
body=$(curl -s --max-time 5 "http://localhost:${USER_PORT}/health" 2>/dev/null || true)
[[ "$(json '"{} {}".format(d["status"], d["dependencies"]["database"])' <<<"$body")" == "unavailable down" ]] &&
  pass "it says why: status unavailable, database down" ||
  fail "the User Service's health body was: ${body:-nothing}"
headers=$(mktemp)
written=$(curl -s -D "$headers" -o /dev/null -w '%{http_code}' --max-time 15 -X POST "http://localhost:${USER_PORT}/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"restart-refused-$RUN@$EMAIL_DOMAIN\",\"password\":\"$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')\",\"displayName\":\"Refused\"}" 2>/dev/null || true)
retry=$(grep -i '^retry-after:' "$headers" | tr -d '\r' | awk '{print $2}' || true)
rm -f "$headers"
[[ "$written" == "503" && -n "$retry" ]] &&
  pass "a write is refused with 503 and Retry-After: $retry, not accepted and lost" ||
  fail "a registration with Postgres stopped returned $written (Retry-After: '${retry:-none}')"
created=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "http://localhost:${ORDER_PORT}/orders" \
  -H "Authorization: Bearer $REQUESTER_TOKEN" -H 'content-type: application/json' -H "Idempotency-Key: restart-refused-$RUN" \
  -d "{\"supplierId\":\"$SUPPLIER_ID\",\"items\":[{\"name\":\"Chicken rice\",\"quantity\":1}],\"deliveryZone\":\"COM2 Lobby\",\"deliveryInstructions\":\"x\",\"reward\":1}" 2>/dev/null || true)
[[ "$created" == "503" ]] && pass "so is creating an errand (503)" || fail "creating an errand with Postgres stopped returned $created"

compose_do start postgres
wait_for 120 "$ALL_UP" all_health &&
  pass "every service is healthy again once Postgres is back" ||
  fail "after Postgres came back, health is '${LAST:-unknown}'"
same=1
for i in "${!SERVICES[@]}"; do
  [[ -n "${STARTED[i]}" && "$(started_at "${SERVICES[i]}")" == "${STARTED[i]}" ]] || same=0
done
[[ $same -eq 1 ]] && pass "without a restart: each service is the same process as before" ||
  fail "a service restarted or crashed while Postgres was away"
signup returned
[[ "$(wallet "$STUDENT_ID")" == "10/0" ]] &&
  pass "and writes work again: a new student signed up and has a wallet" ||
  fail "after recovery, a new student's wallet is '$(wallet "$STUDENT_ID")'"
lost=$(lost_rows "$BEFORE" "$(snapshot)")
[[ -z "$lost" ]] && pass "no table lost a row while Postgres was away" || fail "rows lost: $lost"

# ---- 4. conservation -------------------------------------------------------------
step "4. After all of that, the closed economy still balances" \
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
  echo "All restart checks passed."
  echo "Not shown here, because it is the one thing that deletes data: 'docker compose down -v'"
  echo "removes the volumes, and with them every user, errand, wallet and queued message."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
