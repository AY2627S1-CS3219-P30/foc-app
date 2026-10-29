#!/usr/bin/env bash
# The D3 demo's user journey, as working API calls (PLT-07; D3 Parts 1.3, 1.5, 2.2, 2.3, 3.4).
#
#   ./scripts-demo-journey.sh              against the stack that is already up
#   ./scripts-demo-journey.sh --up         bring up a separate copy, delete it after
#   ./scripts-demo-journey.sh --pause      stop before each part until Enter is pressed (presenting)
#   ./scripts-demo-journey.sh --redrive    also do part E: a dead letter, then its redrive (about 2 min)
#   ./scripts-demo-journey.sh --stage      only prepare part E's dead letter, for redriving live
#   ./scripts-demo-journey.sh --redrive-staged   only redrive the dead letter --stage left (seconds)
#
# Every call is printed as it is made (method, path, who is calling, status), so a presenter can
# narrate it and a mentor can repeat it. It signs up its own students each run, so it can be run
# again and again, and it checks what it shows: the run fails if a status or a balance is not
# what the runbook says it will be (docs/demo/d3-runbook.md).
#
#   A  Registration to allocation: a new student's 10-credit wallet arrives by itself
#   B  An errand end to end: create, accept, pick up, deliver, confirm; both wallets before and after
#   C  A cancellation: the reserved credits return to the requester
#   D  Refusals: your own errand, someone else's errand, a second acceptance, a second completion
#   E  (--redrive) Credit loses its database, an activation is set aside, an operator redrives it
#
# Fails loudly with a non-zero exit code, like scripts-smoke.sh.
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh
. ./scripts-lib.sh

TEARDOWN=0
PAUSE=0
REDRIVE=0
STAGE=0
REDRIVE_STAGED=0
CREDIT_CUT_OFF=0
UP=0
for arg in "$@"; do
  case "$arg" in
    --up) UP=1 ;;
    --pause) PAUSE=1 ;;
    --redrive) REDRIVE=1 ;;
    --stage) STAGE=1 ;;
    --redrive-staged) REDRIVE_STAGED=1 ;;
    *)
      echo "Unknown option: $arg (see the top of this file)" >&2
      exit 2
      ;;
  esac
done
ADMIN_EMAIL="${ADMIN_SEED_EMAILS:-admin@u.nus.edu}"
ADMIN_EMAIL="${ADMIN_EMAIL%%,*}"
# Where the demo keeps what a presenter needs afterwards: git-ignored, readable by its owner.
NOTES=.env.demo.local
NOTES_TMP=.env.demo-tmp.local # also git-ignored (.env.*.local), in case a write is interrupted

# Part E disables the Credit Service's database login to stand in for a lost database. This puts
# it back, and reports success only once Postgres says the role may log in again.
RESTORE_BY_HAND='docker compose exec -T postgres psql -U postgres -c "ALTER ROLE credit_service LOGIN"'
restore_credit_login() {
  sql postgres "ALTER ROLE credit_service LOGIN" >/dev/null
  [[ "$(sql postgres "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'credit_service'")" == "t" ]] || return 1
  CREDIT_CUT_OFF=0
}

# Set before anything is started or changed, so no way out of the script skips it.
cleanup() {
  local status=$?
  if [[ $CREDIT_CUT_OFF -eq 1 ]]; then
    # Part E was interrupted: never leave Credit locked out of its database.
    echo "Giving the Credit Service its database login back..."
    restore_credit_login || echo "  It could not be restored. Do it by hand: $RESTORE_BY_HAND" >&2
  fi
  if [[ $TEARDOWN -eq 1 ]]; then
    if [[ $status -ne 0 ]]; then
      echo "Journey failed. Last 60 log lines from each service:"
      docker compose logs --no-color --tail=60 user-service supplier-service order-service credit-service || true
    fi
    echo "Tearing down..."
    docker compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ $UP -eq 1 ]]; then
  # A Compose project of its own, as in scripts-smoke.sh: the teardown deletes
  # volumes, and under the default project that would be the developer's data.
  if [[ -n "$(docker compose -p foc ps -q 2>/dev/null)" ]]; then
    echo "Your own stack (project 'foc') is running and holds the ports this needs."
    echo "Stop it with 'docker compose stop', or run without --up to use it as it is."
    exit 1
  fi
  export COMPOSE_PROJECT_NAME=foc-journey
  TEARDOWN=1
  echo "Bringing up a separate copy of the stack (project 'foc-journey')..."
  docker compose up -d --build >/dev/null
