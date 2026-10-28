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
image_tag="${E2E_IMAGE_TAG:-}"
[[ -z "$image_tag" || "$image_tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || { echo 'Invalid E2E_IMAGE_TAG.' >&2; exit 2; }
./scripts-init-env.sh
. ./scripts-env.sh
export COMPOSE_PROJECT_NAME=foc-e2e-release COMPOSE_FILE=compose.yaml:compose.e2e.yaml
build_flag=--build
if [[ -n "$image_tag" ]]; then
  export COMPOSE_FILE=compose.yaml:compose.images.yaml:compose.e2e.yaml FOC_IMAGE_TAG="$image_tag"
  build_flag=--no-build
fi
export WEB_APP_PORT="$base" USER_SERVICE_PORT="$((base+1))" SUPPLIER_SERVICE_PORT="$((base+2))"
export ORDER_SERVICE_PORT="$((base+3))" CREDIT_SERVICE_PORT="$((base+4))" GRAFANA_PORT="$((base+5))"
export POSTGRES_PORT="$((base+6))" RABBITMQ_PORT="$((base+7))" RABBITMQ_MANAGEMENT_PORT="$((base+8))" PROMETHEUS_PORT="$((base+9))"
export CORS_ORIGINS="http://localhost:$WEB_APP_PORT" NODE_ENV=development
export E2E_BASE_URL="$CORS_ORIGINS" E2E_RELEASE=1
export PLAYWRIGHT_HTML_OPEN=never
export ORDER_LIFECYCLE_SWEEP_INTERVAL_MS=100
export E2E_CLOCK_HOST_FILE="$PWD/.release-results/clock/offset-ms"
if [[ "$action" == --stop ]]; then docker compose stop; exit; fi
mkdir -p .release-results
chmod 700 .release-results
mkdir -p .release-results/clock
chmod 755 .release-results/clock
capture_failure() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    docker compose logs --no-color --tail=200 > ".release-results/run-${run:-setup}-containers.log" 2>&1 || true
    echo "Release run failed; evidence is in .release-results and web-app/test-results." >&2
  fi
  exit "$status"
}
trap capture_failure EXIT
# Do not let an earlier successful second run masquerade as evidence for a failed new invocation.
rm -f -- .release-results/run-1.json .release-results/run-2.json .release-results/run-1-containers.log .release-results/run-2-containers.log
rm -rf -- .release-results/html-1 .release-results/html-2
runs=2
[[ "$action" == --once ]] && runs=1
for ((run=1; run<=runs; run++)); do
  echo "Release journey run $run/$runs: clean dedicated container stack"
  docker compose down -v
  printf '0\n' > "$E2E_CLOCK_HOST_FILE"
  chmod 644 "$E2E_CLOCK_HOST_FILE"
  docker compose up -d "$build_flag" --wait
  ./scripts-smoke.sh
  (
    cd web-app
    PLAYWRIGHT_HTML_OUTPUT_DIR="../.release-results/html-$run" \
      PLAYWRIGHT_JSON_OUTPUT_NAME="../.release-results/run-$run.json" \
      bun run e2e --reporter=list,json,html
  )
  node --input-type=module - "$run" <<'JS'
import { readFileSync } from 'node:fs';
const run = process.argv[2];
const { stats, errors = [] } = JSON.parse(readFileSync(`.release-results/run-${run}.json`, 'utf8'));
if (!stats || !stats.expected || stats.unexpected || stats.flaky || stats.skipped || errors.length) {
  throw new Error(`Release run ${run} is incomplete or failed: ${JSON.stringify({ stats, errors })}`);
}
console.log(`Release run ${run}: ${stats.expected} passed; zero failures, flakes, skips or runner errors.`);
JS
done
