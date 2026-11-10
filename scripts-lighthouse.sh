#!/usr/bin/env bash
# AI Assistance Disclosure:
# Tool: Claude Code (Claude Opus 5.5), date: 2026-11-03
# Scope: Generated the first version of this script for "axe on every core screen, keyboard-only
#   errand journey, Lighthouse" (#166).
# Author review: Anselm Long verified correctness, tested the change, and checked for fatal errors
#   and conflicts with our architecture before committing.

# Lighthouse, mobile, three runs per core screen (UI-NFR3.1.1, TST-03 #166), on a Compose project
# of its own ('foc-lighthouse', ports from LIGHTHOUSE_PORT_BASE, default 14600), so it starts beside
# the demo and release stacks. Destructive only to that project: each run starts it from empty
# volumes. The web app is compose.yaml's image, a production build (`next build`, NODE_ENV=production);
# the services run as development so that mail lands in Mailpit, and compose.load.yaml raises the
# User Service's sign-in limits, since every run signs in again from this one machine.
#
#   ./scripts-lighthouse.sh          build, start clean, seed, measure; results in .lighthouse-results/
#   ./scripts-lighthouse.sh --stop   stop the stack
#
# Needs Node 24 and the web app's dependencies (`cd web-app && bun install`). Chromium is Playwright's
# (`cd web-app && bunx playwright install chromium`) unless CHROME_PATH names another.
set -euo pipefail
cd "$(dirname "$0")"
action="${1:---run}"
[[ $# -le 1 && "$action" =~ ^--(run|stop)$ ]] || { echo 'Usage: ./scripts-lighthouse.sh [--stop]' >&2; exit 2; }
base="${LIGHTHOUSE_PORT_BASE:-14600}"
[[ "$base" =~ ^[0-9]+$ ]] || { echo 'LIGHTHOUSE_PORT_BASE must be 1024..65525.' >&2; exit 2; }
base=$((10#$base))
[[ "$base" -ge 1024 && "$base" -le 65525 ]] || { echo 'LIGHTHOUSE_PORT_BASE must be 1024..65525.' >&2; exit 2; }
./scripts-init-env.sh
. ./scripts-env.sh
export COMPOSE_PROJECT_NAME=foc-lighthouse COMPOSE_FILE=compose.yaml:compose.load.yaml
export WEB_APP_PORT="$base" USER_SERVICE_PORT="$((base+1))" SUPPLIER_SERVICE_PORT="$((base+2))"
export ORDER_SERVICE_PORT="$((base+3))" CREDIT_SERVICE_PORT="$((base+4))" GRAFANA_PORT="$((base+5))"
export POSTGRES_PORT="$((base+6))" RABBITMQ_PORT="$((base+7))" RABBITMQ_MANAGEMENT_PORT="$((base+8))" PROMETHEUS_PORT="$((base+9))"
export MAILPIT_PORT="$((base+10))" CHAT_SERVICE_PORT="$((base+11))"
export CORS_ORIGINS="http://localhost:$WEB_APP_PORT" NODE_ENV=development
if [[ "$action" == --stop ]]; then docker compose stop; exit; fi
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || { echo 'Lighthouse needs Node 24.' >&2; exit 2; }
out=".lighthouse-results/$(date -u +%Y-%m-%dT%H%M%SZ)"
mkdir -p "$out"
docker compose down -v
docker compose up -d --build --wait
[[ "$(docker compose exec -T web-app printenv NODE_ENV)" == production ]] || { echo 'The web app is not a production build.' >&2; exit 1; }
(
  cd web-app
  LIGHTHOUSE_BASE_URL="$CORS_ORIGINS" LIGHTHOUSE_MAILPIT_URL="http://localhost:$MAILPIT_PORT" \
    LIGHTHOUSE_OUT="../$out" node scripts/lighthouse.mts
)
echo "Stop the stack with ./scripts-lighthouse.sh --stop"
