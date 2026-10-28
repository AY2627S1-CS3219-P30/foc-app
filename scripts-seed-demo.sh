#!/usr/bin/env bash
# Isolated, named D4 personas and errands. Never modifies the developer's default project.
# Usage: ./scripts-seed-demo.sh --fresh | --up | --check | --stop
set -euo pipefail
cd "$(dirname "$0")"
action="${1:---up}"
[[ $# -le 1 && "$action" =~ ^--(fresh|up|check|stop)$ ]] || { echo 'Usage: ./scripts-seed-demo.sh [--fresh|--up|--check|--stop]' >&2; exit 2; }
base="${D4_PORT_BASE:-14000}"
[[ "$base" =~ ^[0-9]+$ ]] || { echo 'D4_PORT_BASE must be 1024..65526.' >&2; exit 2; }
base=$((10#$base))
[[ "$base" -ge 1024 && "$base" -le 65526 ]] || { echo 'D4_PORT_BASE must be 1024..65526.' >&2; exit 2; }
./scripts-init-env.sh
. ./scripts-env.sh
umask 077
export COMPOSE_PROJECT_NAME=foc-d4-demo
export COMPOSE_FILE=compose.yaml
# Dedicated ports let the ordinary foc stack remain running. Override D4_PORT_BASE for another set.
export WEB_APP_PORT="$base" USER_SERVICE_PORT="$((base+1))" SUPPLIER_SERVICE_PORT="$((base+2))"
export ORDER_SERVICE_PORT="$((base+3))" CREDIT_SERVICE_PORT="$((base+4))" GRAFANA_PORT="$((base+5))"
export POSTGRES_PORT="$((base+6))" RABBITMQ_PORT="$((base+7))" RABBITMQ_MANAGEMENT_PORT="$((base+8))" PROMETHEUS_PORT="$((base+9))"
export CORS_ORIGINS="http://localhost:$WEB_APP_PORT"
export NODE_ENV=development
domain="${ALLOWED_EMAIL_DOMAINS%%,*}"
export ADMIN_SEED_EMAILS="d4.admin.a@$domain,d4.admin.b@$domain"
state_dir=.demo-state/foc-d4-demo
mkdir -p "$state_dir"
chmod 700 .demo-state "$state_dir"
# Reusable shell context contains only project/port settings, never a password or token.
python3 - "$state_dir/ports.sh" <<'PY'
import os,shlex,sys
keys=['COMPOSE_PROJECT_NAME','COMPOSE_FILE','WEB_APP_PORT','USER_SERVICE_PORT','SUPPLIER_SERVICE_PORT',
      'ORDER_SERVICE_PORT','CREDIT_SERVICE_PORT','GRAFANA_PORT','POSTGRES_PORT','RABBITMQ_PORT',
      'RABBITMQ_MANAGEMENT_PORT','PROMETHEUS_PORT','CORS_ORIGINS','NODE_ENV','ADMIN_SEED_EMAILS']
with open(sys.argv[1],'w') as f:
    for key in keys: f.write(f'export {key}={shlex.quote(os.environ[key])}\n')
PY
if [[ "$action" == --stop ]]; then docker compose stop; exit; fi
if [[ "$action" == --fresh ]]; then docker compose down -v; fi
if [[ "$action" == --up || "$action" == --fresh ]]; then docker compose up -d --build --wait; fi
bound=$(docker compose port edge 8080)
[[ "$bound" == "0.0.0.0:$WEB_APP_PORT" || "$bound" == "127.0.0.1:$WEB_APP_PORT" ]] || {
  echo 'The demo project is absent or uses different ports. Use its original D4_PORT_BASE and --up.' >&2; exit 1;
}
export D4_EDGE_URL="http://localhost:$WEB_APP_PORT"
mode="$action"
[[ "$mode" == --fresh ]] && mode=--up
python3 scripts-seed-demo.py "$mode"