fi

# ---- helpers ------------------------------------------------------------------
part() { # title what-to-watch
  if [[ $PAUSE -eq 1 ]]; then
    printf '\n\033[2m(Enter for the next part)\033[0m'
    read -r _ </dev/tty || true
  fi
  step "$1" "$2"
}

# Makes one API call and shows it. Sets CODE and BODY.
call() { # who method port path token [json] [idempotency-key]
  local who=$1 method=$2 port=$3 path=$4 token=$5 json=${6:-} key=${7:-} out
  out=$(curl -s -w '\n%{http_code}' -X "$method" "http://localhost:${port}${path}" \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    -H "x-correlation-id: journey-$RUN" ${key:+-H "Idempotency-Key: $key"} ${json:+-d "$json"} 2>/dev/null) || out=$'\n000'
  CODE=$(tail -1 <<<"$out")
  BODY=$(sed '$d' <<<"$out")
  # Shown with each id cut to its first eight characters, so the action is what stands out.
  local shown
  shown=$(sed -E 's/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/\1…/g' <<<"$path")
  printf '    \033[36m%-6s %-44s\033[0m as %-10s \033[1m%s\033[0m\n' "$method" "$shown" "$who" "$CODE"
}
error_code() { json 'd["error"]["code"]' <<<"$BODY"; }
act() { call "$1" POST "$ORDER_PORT" "/orders/$2/$3" "$4" "{\"expectedVersion\":$5}"; } # who order action token version

# A wallet as its owner sees it through the API: "available/reserved".
balance() { # token
  curl -s "http://localhost:${CREDIT_PORT}/wallets/me" -H "Authorization: Bearer $1" 2>/dev/null |
    json '"{}/{}".format(d["available"], d["reserved"])'
}
show_wallets() { # label
  printf '    \033[2m%-28s requester %s   courier %s   (available/reserved)\033[0m\n' "$1" "$(balance "$REQUESTER_TOKEN")" "$(balance "$COURIER_TOKEN")"
}
transfers() { sql foc_credit "SELECT count(*) FROM credit_transactions WHERE order_id = '$1' AND transaction_type = 'TRANSFER'"; }

new_errand() { # label  → ERRAND_ID
  call requester POST "$ORDER_PORT" /orders "$REQUESTER_TOKEN" \
    "{\"supplierId\":\"$SUPPLIER_ID\",\"items\":[{\"name\":\"Chicken rice\",\"quantity\":1}],\"deliveryZone\":\"COM2 Lobby\",\"deliveryInstructions\":\"Meet at the security desk\",\"reward\":3}" \
    "journey-$1-$RUN"
  ERRAND_ID=$(json 'd["orderId"]' <<<"$BODY")
  [[ "$CODE" == "201" && -n "$ERRAND_ID" ]] || {
    fail "creating an errand returned $CODE"
    return 1
  }
  wait_for 60 "OPEN 2" errand "$REQUESTER_TOKEN" "$ERRAND_ID" ||
    fail "the errand did not open: '${LAST:-nothing}'"
}

