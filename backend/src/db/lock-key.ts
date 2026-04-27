/**
 * Stable bigint passed to pg_advisory_lock.
 *
 * DO NOT REGENERATE THIS VALUE. It was computed once via:
 *
 *   SELECT hashtextextended('mythrun_migrate', 0);
 *
 * against PostgreSQL 16. Re-deriving against a different PG version
 * (or different seed) produces a different bigint, causing a runner
 * built from new code to use a different lock from a runner built
 * from old code — defeating the concurrency guard during a rolling
 * deploy.
 *
 * If a second app ever shares this RDS, prefix with a stack-id
 * high-32-bits and re-pin (and document the migration path).
 */
export const LOCK_KEY = -4399791952761660515n
