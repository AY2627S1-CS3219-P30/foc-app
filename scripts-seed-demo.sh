#!/usr/bin/env bash
# AI Assistance Disclosure:
# Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-03 to 2026-11-05
# Scope: Bug fixes (#285, #169), including "keep production out of a from-source shell, and prove
#   the cookie is Secure".
# Author review: Jonus Ho and Anselm Long validated the behaviour and the implementation, checked
#   for fatal errors, and confirmed it does not conflict with the architecture before committing.

# Isolated, named D4 personas and errands. Never modifies the developer's default project.
# Usage: [FOC_IMAGE_TAG=rc1-d4] ./scripts-seed-demo.sh --fresh | --up | --check | --stop
#
# It builds this checkout, unless FOC_IMAGE_TAG names a release: then it runs that release's images
# as CI published them (#169), from a checkout of the same tag. A stack stays on them without the
# tag being named again, --fresh included, so a recovery cannot swap them for a build. With
# FOC_IMAGE_TAG= (empty), --fresh or --up goes back to building.
set -euo pipefail
cd "$(dirname "$0")"
action="${1:---up}"
[[ $# -le 1 && "$action" =~ ^--(fresh|up|check|stop)$ ]] || { echo 'Usage: ./scripts-seed-demo.sh [--fresh|--up|--check|--stop]' >&2; exit 2; }
base="${D4_PORT_BASE:-14000}"
[[ "$base" =~ ^[0-9]+$ ]] || { echo 'D4_PORT_BASE must be 1024..65525.' >&2; exit 2; }
base=$((10#$base))
[[ "$base" -ge 1024 && "$base" -le 65525 ]] || { echo 'D4_PORT_BASE must be 1024..65525.' >&2; exit 2; }
[[ -z "${FOC_IMAGE_TAG:-}" || "${FOC_IMAGE_TAG:-}" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || { echo 'Invalid FOC_IMAGE_TAG.' >&2; exit 2; }
./scripts-init-env.sh
. ./scripts-env.sh
umask 077
export COMPOSE_PROJECT_NAME=foc-d4-demo
# Dedicated ports let the ordinary foc stack remain running. Override D4_PORT_BASE for another set.
export WEB_APP_PORT="$base" USER_SERVICE_PORT="$((base+1))" SUPPLIER_SERVICE_PORT="$((base+2))"
export ORDER_SERVICE_PORT="$((base+3))" CREDIT_SERVICE_PORT="$((base+4))" GRAFANA_PORT="$((base+5))"
export POSTGRES_PORT="$((base+6))" RABBITMQ_PORT="$((base+7))" RABBITMQ_MANAGEMENT_PORT="$((base+8))" PROMETHEUS_PORT="$((base+9))"
export MAILPIT_PORT="$((base+10))" CHAT_SERVICE_PORT="$((base+11))"
export CORS_ORIGINS="http://localhost:$WEB_APP_PORT"
# A disposable fixture, not a deployment: scripts-seed-demo.py refuses to seed anything else.
export NODE_ENV=development
domain=$(python3 -c 'import os; print(os.environ["ALLOWED_EMAIL_DOMAINS"].split(",")[0].strip().lower())')
export ADMIN_SEED_EMAILS="d4.admin.a@$domain,d4.admin.b@$domain"
state_dir=.demo-state/foc-d4-demo
mkdir -p "$state_dir"
chmod 700 .demo-state "$state_dir"
recorded=''
if [[ -f "$state_dir/ports.sh" ]]; then
  recorded=$(unset FOC_IMAGE_TAG; . "$state_dir/ports.sh"; printf '%s' "${FOC_IMAGE_TAG:-}")
fi
case "$action" in
  --fresh | --up) export FOC_IMAGE_TAG="${FOC_IMAGE_TAG-$recorded}" ;;
  *) export FOC_IMAGE_TAG="$recorded" ;; # These start nothing, so they describe the stack as it is.
esac
export COMPOSE_FILE=compose.yaml
build_flag=--build
if [[ -n "$FOC_IMAGE_TAG" ]]; then
  export COMPOSE_FILE=compose.yaml:compose.images.yaml
  build_flag=--no-build
  # First, so a tag it cannot pull changes nothing: not the demo's data, nor the record below. Only
  # what is missing: a release's images never change, and a recovery may have no network.
  if [[ "$action" == --up || "$action" == --fresh ]]; then
    docker compose pull --policy missing user-service supplier-service order-service credit-service chat-service web-app
  fi
fi
# Reusable shell context contains only project/port settings, never a password or token.
python3 - "$state_dir/ports.sh" <<'PY'
import os,shlex,sys
keys=['COMPOSE_PROJECT_NAME','COMPOSE_FILE','FOC_IMAGE_TAG','WEB_APP_PORT','USER_SERVICE_PORT','SUPPLIER_SERVICE_PORT',
      'ORDER_SERVICE_PORT','CREDIT_SERVICE_PORT','GRAFANA_PORT','POSTGRES_PORT','RABBITMQ_PORT',
      'RABBITMQ_MANAGEMENT_PORT','PROMETHEUS_PORT','MAILPIT_PORT','CHAT_SERVICE_PORT','CORS_ORIGINS','NODE_ENV','ADMIN_SEED_EMAILS']
with open(sys.argv[1],'w') as f:
    for key in keys: f.write(f'export {key}={shlex.quote(os.environ[key])}\n')
PY
if [[ "$action" == --stop ]]; then docker compose stop; exit; fi
if [[ "$action" == --fresh ]]; then docker compose down -v; fi
if [[ "$action" == --up || "$action" == --fresh ]]; then docker compose up -d "$build_flag" --wait; fi
bound=$(docker compose port edge 8080)
[[ "$bound" == "0.0.0.0:$WEB_APP_PORT" || "$bound" == "127.0.0.1:$WEB_APP_PORT" ]] || {
  echo 'The demo project is absent or uses different ports. Use its original D4_PORT_BASE and --up.' >&2; exit 1;
}
echo "Demo images: ${FOC_IMAGE_TAG:-built from this checkout}"
export D4_EDGE_URL="http://localhost:$WEB_APP_PORT"
mode="$action"
[[ "$mode" == --fresh ]] && mode=--up
python3 scripts-seed-demo.py "$mode"
