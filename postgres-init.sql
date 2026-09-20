-- One PostgreSQL server, one database and one role per service.
--
-- Each service can reach only its own database: no cross-service SQL, no shared
-- schema. A single server rather than four keeps a laptop usable during the
-- demo (execution plan §3.1); production can split the instances without any
-- application change, because each service already connects with its own
-- credentials to its own database.
--
-- Runs once, on first boot, when the data volume is empty. Change it and you
-- must `docker compose down -v` for it to run again.

\set ON_ERROR_STOP on

CREATE ROLE user_service      WITH LOGIN PASSWORD 'user_service_dev';
CREATE ROLE supplier_service  WITH LOGIN PASSWORD 'supplier_service_dev';
CREATE ROLE order_service     WITH LOGIN PASSWORD 'order_service_dev';
CREATE ROLE credit_service    WITH LOGIN PASSWORD 'credit_service_dev';

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
