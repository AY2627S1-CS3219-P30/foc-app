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
# it expects are relative to the initial allocation, so it also passes with
# INITIAL_CREDIT_ALLOCATION set in .env.
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

# Posts an errand worth `reward` and waits until Credit has reserved it.
post_errand() { # reward label → sets ERRAND_ID
  ERRAND_ID=$(curl -fsS -X POST "http://localhost:${ORDER_PORT}/orders" -H "Authorization: Bearer $REQUESTER_TOKEN" \
    -H 'content-type: application/json' -H "Idempotency-Key: credits-$2-$RUN" -H "x-correlation-id: credits-$2-$RUN" \
    -d "{\"supplierId\":\"$SUPPLIER_ID\",\"items\":[{\"name\":\"Chicken rice\",\"quantity\":1}],\"deliveryZone\":\"COM2 Lobby\",\"deliveryInstructions\":\"Meet at the security desk\",\"reward\":$1}" \
    2>/dev/null | json 'd["orderId"]') || true
  [[ -n "$ERRAND_ID" ]] || { fail "posting the $2 errand failed"; return 1; }
  wait_for 60 "OPEN 2" errand "$REQUESTER_TOKEN" "$ERRAND_ID" &&
    pass "the errand is OPEN: Credit reserved its $1 credits" ||
    { fail "the $2 errand did not open: '${LAST:-nothing}'"; return 1; }
}

act() { # token order action version → HTTP status
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${ORDER_PORT}/orders/$2/$3" \
    -H "Authorization: Bearer $1" -H 'content-type: application/json' -d "{\"expectedVersion\":$4}" 2>/dev/null || echo 000
}

# ---- 0. two new students --------------------------------------------------------
step "0. Two students sign up" \
  "Each activation issues a wallet of ${INITIAL_CREDITS} credits (CS-FR1.1.1). Nothing is reserved yet."
signup requester
REQUESTER_ID=$STUDENT_ID
REQUESTER_TOKEN=$STUDENT_TOKEN
signup courier
COURIER_ID=$STUDENT_ID
COURIER_TOKEN=$STUDENT_TOKEN
A=$INITIAL_CREDITS
SUPPLIER_ID=$(curl -fsS "http://localhost:${SUPPLIER_PORT}/suppliers" -H "Authorization: Bearer $REQUESTER_TOKEN" 2>/dev/null |
  json '(lambda items: items[0].get("id") or items[0].get("supplierId"))(d["items"] if isinstance(d, dict) else d)') || true
[[ -n "$SUPPLIER_ID" ]] || { echo "No supplier to pick up from." >&2; exit 1; }
show "signed up"
expect_balances "$A/0" "$A/0" "both start with the initial allocation"

# ---- 1. reserve -----------------------------------------------------------------
step "1. Reserve: the requester posts an errand worth 3 credits" \
  "Order saves it as PENDING_CREDIT and asks Credit by event. Credit moves 3 from available to reserved."
show "before the reservation"
post_errand 3 paid || true
PAID=${ERRAND_ID:-}
show "after the reservation"
echo "    ledger, RESERVE:"
ledger_lines "$PAID" RESERVE
expect_balances "$((A - 3))/3" "$A/0" "the reward is held, not spent"

# ---- 2. transfer ----------------------------------------------------------------
step "2. Transfer: the courier delivers and the requester confirms receipt" \
  "Credit takes the 3 out of the requester's reserved credits and adds them to the courier's available."
if [[ -n "$PAID" ]]; then
  [[ "$(act "$COURIER_TOKEN" "$PAID" accept 2)" == 2* ]] || fail "the courier could not accept"
  [[ "$(act "$COURIER_TOKEN" "$PAID" pickup 3)" == 2* ]] || fail "the courier could not pick up"
  [[ "$(act "$COURIER_TOKEN" "$PAID" deliver 4)" == 2* ]] || fail "the courier could not deliver"
  show "delivered, before the transfer"
  expect_balances "$((A - 3))/3" "$A/0" "nothing moves until receipt is confirmed"
  [[ "$(act "$REQUESTER_TOKEN" "$PAID" confirm-receipt 5)" == 2* ]] || fail "the requester could not confirm receipt"
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
post_errand 2 cancelled || true
CANCELLED=${ERRAND_ID:-}
show "reserved, before the release"
expect_balances "$((A - 5))/2" "$((A + 3))/0" "the second reward is held"
if [[ -n "$CANCELLED" ]]; then
  [[ "$(act "$REQUESTER_TOKEN" "$CANCELLED" cancel 2)" == 2* ]] || fail "the requester could not cancel"
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
  "The invariants of ADR 0007 and CRD-09, for every wallet, not only these two."
pair_total=$(sql foc_credit "SELECT sum(available + reserved) FROM wallets WHERE user_id IN ('$REQUESTER_ID', '$COURIER_ID')")
[[ "$pair_total" == "$((2 * A))" ]] &&
  pass "the two students still hold $((2 * A)) between them: credits moved, none were made or lost" ||
  fail "the two students hold ${pair_total:-?}, not $((2 * A))"
totals=$(sql foc_credit "
  SELECT (SELECT coalesce(sum(available + reserved), 0) FROM wallets) || ' held, ' ||
         (SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE transaction_type = 'ISSUE') || ' issued'")
held=${totals%% held*}
issued=${totals##*, }
issued=${issued%% issued}
[[ -n "$held" && "$held" == "$issued" ]] && pass "every wallet together: $totals" || fail "credits not conserved: ${totals:-no answer}"
unbalanced=$(sql foc_credit "
  SELECT count(*) FROM (
    SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
    HAVING coalesce(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0)
        <> coalesce(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0)) unbalanced")
[[ "$unbalanced" == "0" ]] && pass "every transaction's debits equal its credits" || fail "$unbalanced transaction(s) unbalanced"
unbacked=$(sql foc_credit "
  SELECT count(*) FROM wallets w
    LEFT JOIN (SELECT t.wallet_user_id, sum(t.amount) AS amount FROM credit_transactions t
                WHERE t.transaction_type = 'RESERVE'
                  AND NOT EXISTS (SELECT 1 FROM credit_transactions s
                                   WHERE s.order_id = t.order_id AND s.transaction_type IN ('TRANSFER', 'RELEASE'))
                GROUP BY t.wallet_user_id) r ON r.wallet_user_id = w.user_id
   WHERE w.reserved <> coalesce(r.amount, 0)")
[[ "$unbacked" == "0" ]] && pass "every wallet's reserved credits are its open reservations" ||
  fail "$unbacked wallet(s) hold reserved credits no open reservation accounts for"

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
