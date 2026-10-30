#!/bin/sh
# Entrypoint of the rabbitmq container (PLT-06): one broker account per service.
#
# Every service used to share one login, so anything holding it could publish
# any event: `user.activated` to mint credits, or `order.completion-requested`
# to move them. Now each service signs in as itself, and the broker refuses what
# is not its own:
#
#   - it may declare, write to and read only the shared exchanges and the queues
#     and exchanges under its own prefix (foc.<name>. and foc.<name>-service.);
#   - on foc.events it may publish only routing keys that start with its own
#     name (the Supplier and Chat Services, which publish nothing, none at all);
#   - on foc.events.dlx it may dead-letter only under its own queue names;
#   - it has no permission on the default exchange, which reaches every queue by
#     name. Retries and redrives go through foc.<name>-service.requeue instead.
#
# These rules stop a service publishing another's event directly. They do not stop
# it routing one in through an exchange of its own bound into foc.events: RabbitMQ
# checks routing keys only on the exchange a client publishes to. What closes that
# is the account itself: the broker stamps every message with the login that
# published it (`user-id`), and a consumer sets aside a message whose sender is
# not the producer it names (platform/src/events/sender.ts).
#
# The operator's account (RABBITMQ_OPERATOR_*) is the only administrator: the
# management UI, and the smoke and demo scripts. `guest` is removed.
#
# Passwords come from the container's environment, which Compose fills from the
# git-ignored `.env`. This runs at every start, so a password changed in `.env`
# takes effect on the next `docker compose up`. (They are passed to rabbitmqctl
# as arguments: in this image it does not return when given one on standard
# input. They are visible, for the moment each command runs, only inside this
# container, which already holds them in its environment.)
#
# The accounts are made in the background once the node is up, and the server
# itself is exec'd so it is PID 1 and receives the stop signal. The health check
# waits for the marker below, so no service connects before its account exists.
set -eu

: "${RABBITMQ_OPERATOR_USER:?}" "${RABBITMQ_OPERATOR_PASSWORD:?}"
: "${USER_BROKER_PASSWORD:?}" "${SUPPLIER_BROKER_PASSWORD:?}"
: "${ORDER_BROKER_PASSWORD:?}" "${CREDIT_BROKER_PASSWORD:?}" "${CHAT_BROKER_PASSWORD:?}"

READY=/tmp/foc-broker-accounts-ready
rm -f "$READY"

# Creates the user, or gives an existing one the password in the environment.
ensure_user() { # name password
  if rabbitmqctl -q list_users | cut -f1 | grep -qx "$1"; then
    rabbitmqctl -q change_password "$1" "$2"
  else
    rabbitmqctl -q add_user "$1" "$2"
  fi
}

account() { # user password prefix publishes
  user=$1
  prefix=$3
  ensure_user "$user" "$2"
  rabbitmqctl -q set_user_tags "$user"
  own="foc\\.${prefix}(-service)?\\..*"
  resources="^(foc\\.events(\\.dlx)?|${own})\$"
  rabbitmqctl -q set_permissions -p / "$user" "$resources" "$resources" "$resources"
  rabbitmqctl -q set_topic_permissions -p / "$user" foc.events "$4" '.*'
  rabbitmqctl -q set_topic_permissions -p / "$user" foc.events.dlx "^foc\\.${prefix}(-service)?\\." '.*'
}

provision() {
  until rabbitmq-diagnostics -q check_running >/dev/null 2>&1; do sleep 1; done

  ensure_user "$RABBITMQ_OPERATOR_USER" "$RABBITMQ_OPERATOR_PASSWORD"
  # `impersonator`: may publish under another account's user-id. The failure demo injects
  # events on a service's behalf this way; no service account has the tag.
  rabbitmqctl -q set_user_tags "$RABBITMQ_OPERATOR_USER" administrator impersonator
  rabbitmqctl -q set_permissions -p / "$RABBITMQ_OPERATOR_USER" '.*' '.*' '.*'
  if [ "$RABBITMQ_OPERATOR_USER" != guest ]; then
    rabbitmqctl -q delete_user guest >/dev/null 2>&1 || true
  fi

  # A topic permission can be set only on an exchange that exists, so the two shared exchanges
  # are declared here first, exactly as every service declares them (durable, topic).
  cat >/tmp/foc-exchanges.json <<'JSON'
{"exchanges": [
  {"name": "foc.events", "vhost": "/", "type": "topic", "durable": true, "auto_delete": false, "internal": false, "arguments": {}},
  {"name": "foc.events.dlx", "vhost": "/", "type": "topic", "durable": true, "auto_delete": false, "internal": false, "arguments": {}}
]}
JSON
  rabbitmqctl -q import_definitions /tmp/foc-exchanges.json

  account user-service "$USER_BROKER_PASSWORD" user '^user\.'
  account supplier-service "$SUPPLIER_BROKER_PASSWORD" supplier '^$'
  account order-service "$ORDER_BROKER_PASSWORD" order '^order\.'
  account credit-service "$CREDIT_BROKER_PASSWORD" credit '^credit\.'
  account chat-service "$CHAT_BROKER_PASSWORD" chat '^$'
}

# In the background, and not as part of a `||` list: there `set -e` would be
# ignored and a failed step would be followed by the next one.
(
  trap '[ -f "$READY" ] || echo "foc: creating the broker accounts FAILED; the health check will not pass" >&2' EXIT
  provision
  touch "$READY"
  echo "foc: broker accounts are ready"
) &

exec docker-entrypoint.sh rabbitmq-server
