#!/bin/bash
# One PostgreSQL server, one database and one role per service.
#
# Each service can reach only its own database: no cross-service SQL, no shared
# schema. A single server rather than four keeps a laptop usable during the
# demo (execution plan §3.1); production can split the instances without any
# application change, because each service already connects with its own
# credentials to its own database.
#
# A script rather than a .sql file so that no role password is written in the
# repository (PL-NFR2.1.1): each comes from the container's environment, which
# Compose fills from the git-ignored `.env`. psql quotes them as literals
# (`:'name'`), so a password is never spliced into SQL as text.
#
# Runs once, on first boot, when the data volume is empty. Change a password in
# `.env` afterwards and the role keeps its old one: `docker compose down -v`
# for a fresh volume, or ALTER ROLE by hand.
set -euo pipefail

: "${USER_DB_PASSWORD:?}" "${SUPPLIER_DB_PASSWORD:?}" "${ORDER_DB_PASSWORD:?}" "${CREDIT_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v user_pw="$USER_DB_PASSWORD" \
  -v supplier_pw="$SUPPLIER_DB_PASSWORD" \
  -v order_pw="$ORDER_DB_PASSWORD" \
  -v credit_pw="$CREDIT_DB_PASSWORD" <<'SQL'
CREATE ROLE user_service      WITH LOGIN PASSWORD :'user_pw';
CREATE ROLE supplier_service  WITH LOGIN PASSWORD :'supplier_pw';
CREATE ROLE order_service     WITH LOGIN PASSWORD :'order_pw';
CREATE ROLE credit_service    WITH LOGIN PASSWORD :'credit_pw';

CREATE DATABASE foc_user     OWNER user_service;
CREATE DATABASE foc_supplier OWNER supplier_service;
CREATE DATABASE foc_order    OWNER order_service;
CREATE DATABASE foc_credit   OWNER credit_service;

-- Revoke the implicit CONNECT that PUBLIC gets on a new database, so one
-- service's credentials cannot open another's database.
REVOKE CONNECT ON DATABASE foc_user     FROM PUBLIC;
REVOKE CONNECT ON DATABASE foc_supplier FROM PUBLIC;
REVOKE CONNECT ON DATABASE foc_order    FROM PUBLIC;
REVOKE CONNECT ON DATABASE foc_credit   FROM PUBLIC;

GRANT CONNECT ON DATABASE foc_user     TO user_service;
GRANT CONNECT ON DATABASE foc_supplier TO supplier_service;
GRANT CONNECT ON DATABASE foc_order    TO order_service;
GRANT CONNECT ON DATABASE foc_credit   TO credit_service;
SQL