# Signs the bootstrap administrator in, giving it a password of its own first if it still has the
# seed one. The password is kept in $NOTES for the presenter; it is never printed. Sets ADMIN_TOKEN.
admin_sign_in() {
  local password="" login
  [[ -f "$NOTES" ]] && password=$(awk -F= '$1 == "DEMO_ADMIN_PASSWORD" { print substr($0, length($1) + 2) }' "$NOTES")
  try() { # password → prints the login response
    curl -s -X POST "http://localhost:${USER_PORT}/auth/login" -H 'content-type: application/json' \
      -H "Origin: http://localhost:${WEB_PORT}" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$1\"}" 2>/dev/null || true
  }
  if [[ -n "$password" ]]; then login=$(try "$password"); else login=""; fi
  ADMIN_TOKEN=$(json 'd["accessToken"]' <<<"$login")
  if [[ -z "$ADMIN_TOKEN" ]]; then
    # First use on this stack: replace the seed password, as an operator must before signing in.
    local changed
    password=$(python3 -c 'import secrets; print("Demo-" + secrets.token_urlsafe(15))')
    changed=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${USER_PORT}/auth/password" -H 'content-type: application/json' \
      -H "Origin: http://localhost:${WEB_PORT}" \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"currentPassword\":\"${ADMIN_SEED_PASSWORD:?}\",\"newPassword\":\"$password\"}" 2>/dev/null) || true
    # Saved the moment it is changed, before anything else can fail: a password that was set
    # but not kept would lock the presenter out. Not for a stack that is about to be deleted,
    # whose password would replace the one the presenter's own stack still needs.
    if [[ "$changed" == "204" && $TEARDOWN -eq 0 ]]; then
      (
        umask 077
        { grep -v '^DEMO_ADMIN_PASSWORD=' "$NOTES" 2>/dev/null || true; } >"$NOTES_TMP"
        printf 'DEMO_ADMIN_PASSWORD=%s\n' "$password" >>"$NOTES_TMP"
        mv "$NOTES_TMP" "$NOTES"
      )
    fi
    ADMIN_TOKEN=$(json 'd["accessToken"]' <<<"$(try "$password")")
  fi
  [[ -n "$ADMIN_TOKEN" ]]
}

all_healthy() {
  local port codes=""
  for port in "$USER_PORT" "$SUPPLIER_PORT" "$ORDER_PORT" "$CREDIT_PORT"; do
    codes="$codes$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/health" 2>/dev/null || true) "
  done
  echo "${codes% }"
}
# A run that was killed during part E (a closed terminal, a laptop that slept) could not put the
# Credit Service's database login back. Harmless when it is already there.
sql postgres "ALTER ROLE credit_service LOGIN" >/dev/null

echo "Waiting for the stack to be healthy..."
wait_for 240 "200 200 200 200" all_healthy || {
  echo "The stack is not healthy (health: '${LAST:-nothing}'). Start it with 'docker compose up -d', or run with --up."
  exit 1
}

