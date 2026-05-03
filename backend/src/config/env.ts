export type AuthMode = 'real' | 'bypass'

export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly port: number
  readonly authMode: AuthMode
  /** Defined when authMode === 'real'; undefined in bypass. */
  readonly cognitoUserPoolId?: string
  readonly cognitoAppClientId?: string
  readonly cognitoIssuerUrl?: string
  readonly cognitoHostedUiDomain?: string
  readonly frontendBaseUrl: string
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

// Closes an open-redirect-via-misconfig surface: the frontend base URL is
// used to construct OAuth redirect targets and post-auth landing URLs, so a
// permissive value (or an attacker-controlled override) would let a misrouted
// redirect carry tokens off-origin. Allowlist by host, forbid path/query/hash
// components so a typo can't accidentally pin redirects to a sub-route.
function validateFrontendBaseUrl(raw: string | undefined, nodeEnv: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('FRONTEND_BASE_URL is required')
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`FRONTEND_BASE_URL is not a valid URL: ${raw}`)
  }

  const prodHosts = new Set(['mythrun.com', 'staging.mythrun.com'])
  const devHosts = new Set(['localhost', '127.0.0.1'])

  const allowedHosts =
    nodeEnv === 'development' || nodeEnv === 'test'
      ? new Set([...prodHosts, ...devHosts])
      : prodHosts

  if (!allowedHosts.has(url.hostname)) {
    throw new Error(
      `frontendBaseUrl host '${url.hostname}' is not in the allowlist for NODE_ENV=${String(nodeEnv)}`,
    )
  }

  if (url.pathname !== '/') {
    throw new Error(`frontendBaseUrl pathname must be '/', got '${url.pathname}'`)
  }

  if (url.search !== '') {
    throw new Error('frontendBaseUrl must not contain a query string')
  }

  if (url.hash !== '') {
    throw new Error('frontendBaseUrl must not contain a hash fragment')
  }

  return url.origin
}

function loadAuthConfig(): Pick<
  Env,
  'authMode' | 'cognitoUserPoolId' | 'cognitoAppClientId' | 'cognitoIssuerUrl' | 'cognitoHostedUiDomain'
> {
  const authModeRaw = process.env.AUTH_MODE
  if (authModeRaw !== 'real' && authModeRaw !== 'bypass') {
    throw new Error(
      `AUTH_MODE must be exactly 'real' or 'bypass' (got ${JSON.stringify(authModeRaw)})`,
    )
  }
  const authMode: AuthMode = authModeRaw

  // Cross-check 1: bypass requires non-production NODE_ENV.
  const nodeEnvRaw = process.env.NODE_ENV
  if (authMode === 'bypass' && nodeEnvRaw !== 'development' && nodeEnvRaw !== 'test') {
    throw new Error(
      `loadEnv: AUTH_MODE=bypass requires NODE_ENV in {'development','test'}, got NODE_ENV=${JSON.stringify(nodeEnvRaw)}`,
    )
  }

  // Cross-check 2: real + production requires the boot gate on.
  if (authMode === 'real' && nodeEnvRaw === 'production' && process.env.BOOT_GATE_ENABLED !== '1') {
    throw new Error(
      'loadEnv: AUTH_MODE=real with NODE_ENV=production requires BOOT_GATE_ENABLED=1',
    )
  }

  if (authMode === 'real') {
    const userPoolId = process.env.COGNITO_USER_POOL_ID
    const appClientId = process.env.COGNITO_APP_CLIENT_ID
    const issuerUrl = process.env.COGNITO_ISSUER_URL
    const hostedUiDomain = process.env.COGNITO_HOSTED_UI_DOMAIN
    if (!userPoolId || !appClientId || !issuerUrl || !hostedUiDomain) {
      throw new Error(
        'AUTH_MODE=real requires all of COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID, COGNITO_ISSUER_URL, COGNITO_HOSTED_UI_DOMAIN',
      )
    }
    return {
      authMode,
      cognitoUserPoolId: userPoolId,
      cognitoAppClientId: appClientId,
      cognitoIssuerUrl: issuerUrl,
      cognitoHostedUiDomain: hostedUiDomain,
    }
  }

  // bypass mode — omit Cognito fields so they remain `undefined` on Env
  // without violating exactOptionalPropertyTypes (which forbids assigning
  // `undefined` to a `?: string` property explicitly).
  return { authMode }
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
  // Validate auth config before frontendBaseUrl so AUTH_MODE/NODE_ENV
  // mismatches (which gate the entire boot) trip first — frontendBaseUrl
  // errors are downstream of a valid auth posture.
  const authConfig = loadAuthConfig()
  const frontendBaseUrl = validateFrontendBaseUrl(
    process.env.FRONTEND_BASE_URL,
    process.env.NODE_ENV,
  )
  return Object.freeze({
    databaseUrl: buildDatabaseUrl(),
    redisRealtimeUrl: buildRedisUrl('realtime'),
    redisBatchUrl: buildRedisUrl('batch'),
    port,
    ...authConfig,
    frontendBaseUrl,
  })
}
