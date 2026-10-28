#!/usr/bin/env bash
# Destructive only to the dedicated foc-e2e-release test project, never foc or foc-d4-demo.
set -euo pipefail
cd "$(dirname "$0")"
action="${1:---twice}"
[[ $# -le 1 && "$action" =~ ^--(once|twice|stop)$ ]] || { echo 'Usage: ./scripts-e2e-release.sh [--once|--twice|--stop]' >&2; exit 2; }
base="${E2E_PORT_BASE:-14500}"
[[ "$base" =~ ^[0-9]+$ ]] || { echo 'E2E_PORT_BASE must be 1024..65526.' >&2; exit 2; }
base=$((10#$base))
[[ "$base" -ge 1024 && "$base" -le 65526 ]] || { echo 'E2E_PORT_BASE must be 1024..65526.' >&2; exit 2; }
if [[ "$action" != --stop ]]; then command -v bun >/dev/null || { echo 'Install Bun 1.4.2, or run with npm exec --package=bun@1.4.2 -- ./scripts-e2e-release.sh.' >&2; exit 2; }; fi
./scripts-init-env.sh
. ./scripts-env.sh
export COMPOSE_PROJECT_NAME=foc-e2e-release COMPOSE_FILE=compose.yaml
export WEB_APP_PORT="$base" USER_SERVICE_PORT="$((base+1))" SUPPLIER_SERVICE_PORT="$((base+2))"
export ORDER_SERVICE_PORT="$((base+3))" CREDIT_SERVICE_PORT="$((base+4))" GRAFANA_PORT="$((base+5))"
export POSTGRES_PORT="$((base+6))" RABBITMQ_PORT="$((base+7))" RABBITMQ_MANAGEMENT_PORT="$((base+8))" PROMETHEUS_PORT="$((base+9))"
export CORS_ORIGINS="http://localhost:$WEB_APP_PORT" NODE_ENV=development
export E2E_BASE_URL="$CORS_ORIGINS" E2E_RELEASE=1
export PLAYWRIGHT_HTML_OPEN=never
if [[ "$action" == --stop ]]; then docker compose stop; exit; fi
mkdir -p .release-results
runs=2
[[ "$action" == --once ]] && runs=1
for ((run=1; run<=runs; run++)); do
  echo "Release journey run $run/$runs: clean dedicated container stack"
  docker compose down -v
  docker compose up -d --build --wait
  ./scripts-smoke.sh
  (
    cd web-app
    PLAYWRIGHT_HTML_OUTPUT_DIR="../.release-results/html-$run" \
      PLAYWRIGHT_JSON_OUTPUT_NAME="../.release-results/run-$run.json" \
      bun run e2e --reporter=list,json,html
  )
done
