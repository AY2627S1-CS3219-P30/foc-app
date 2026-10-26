#!/usr/bin/env bash
# Credit walkthrough for the containerized stack (CRD-09; D3 Part 2.3).
#
#   ./scripts-demo-credits.sh         against the stack that is already up
#   ./scripts-demo-credits.sh --up    bring up a separate copy, delete it after
#
# Two new students, a requester and a courier, go through the three things the
# Credit Service does with an errand's reward: reserve it when the errand is
# posted, transfer it when receipt is confirmed, and release it when an errand
# is cancelled. Before and after each one it prints both wallets as their owners
# read them (GET /wallets/me) and the ledger lines the operation wrote, then
# checks the closed economy on the live database.
#
# Safe to run again and again: every run signs up its own students. The balances
# it expects are relative to what the service issued them (their ISSUE rows), so
# it passes with any INITIAL_CREDIT_ALLOCATION.
#
# Fails loudly with a non-zero exit code, like scripts-smoke.sh.
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh

. ./scripts-lib.sh

TEARDOWN=0
cleanup() {
  local status=$?
  if [[ $TEARDOWN -eq 1 ]]; then
    if [[ $status -ne 0 ]]; then
      echo "Walkthrough failed. Last 60 log lines from each service:"
      docker compose logs --no-color --tail=60 user-service order-service credit-service || true
    fi
    echo "Tearing down..."
    docker compose down -v >/dev/null 2>&1 || true
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
  export COMPOSE_PROJECT_NAME=foc-credits
  TEARDOWN=1
  echo "Bringing up a separate copy of the stack (project 'foc-credits')..."
  docker compose up -d --build --wait >/dev/null
fi

for port in "$USER_PORT" "$SUPPLIER_PORT" "$ORDER_PORT" "$CREDIT_PORT"; do
  curl -fsS -o /dev/null "http://localhost:${port}/health" 2>/dev/null || {
    echo "Nothing answers on port $port. Start the stack with 'docker compose up -d', or run with --up."
    exit 1
  }
done

# ---- helpers ------------------------------------------------------------------
# The shared ones (json, sql, wait_for, signup, errand) are in scripts-lib.sh.

# A wallet as its owner reads it through the API: "available/reserved".
balance() { # token
  curl -fsS "http://localhost:${CREDIT_PORT}/wallets/me" -H "Authorization: Bearer $1" 2>/dev/null |
    json '"{}/{}".format(d["available"], d["reserved"])' || true
}

TABLE=()
# Prints both wallets and keeps the line for the summary at the end.
show() { # label
  local requester courier
  requester=$(balance "$REQUESTER_TOKEN")
  courier=$(balance "$COURIER_TOKEN")
  printf '  %-34s requester %-7s courier %s\n' "$1" "$requester" "$courier"
  TABLE+=("$(printf '| %-34s | %-9s | %-7s |' "$1" "$requester" "$courier")")
}

# Checks both wallets against the expected "available/reserved" pairs.
expect_balances() { # requester courier why
  local requester courier
  requester=$(balance "$REQUESTER_TOKEN")
  courier=$(balance "$COURIER_TOKEN")
  [[ "$requester" == "$1" && "$courier" == "$2" ]] &&
    pass "$3: requester $1, courier $2" ||
    fail "$3: expected requester $1 and courier $2, saw $requester and $courier"
}

# The ledger lines one order's transaction of one type wrote, named by whose account they are.
ledger_lines() { # order-id type
  sql foc_credit "
    SELECT format('      %s %-17s %-6s %s', CASE e.wallet_user_id WHEN '$REQUESTER_ID' THEN 'requester'
                                                      WHEN '$COURIER_ID' THEN 'courier  '
                                                      ELSE 'platform ' END,
                  e.account, e.direction, e.amount)
      FROM credit_transactions t JOIN ledger_entries e USING (transaction_id)
     WHERE t.order_id = '$1' AND t.transaction_type = '$2'
     ORDER BY e.entry_no"
}

# Posts an errand worth `reward` and waits until Credit has reserved it. Sets ERRAND_ID, which is
# empty unless the errand opened, so later steps never act on an errand that is still waiting.
open_errand() { # reward label
  ERRAND_ID=$(post_errand "$REQUESTER_TOKEN" "$SUPPLIER_ID" "$1" "credits-$2")
  if [[ -z "$ERRAND_ID" ]]; then
    fail "posting the $2 errand failed"
    return 1
  fi
  if wait_for 60 "OPEN 2" errand "$REQUESTER_TOKEN" "$ERRAND_ID"; then
    pass "the errand is OPEN: Credit reserved its $1 credits"
  else
    fail "the $2 errand did not open: '${LAST:-nothing}' (is the Credit Service running?)"
    ERRAND_ID=""
    return 1
  fi
}

# Must succeed, or the step stops here with the reason.
act() { # token order action version who
  local code
  code=$(errand_action "$1" "$2" "$3" "$4")
  [[ "$code" == 2* ]] || { fail "the $5 could not $3 (HTTP $code)"; return 1; }
}

# ---- 0. two new students --------------------------------------------------------
step "0. Two students sign up" \
  "Each activation issues a wallet with the initial allocation (CS-FR1.1.1). Nothing is reserved yet."
signup requester
REQUESTER_ID=$STUDENT_ID
REQUESTER_TOKEN=$STUDENT_TOKEN
A=$STUDENT_ISSUED
signup courier
COURIER_ID=$STUDENT_ID
COURIER_TOKEN=$STUDENT_TOKEN
[[ "$STUDENT_ISSUED" == "$A" ]] || { echo "The two wallets were issued $A and $STUDENT_ISSUED credits." >&2; exit 1; }
SUPPLIER_ID=$(first_supplier "$REQUESTER_TOKEN")
[[ -n "$SUPPLIER_ID" ]] || { echo "No supplier to pick up from." >&2; exit 1; }
show "signed up"
expect_balances "$A/0" "$A/0" "both start with the initial allocation of $A"

# ---- 1. reserve -----------------------------------------------------------------
step "1. Reserve: the requester posts an errand worth 3 credits" \
  "Order saves it as PENDING_CREDIT and asks Credit by event. Credit moves 3 from available to reserved."
show "before the reservation"
open_errand 3 paid || true
PAID=$ERRAND_ID
show "after the reservation"
echo "    ledger, RESERVE:"
ledger_lines "$PAID" RESERVE
expect_balances "$((A - 3))/3" "$A/0" "the reward is held, not spent"

# ---- 2. transfer ----------------------------------------------------------------
step "2. Transfer: the courier delivers and the requester confirms receipt" \
  "Credit takes the 3 out of the requester's reserved credits and adds them to the courier's available."
if [[ -n "$PAID" ]]; then
  act "$COURIER_TOKEN" "$PAID" accept 2 courier &&
    act "$COURIER_TOKEN" "$PAID" pickup 3 courier &&
    act "$COURIER_TOKEN" "$PAID" deliver 4 courier || true
  show "delivered, before the transfer"
  expect_balances "$((A - 3))/3" "$A/0" "nothing moves until receipt is confirmed"
  act "$REQUESTER_TOKEN" "$PAID" confirm-receipt 5 requester || true
  wait_for 60 "COMPLETED 7" errand "$REQUESTER_TOKEN" "$PAID" &&
    pass "the errand is COMPLETED: Credit transferred the reward" ||
    fail "the errand did not complete: '${LAST:-nothing}'"
  show "after the transfer"
  echo "    ledger, TRANSFER:"
  ledger_lines "$PAID" TRANSFER
  expect_balances "$((A - 3))/0" "$((A + 3))/0" "the courier earned what the requester had reserved"
else
  fail "skipped: there is no errand from step 1"
fi

# ---- 3. release -----------------------------------------------------------------
step "3. Release: the requester posts a 2-credit errand, then cancels it" \
  "Credit moves the 2 from reserved back to available. The requester ends where they were."
show "before the second reservation"
open_errand 2 cancelled || true
CANCELLED=$ERRAND_ID
show "reserved, before the release"
expect_balances "$((A - 5))/2" "$((A + 3))/0" "the second reward is held"
if [[ -n "$CANCELLED" ]]; then
  act "$REQUESTER_TOKEN" "$CANCELLED" cancel 2 requester || true
  wait_for 60 "CANCELLED 4" errand "$REQUESTER_TOKEN" "$CANCELLED" &&
    pass "the errand is CANCELLED: Credit released the reward" ||
    fail "the errand did not cancel: '${LAST:-nothing}'"
  show "after the release"
  echo "    ledger, RELEASE:"
  ledger_lines "$CANCELLED" RELEASE
  expect_balances "$((A - 3))/0" "$((A + 3))/0" "the release gave back exactly the 2 reserved"
else
  fail "skipped: the cancellable errand did not open"
fi

# ---- 4. the closed economy ------------------------------------------------------
step "4. The closed economy, checked on the live database" \
  "The invariants of ADR 0007 and CRD-09, for every wallet, not only these two (check-invariants)."
pair_total=$(sql foc_credit "SELECT sum(available + reserved) FROM wallets WHERE user_id IN ('$REQUESTER_ID', '$COURIER_ID')")
[[ "$pair_total" == "$((2 * A))" ]] &&
  pass "the two students still hold $((2 * A)) between them: credits moved, none were made or lost" ||
  fail "the two students hold ${pair_total:-?}, not $((2 * A))"
# The same checks the tests run (credit-service/src/credits/invariants.ts), inside the container.
if checks=$(docker compose exec -T credit-service node credit-service/dist/check-invariants.js 2>&1 | tr -d '\r'); then
  while IFS= read -r line; do [[ "$line" == PASS* ]] && pass "${line#PASS  }"; done <<<"$checks"
else
  fail "the closed-economy invariants do not hold:"
  printf '%s\n' "$checks" | sed 's/^/        /'
fi

echo
echo "Balances (available/reserved):"
printf '| %-34s | %-9s | %-7s |\n' "Moment" "Requester" "Courier"
printf '| %-34s | %-9s | %-7s |\n' "----------------------------------" "---------" "-------"
printf '%s\n' "${TABLE[@]}"
echo
if [[ $FAILURES -eq 0 ]]; then
  echo "All credit walkthrough checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