# ---- E. a dead letter and its redrive ------------------------------------------
# Defined first because --stage runs only its first half.
DEAD_QUEUE=foc.credit.wallet-provisioning
stage_dead_letter() {
  part "E. The Credit Service loses its database for longer than its retries last" \
    "A student activates meanwhile. The activation must be set aside for an operator, not lost and not half-applied."
  CREDIT_CUT_OFF=1
  sql postgres "ALTER ROLE credit_service NOLOGIN" >/dev/null
  sql postgres "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'credit_service'" >/dev/null
  wait_for 30 503 curl -s -o /dev/null -w '%{http_code}' "http://localhost:${CREDIT_PORT}/health" &&
    pass "Credit says it is unavailable (health 503); the other services are unaffected" ||
    fail "Credit's health is ${LAST:-unknown} with its database login disabled"
  signup stranded no-wallet
  STRANDED_ID=$STUDENT_ID
  STRANDED_TOKEN=$STUDENT_TOKEN
  pass "a student registered and activated while Credit was cut off: the User Service did not wait for it"
  echo "    Credit retries the activation after 1, 5, 15 and 60 seconds, then sets it aside. Waiting..."
  wait_for 150 1 queue_depth "$DEAD_QUEUE.dlq" &&
    pass "after five attempts the activation is on Credit's dead-letter queue" ||
    fail "$DEAD_QUEUE.dlq holds ${LAST:-nothing} after 150 s, expected 1"
  restore_credit_login || fail "could not give Credit its database login back; by hand: $RESTORE_BY_HAND"
  wait_for 60 200 curl -s -o /dev/null -w '%{http_code}' "http://localhost:${CREDIT_PORT}/health" &&
    pass "Credit has its database back and is healthy again, without a restart" ||
    fail "Credit's health is ${LAST:-unknown} after its database login was restored"
  wait_for 60 1 sql foc_credit "SELECT count(*) FROM dead_letters WHERE aggregate_id = '$STRANDED_ID' AND redriven_at IS NULL" &&
    pass "the dead letter is parked in Credit's database, waiting for an operator" ||
    fail "no parked dead letter for the stranded student (found ${LAST:-none})"
  DEAD_LETTER_ID=$(sql foc_credit "SELECT id FROM dead_letters WHERE aggregate_id = '$STRANDED_ID' AND redriven_at IS NULL LIMIT 1")
  [[ "$(sql foc_credit "SELECT count(*) FROM wallets WHERE user_id = '$STRANDED_ID'")" == "0" ]] &&
    pass "and the student has no wallet yet: nothing was half-applied" ||
    fail "the stranded student already has a wallet"
}
queue_depth() { # queue
  curl -fsS -u "$RABBIT_AUTH" "$RABBIT_API/queues/%2F/$1" 2>/dev/null | json 'd.get("messages", 0)'
}
redrive_dead_letter() {
  step "E, continued. An operator redrives the dead letter" \
    "The same event goes back on its queue. The student must get exactly one wallet."
  admin_sign_in || {
    fail "could not sign in as $ADMIN_EMAIL (its password is DEMO_ADMIN_PASSWORD in $NOTES, or still the seed one)"
    return
  }
  call admin GET "$CREDIT_PORT" "/admin/dead-letters?status=WAITING" "$ADMIN_TOKEN"
  call admin POST "$CREDIT_PORT" "/admin/dead-letters/$DEAD_LETTER_ID/redrive" "$ADMIN_TOKEN" \
    '{"reason":"Credit database was unavailable; it is back"}'
  [[ "$CODE" == "200" && "$(json 'd["status"]' <<<"$BODY")" == "REDRIVEN" ]] &&
    pass "the redrive is accepted and recorded with who did it and why" ||
    fail "the redrive returned $CODE: $(cut -c1-160 <<<"$BODY")"
  wait_for 30 "10/0" wallet "$STRANDED_ID" &&
    pass "the student's wallet arrives: 10 credits" ||
    fail "the stranded student's wallet is '${LAST:-missing}'"
  issues=$(sql foc_credit "SELECT count(*) FROM credit_transactions WHERE wallet_user_id = '$STRANDED_ID' AND transaction_type = 'ISSUE'")
  [[ "$issues" == "1" ]] && pass "issued exactly once" || fail "the initial credits were issued $issues times"
  call admin POST "$CREDIT_PORT" "/admin/dead-letters/$DEAD_LETTER_ID/redrive" "$ADMIN_TOKEN" '{"reason":"a second try"}'
  [[ "$CODE" == "409" && "$(error_code)" == "ALREADY_REDRIVEN" ]] &&
    pass "a second redrive of the same dead letter is refused (409 ALREADY_REDRIVEN)" ||
    fail "a second redrive returned $CODE $(error_code)"
}

if [[ $STAGE -eq 1 ]]; then
  stage_dead_letter
  admin_sign_in || fail "could not sign in as $ADMIN_EMAIL to check the console login"
  echo
  if [[ $FAILURES -ne 0 ]]; then
    echo "$FAILURES check(s) failed: the dead letter is not ready to redrive."
    exit 1
  fi
  if [[ $TEARDOWN -eq 0 ]]; then
    (
      umask 077
      { grep -v -E '^DEMO_(DEAD_LETTER_ID|STRANDED_STUDENT)=' "$NOTES" 2>/dev/null || true; } >"$NOTES_TMP"
      printf 'DEMO_DEAD_LETTER_ID=%s\nDEMO_STRANDED_STUDENT=%s\n' "$DEAD_LETTER_ID" "$STRANDED_ID" >>"$NOTES_TMP"
      mv "$NOTES_TMP" "$NOTES"
    )
  fi
  echo "Ready for the demo. One dead letter is waiting on $DEAD_QUEUE:"
  echo "  dead letter  $DEAD_LETTER_ID"
  echo "  student      $STRANDED_ID  (activated, no wallet)"
  echo "Redrive it in the admin console's Operations tab, signed in as $ADMIN_EMAIL."
  echo "The admin's password is DEMO_ADMIN_PASSWORD in $NOTES (git-ignored)."
  echo "Afterwards the student's wallet shows 10 credits. If the console fails live:"
  echo "  ./scripts-demo-journey.sh --redrive-staged   (redrives this one through the API, in seconds)"
  exit 0
