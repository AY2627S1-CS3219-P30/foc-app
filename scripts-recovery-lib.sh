#!/usr/bin/env bash
# Shared by the backup and restore entry points. Sourced after scripts-env.sh.

RECOVERY_APPS=(edge web-app user-service supplier-service order-service credit-service)

recovery_error() { echo "Recovery failed: $*" >&2; return 1; }

# Check both normal/retry/DLQ broker queues and durable unpublished outboxes. Published rows may
# already have been pruned, so outbox replay alone is not a substitute for this quiet boundary.
recovery_drained() {
  local queues pending db
  queues=$(docker compose exec -T rabbitmq rabbitmqctl -q list_queues name messages --formatter=json) || return 1
  if ! python3 -c 'import json,sys; q=json.load(sys.stdin); sys.exit(0 if all(x["messages"] == 0 for x in q) else 1)' <<<"$queues"; then
    return 1
  fi
  # Supplier publishes no events and has no outbox table.
  for db in foc_user foc_order foc_credit; do
    pending=$(docker compose exec -T postgres psql -XqAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$db" \
      -c 'SELECT count(*) FROM outbox_events WHERE published_at IS NULL') || return 1
    [[ "$pending" == 0 ]] || return 1
  done
}

recovery_broker_empty() {
  local queues
  queues=$(docker compose exec -T rabbitmq rabbitmqctl -q list_queues name messages --formatter=json) || return 1
  python3 -c 'import json,sys; sys.exit(0 if all(x["messages"] == 0 for x in json.load(sys.stdin)) else 1)' <<<"$queues"
}

recovery_apps_stopped() {
  local running
  running=$(docker compose ps --status running --services) || return 1
  if printf '%s\n' "$running" | grep -qE '^(edge|web-app|(user|supplier|order|credit)-service(-migrate)?)$'; then
    recovery_error 'Application or migration containers are running; stop them before restoring.'
    return 1
  fi
}
