#!/bin/sh
set -eu
# Quoted psql variables preserve credentials without printing them.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --set=main_user="$MAIN_DB_USER" --set=main_password="$MAIN_DB_PASSWORD" --set=main_db="$MAIN_DB_NAME" \
  --set=inventory_user="$INVENTORY_DB_USER" --set=inventory_password="$INVENTORY_DB_PASSWORD" --set=inventory_db="$INVENTORY_DB_NAME" <<'SQL'
CREATE ROLE :"main_user" LOGIN PASSWORD :'main_password';
CREATE DATABASE :"main_db" OWNER :"main_user";
REVOKE ALL ON DATABASE :"main_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"main_db" TO :"main_user";
CREATE ROLE :"inventory_user" LOGIN PASSWORD :'inventory_password';
CREATE DATABASE :"inventory_db" OWNER :"inventory_user";
REVOKE ALL ON DATABASE :"inventory_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"inventory_db" TO :"inventory_user";
SQL