fi

if [[ $REDRIVE_STAGED -eq 1 ]]; then
  note() { awk -F= -v k="$1" '$1 == k { print substr($0, length($1) + 2) }' "$NOTES" 2>/dev/null || true; }
  DEAD_LETTER_ID=$(note DEMO_DEAD_LETTER_ID)
  STRANDED_ID=$(note DEMO_STRANDED_STUDENT)
  if [[ -z "$DEAD_LETTER_ID" || -z "$STRANDED_ID" ]]; then
    echo "Nothing is staged: $NOTES names no dead letter. Run ./scripts-demo-journey.sh --stage first."
    exit 1
  fi
  redrive_dead_letter
  echo
  [[ $FAILURES -eq 0 ]] && echo "The staged dead letter was redriven." && exit 0
  echo "$FAILURES check(s) failed."
  exit 1
fi

# ---- A. registration to allocation ----------------------------------------------
part "A. Registration to allocation (D3 Part 2.2)" \
  "A student registers and activates with the User Service. The Credit Service is not called: it hears 'user.activated' and issues the wallet."
signup requester no-wallet
REQUESTER_ID=$STUDENT_ID
REQUESTER_TOKEN=$STUDENT_TOKEN
COURIER_TOKEN=$REQUESTER_TOKEN
pass "registered, activated through the emailed link, and signed in"
has_wallet() { [[ -n "$(balance "$1")" ]] && echo yes || echo no; }
wait_for 30 yes has_wallet "$REQUESTER_TOKEN" || true
arrived=$(balance "$REQUESTER_TOKEN")
if [[ "$arrived" == "10/0" ]]; then
  pass "the wallet arrived by itself: 10 available, 0 reserved"
elif [[ -z "$arrived" ]]; then
  fail "the new student has no wallet after 30 s"
else
  fail "the new student's wallet is $arrived, not 10/0"
fi
call requester GET "$CREDIT_PORT" /wallets/me "$REQUESTER_TOKEN"
call requester GET "$CREDIT_PORT" /wallets/me/ledger "$REQUESTER_TOKEN"
[[ "$(json 'len(d["items"])' <<<"$BODY") $(json 'd["items"][0]["type"]' <<<"$BODY")" == "1 ISSUE" ]] &&
  pass "its ledger has one entry: the initial issue" ||
  fail "the new wallet's ledger is: $(cut -c1-160 <<<"$BODY")"
signup courier no-wallet
COURIER_TOKEN=$STUDENT_TOKEN
wait_for 30 yes has_wallet "$COURIER_TOKEN" &&
  pass "a second student, the courier, has a wallet too" ||
  fail "the courier has no wallet after 30 s"

# ---- B. an errand end to end ------------------------------------------------------
part "B. An errand from request to payment (D3 Parts 1.5 and 2.3)" \
  "Order asks Supplier where the pickup is, and asks Credit, by event, to reserve and then transfer the reward."
call requester GET "$SUPPLIER_PORT" "/suppliers?pageSize=1" "$REQUESTER_TOKEN"
SUPPLIER_ID=$(json 'd["items"][0]["supplierId"]' <<<"$BODY")
show_wallets "before"
new_errand paid || true
PAID=$ERRAND_ID
[[ "$(balance "$REQUESTER_TOKEN")" == "7/3" ]] &&
  pass "the errand is OPEN and its 3 credits are reserved: the requester has 7 available, 3 reserved" ||
  fail "after creating: errand '$(errand "$REQUESTER_TOKEN" "$PAID")', requester $(balance "$REQUESTER_TOKEN")"
