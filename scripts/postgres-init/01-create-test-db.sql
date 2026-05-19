-- scripts/postgres-init/01-create-test-db.sql
--
-- Runs once on first Postgres volume init (via the
-- /docker-entrypoint-initdb.d mount in docker-compose.yml). Creates the
-- test database alongside the default dev database (POSTGRES_DB=mythrun_dev).
--
-- On a fresh `docker compose down -v && docker compose up`, this ensures
-- both databases exist with the right owner. Subsequent migrations are
-- run via `pnpm db:migrate` (dev) and `pnpm db:migrate:test` (test).
--
-- myth-oehx.

CREATE DATABASE mythrun_test OWNER mythrun;
