#!/bin/sh
set -eu

: "${NOVABOOKS_APP_PASSWORD:?NOVABOOKS_APP_PASSWORD must be set}"

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$NOVABOOKS_APP_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE novabooks LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'app_password'
) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO novabooks', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO novabooks;
SQL
