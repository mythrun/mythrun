export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly port: number
}

// Dev (.env.development) sets DATABASE_URL / REDIS_REALTIME_URL /
// REDIS_BATCH_URL directly. Prod ECS task definition (per
// infra/modules/serving/main.tf locals.common_env) sets the component
// form: DB_HOST/DB_PORT/DB_USER/DB_NAME/DB_PASSWORD and REDIS_HOST/
// REDIS_PORT/REDIS_AUTH_TOKEN. The loader accepts either shape and
// constructs URLs when only the component form is present.
//
// Prod currently has a single Redis cluster shared between realtime +
// batch (the two-cluster split is a future ticket). When only the
// component form is given, both REDIS_REALTIME_URL and REDIS_BATCH_URL
// point at the same constructed URL. Dev keeps two distinct URLs.
//
// Per-process invariant: either DATABASE_URL or MIGRATE_DATABASE_URL is
// set per process; never both. The API task uses DATABASE_URL only; the
// migrate task uses MIGRATE_DATABASE_URL only. Loaders that inherit both
// would silently expose the migration role's connection to the API.

function buildDatabaseUrl(): string {
  // Migrations may run as a different role than the API (rds_superuser
  // for CREATE EXTENSION). MIGRATE_DATABASE_URL takes precedence; fallback
  // to DATABASE_URL keeps local dev working out of the box.
  // Explicit length-after-trim check — Terraform `cond ? x : null` patterns
  // emit "" rather than null, and `??` only falls through on null/undefined.
  const migrateRaw = process.env.MIGRATE_DATABASE_URL?.trim()
  if (migrateRaw && migrateRaw.length > 0) return migrateRaw

  const explicit = process.env.DATABASE_URL
  if (explicit) return explicit
  const host = process.env.DB_HOST
  const port = process.env.DB_PORT
  const user = process.env.DB_USER
  const name = process.env.DB_NAME
  const password = process.env.DB_PASSWORD
  if (!host || !port || !user || !name || !password) {
    throw new Error(
      'Missing database config: provide DATABASE_URL (or MIGRATE_DATABASE_URL), or all of DB_HOST/DB_PORT/DB_USER/DB_NAME/DB_PASSWORD',
    )
  }
  // Prod (RDS) requires TLS; createPgPool parses ?sslmode and sets the
  // `ssl` option on the Pool config. Component-form path always sets
  // sslmode=require since RDS enforces it; dev should use the explicit
  // URL form (no sslmode) instead.
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=require`
}

function buildRedisUrl(role: 'realtime' | 'batch'): string {
  const envKey = role === 'realtime' ? 'REDIS_REALTIME_URL' : 'REDIS_BATCH_URL'
  const explicit = process.env[envKey]
  if (explicit) return explicit
  const host = process.env.REDIS_HOST
  const port = process.env.REDIS_PORT
  const authToken = process.env.REDIS_AUTH_TOKEN
  if (!host || !port) {
    throw new Error(
      `Missing redis config: provide ${envKey}, or REDIS_HOST + REDIS_PORT`,
    )
  }
  // Prod ElastiCache uses TLS (rediss://) with REDIS_AUTH_TOKEN; dev
  // uses plain redis:// without auth. Detect via auth-token presence.
  const scheme = authToken ? 'rediss' : 'redis'
  const authPart = authToken ? `:${encodeURIComponent(authToken)}@` : ''
  return `${scheme}://${authPart}${host}:${port}`
}

export function loadEnv(): Env {
  const portRaw = process.env.PORT
  if (!portRaw) {
    throw new Error('Missing required env var: PORT')
  }
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be numeric, got: ${portRaw}`)
  }
  return Object.freeze({
    databaseUrl: buildDatabaseUrl(),
    redisRealtimeUrl: buildRedisUrl('realtime'),
    redisBatchUrl: buildRedisUrl('batch'),
    port,
  })
}