call courier GET "$ORDER_PORT" "/orders?status=OPEN" "$COURIER_TOKEN"
[[ "$BODY" == *"$PAID"* ]] && pass "the courier sees it among the open errands" || fail "the errand is not in the courier's open list"
# N1.4 (ADR 0011): the requester's page holds a live-update stream through the edge, as the web
# app does, and hears of the accept at once instead of at its next poll.
live=$(mktemp)
command curl -sN --max-time 30 "http://localhost:${WEB_PORT}/api/order/live" \
  -H "Authorization: Bearer $REQUESTER_TOKEN" >"$live" 2>/dev/null &
live_pid=$!
for _ in $(seq 1 30); do grep -q '^event: ready' "$live" && break; sleep 0.1; done
act courier "$PAID" accept "$COURIER_TOKEN" 2
[[ "$CODE" == "201" ]] && pass "the courier accepts it (ACCEPTED)" || fail "accept returned $CODE $(error_code)"
heard=""
for _ in $(seq 1 20); do
  grep -q "\"orderId\":\"$PAID\"" "$live" && heard=yes && break
  sleep 0.1
done
[[ -n "$heard" ]] && pass "the requester's open page hears of it within 2 s, through the edge (N1.4)" ||
  fail "the requester's live-update stream heard nothing of the accept in 2 s: '$(head -c 200 "$live")'"
kill "$live_pid" 2>/dev/null || true
wait "$live_pid" 2>/dev/null || true
rm -f "$live"
act courier "$PAID" pickup "$COURIER_TOKEN" 3
act courier "$PAID" deliver "$COURIER_TOKEN" 4
[[ "$CODE" == "200" && "$(errand "$REQUESTER_TOKEN" "$PAID")" == "DELIVERED 5" ]] &&
  pass "picked up, then delivered (DELIVERED)" ||
  fail "after delivery the errand reads '$(errand "$REQUESTER_TOKEN" "$PAID")'"
show_wallets "delivered, not yet confirmed"
act requester "$PAID" confirm-receipt "$REQUESTER_TOKEN" 5
[[ "$CODE" == "200" ]] && pass "the requester confirms receipt" || fail "confirm-receipt returned $CODE $(error_code)"
wait_for 60 "COMPLETED 7" errand "$REQUESTER_TOKEN" "$PAID" &&
  pass "Credit transferred the reward and the errand is COMPLETED" ||
  fail "the errand did not complete: '${LAST:-nothing}'"
show_wallets "after"
[[ "$(balance "$REQUESTER_TOKEN") $(balance "$COURIER_TOKEN")" == "7/0 13/0" ]] &&
  pass "3 credits moved from the requester's reserve to the courier: 7/0 and 13/0" ||
  fail "balances are requester $(balance "$REQUESTER_TOKEN"), courier $(balance "$COURIER_TOKEN")"
call requester GET "$ORDER_PORT" "/orders/$PAID/history" "$REQUESTER_TOKEN"
history=$(json '" > ".join(e["newStatus"] for e in d["entries"])' <<<"$BODY")
[[ "$history" == "PENDING_CREDIT > OPEN > ACCEPTED > PICKED_UP > DELIVERED > COMPLETION_PENDING_CREDIT > COMPLETED" ]] &&
  pass "its history: $history" ||
  fail "unexpected history: $history"

# ---- C. a cancellation --------------------------------------------------------------
part "C. A cancellation (D3 Part 2.3)" \
  "The requester cancels an open errand. The reserved credits must come back, once."
new_errand cancelled || true
CANCELLED=$ERRAND_ID
show_wallets "reserved again"
act requester "$CANCELLED" cancel "$REQUESTER_TOKEN" 2
[[ "$CODE" == "200" ]] && pass "the requester cancels it" || fail "cancel returned $CODE $(error_code)"
wait_for 60 "CANCELLED 4" errand "$REQUESTER_TOKEN" "$CANCELLED" &&
  pass "Credit released the reservation and the errand is CANCELLED" ||
  fail "the errand did not cancel: '${LAST:-nothing}'"
