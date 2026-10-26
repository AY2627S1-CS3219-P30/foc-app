#!/usr/bin/env bash
# Sourced by the scripts that drive a running stack as a user would (the failure
# demo and the restart check): where the services are, and the few things both
# do — sign a student up, read an errand or a wallet, wait for something.
#
# Source scripts-env.sh first: the ports and logins below come from `.env`.

WEB_PORT="${WEB_APP_PORT:-3000}"
USER_PORT="${USER_SERVICE_PORT:-3001}"
SUPPLIER_PORT="${SUPPLIER_SERVICE_PORT:-3002}"
ORDER_PORT="${ORDER_SERVICE_PORT:-3003}"
CREDIT_PORT="${CREDIT_SERVICE_PORT:-3004}"
RABBIT_API="http://localhost:${RABBITMQ_MANAGEMENT_PORT:-15672}/api"
RABBIT_AUTH="${RABBITMQ_USER:-foc}:${RABBITMQ_PASSWORD:?}"
METRICS_AUTH="Authorization: Bearer ${METRICS_TOKEN:?}"
EMAIL_DOMAIN="${ALLOWED_EMAIL_DOMAINS:-u.nus.edu}"
EMAIL_DOMAIN="${EMAIL_DOMAIN%%,*}"
RUN="$(date +%s)-$RANDOM"

# No request may hang the run: a port that never answers is a failure, not a wait.
curl() { command curl --max-time 20 "$@"; }

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
step() { printf '\n\033[1m%s\033[0m\n  %s\n' "$1" "$2"; }
FAILURES=0

# Every probe ends in `|| true`: under `set -e` and `pipefail` a failed command
# substitution would end the run silently instead of recording a FAIL.
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null || true; }
sql() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "$1" -tAX -c "$2" 2>/dev/null || true; }

# Polls a command until it prints the wanted value.
wait_for() { # seconds wanted command...
  local seconds=$1 wanted=$2 got=""
  shift 2
  for _ in $(seq 1 "$((seconds * 2))"); do
    got=$("$@") || true
    [[ "$got" == "$wanted" ]] && return 0
    sleep 0.5
  done
  LAST="$got"
  return 1
}

# What a new wallet is issued: INITIAL_CREDIT_ALLOCATION from .env, else the service's default.
INITIAL_CREDITS="${INITIAL_CREDIT_ALLOCATION:-10}"

# Signs up and activates a student through the dev mailbox, logs them in, and
# waits for their initial wallet. Sets STUDENT_ID and STUDENT_TOKEN.
signup() { # label [no-wallet]
  local email="demo-$1-$RUN@$EMAIL_DOMAIN" password token
  password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
  local registered
  registered=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${USER_PORT}/auth/register" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\",\"displayName\":\"Demo $1\"}" 2>/dev/null) || true
  if [[ "$registered" == "429" ]]; then
    # The User Service allows 20 registrations an hour from one address, and every script on
    # this machine is one address. The count is in memory, so a restart clears it.
    echo "Registration is rate-limited (20 an hour from one address). Clear it with:" >&2
    echo "  docker compose restart user-service" >&2
    exit 1
  fi
  token=$(curl -fsS -G "http://localhost:${USER_PORT}/dev/mailbox" --data-urlencode "to=$email" 2>/dev/null | json 'd.get("token", "")') || true
  if [[ -z "$token" ]]; then
    echo "No activation token for $email: the dev mailbox exists only outside production." >&2
    exit 1
  fi
  curl -fsS -X POST "http://localhost:${USER_PORT}/auth/activate" -H 'content-type: application/json' \
    -H "x-correlation-id: demo-$1-$RUN" -d "{\"token\":\"$token\"}" -o /dev/null 2>/dev/null || true
  local login
  login=$(curl -fsS -X POST "http://localhost:${USER_PORT}/auth/login" -H 'content-type: application/json' \
    -H "Origin: http://localhost:${WEB_PORT}" -d "{\"email\":\"$email\",\"password\":\"$password\"}" 2>/dev/null) || true
  STUDENT_TOKEN=$(json 'd["accessToken"]' <<<"$login")
  STUDENT_ID=$(json 'd["user"]["id"]' <<<"$login")
  if [[ -z "$STUDENT_TOKEN" || -z "$STUDENT_ID" ]]; then
    echo "Could not sign in as $email." >&2
    exit 1
  fi
  # `signup label no-wallet` returns as soon as the student is signed in, for a caller that
  # wants to show the wallet arriving, or that has cut the Credit Service off on purpose.
  [[ "${2:-}" == "no-wallet" ]] && return 0
  wait_for 30 "$INITIAL_CREDITS" wallet_available "$STUDENT_ID" || {
    echo "No ${INITIAL_CREDITS}-credit wallet for $email after 30 s (got '${LAST:-nothing}')." >&2
    exit 1
  }
}

wallet_available() { sql foc_credit "SELECT available FROM wallets WHERE user_id = '$1'"; }
wallet() { sql foc_credit "SELECT available || '/' || reserved FROM wallets WHERE user_id = '$1'"; }
errand() { # token order-id  → "STATUS version"
  curl -fsS "http://localhost:${ORDER_PORT}/orders/$2?view=private" -H "Authorization: Bearer $1" 2>/dev/null |
    json '"{} {}".format(d["status"], d["version"])' || true
}