show_wallets "after the release"
releases=$(sql foc_credit "SELECT count(*) FROM credit_transactions WHERE order_id = '$CANCELLED' AND transaction_type = 'RELEASE'")
[[ "$(balance "$REQUESTER_TOKEN")" == "7/0" && "$releases" == "1" ]] &&
  pass "the 3 credits are available again (7/0), released exactly once" ||
  fail "requester $(balance "$REQUESTER_TOKEN"), releases=$releases"

# ---- D. refusals ----------------------------------------------------------------------
part "D. What the backend refuses (D3 Parts 1.3 and 1.4)" \
  "Authorization is who you are and what you are to this errand. Each refusal comes from the Order Service, not from a hidden button."
signup bystander no-wallet
BYSTANDER_TOKEN=$STUDENT_TOKEN
new_errand refused || true
REFUSED=$ERRAND_ID
act requester "$REFUSED" accept "$REQUESTER_TOKEN" 2
[[ "$CODE $(error_code)" == "403 SELF_ACCEPTANCE_FORBIDDEN" ]] &&
  pass "a requester cannot accept their own errand (403 SELF_ACCEPTANCE_FORBIDDEN)" ||
  fail "accepting your own errand returned $CODE $(error_code)"
act courier "$REFUSED" accept "$COURIER_TOKEN" 2
act bystander "$REFUSED" accept "$BYSTANDER_TOKEN" 2
[[ "$CODE $(error_code)" == "409 ORDER_NOT_OPEN" ]] &&
  pass "a second courier is too late: only one acceptance succeeds (409 ORDER_NOT_OPEN)" ||
  fail "a second acceptance returned $CODE $(error_code)"
act bystander "$REFUSED" pickup "$BYSTANDER_TOKEN" 3
[[ "$CODE $(error_code)" == "403 ACTION_FORBIDDEN" ]] &&
  pass "a student who is neither requester nor courier cannot act on it (403 ACTION_FORBIDDEN)" ||
  fail "a bystander's pickup returned $CODE $(error_code)"
act courier "$REFUSED" deliver "$COURIER_TOKEN" 3
[[ "$CODE $(error_code)" == "409 INVALID_ORDER_STATE" ]] &&
  pass "a step out of order is refused: delivery before pickup (409 INVALID_ORDER_STATE)" ||
  fail "delivering before pickup returned $CODE $(error_code)"
act courier "$REFUSED" pickup "$COURIER_TOKEN" 3
act courier "$REFUSED" deliver "$COURIER_TOKEN" 4
act courier "$REFUSED" confirm-receipt "$COURIER_TOKEN" 5
[[ "$CODE $(error_code)" == "403 ACTION_FORBIDDEN" ]] &&
  pass "the courier cannot confirm their own delivery (403 ACTION_FORBIDDEN)" ||
  fail "the courier confirming receipt returned $CODE $(error_code)"
act requester "$REFUSED" confirm-receipt "$REQUESTER_TOKEN" 5
wait_for 60 "COMPLETED 7" errand "$REQUESTER_TOKEN" "$REFUSED" || fail "the errand did not complete: '${LAST:-nothing}'"
act requester "$REFUSED" confirm-receipt "$REQUESTER_TOKEN" 5
[[ "$CODE $(error_code)" == "409 INVALID_ORDER_STATE" && "$(transfers "$REFUSED")" == "1" && "$(balance "$COURIER_TOKEN")" == "16/0" ]] &&
  pass "a second completion is refused and pays nothing more (409; one transfer; courier 16/0)" ||
  fail "a second completion returned $CODE $(error_code); transfers=$(transfers "$REFUSED"); courier $(balance "$COURIER_TOKEN")"
show_wallets "after two paid errands"

if [[ $REDRIVE -eq 1 ]]; then
  stage_dead_letter
  redrive_dead_letter
fi

# ---- conservation ------------------------------------------------------------------------
step "After all of that, the closed economy still balances" \
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
  echo "All journey checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
