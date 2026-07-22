type AuthMode = 'real' | 'bypass'

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
  readonly mythrunEnv: 'production' | 'staging' | 'development'
  /**
   * Namespace prefix for Redis keys, shape: `${MYTHRUN_ENV}:${REGION_PREFIX}:`
   * (e.g. `production:use1:`). Staging and prod share an ElastiCache cluster,
   * so per-env prefixing is mandatory to keep their keyspaces disjoint.
   * Per-feature suffixes (e.g. `ws:ticket:`) are appended by their callers.
   */
  readonly redisKeyPrefix: string
  readonly stripeSecretKey: string
  readonly stripeWebhookSecret: string
  readonly anthropicApiKey: string
  readonly voyageApiKey: string
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

// Exported because the migrate CLI (backend/src/db/migrate.ts) only needs
// the DB URL — running it through full loadEnv() would force it to satisfy
// API-side validators (PORT, REDIS_*, FRONTEND_BASE_URL, STRIPE_*, etc.)
// that the migrate task definition deliberately doesn't carry.
export function buildDatabaseUrl(): string {
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
    throw new Error(`Missing redis config: provide ${envKey}, or REDIS_HOST + REDIS_PORT`)
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

// Mythrun deploys with Stripe restricted keys (rk_*), never full-permission
// keys (sk_*). The restricted key is the actual price-mutation boundary
// per the MYT-41 §1 design decision; lookup-keys.ts and the ESLint rules
// are tripwires above it. Misrotation that puts a full-permission key here
// would silently degrade the defense — the boot probe (read-only) would
// still pass. Catching it at env-load is the cheapest enforcement.
function validateStripeSecretKey(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('STRIPE_SECRET_KEY is required')
  }
  if (!raw.startsWith('rk_')) {
    throw new Error(
      `STRIPE_SECRET_KEY must be a Stripe restricted key (rk_*); got prefix '${raw.slice(0, 3)}'. ` +
        `Full-permission keys (sk_*) are forbidden in deployed environments per the MYT-41 design.`,
    )
  }
  return raw
}

// All Anthropic API keys carry the sk-ant- prefix (test and live). Misconfiguring
// the env (pasting a Stripe key, a half-rotated value, or an empty string from
// a missing secret) would surface as a runtime 401 from the Anthropic SDK only
// once the first LLM call fires — long after boot. Catching prefix mismatch at
// env-load makes the failure mode loud, immediate, and obvious.
function validateAnthropicApiKey(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('ANTHROPIC_API_KEY is required')
  }
  if (!raw.startsWith('sk-ant-')) {
    throw new Error(
      `ANTHROPIC_API_KEY must have sk-ant- prefix; got prefix '${raw.slice(0, 7)}'. ` +
        `Pull a key from Anthropic Console (test keys are fine for non-prod).`,
    )
  }
  return raw
}

// Voyage API key powers the embeddings layer (semantic memory / retrieval).
// A missing or empty value would surface as a runtime 401 from the Voyage SDK
// only once the first embed call fires — long after boot. Catching it at
// env-load makes the failure mode loud and immediate. We assert non-empty
// only: the live Voyage key prefix could not be confirmed from the docs this
// session, and a wrong prefix-assert would reject a valid key (worse than no
// assert). Add a prefix check here once the format is confirmed.
function validateVoyageApiKey(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('VOYAGE_API_KEY is required')
  }
  return raw
}

// PLACEHOLDER literal is permitted in the MYT-41 → MYT-42 window. MYT-42's
// webhook handler verifies via stripe.webhooks.constructEvent unconditionally;
// any signature mismatch fails closed regardless of whether the secret is
// the literal 'PLACEHOLDER' or a real whsec_*. No bypass branch.
function validateStripeWebhookSecret(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET is required (use PLACEHOLDER until MYT-42 wires the handler)',
    )
  }
  return raw
}

function loadAuthConfig(): Pick<
  Env,
  | 'authMode'
  | 'cognitoUserPoolId'
  | 'cognitoAppClientId'
  | 'cognitoIssuerUrl'
  | 'cognitoHostedUiDomain'
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
    throw new Error('loadEnv: AUTH_MODE=real with NODE_ENV=production requires BOOT_GATE_ENABLED=1')
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
  const stripeSecretKey = validateStripeSecretKey(process.env.STRIPE_SECRET_KEY)
  const stripeWebhookSecret = validateStripeWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET)
  const anthropicApiKey = validateAnthropicApiKey(process.env.ANTHROPIC_API_KEY)
  const voyageApiKey = validateVoyageApiKey(process.env.VOYAGE_API_KEY)
  // MYTHRUN_ENV + REGION_PREFIX feed the Redis key prefix. Staging and prod
  // share one ElastiCache cluster (per the MYT-39 §5.5 design); per-env
  // prefixing keeps their keyspaces disjoint. REGION_PREFIX is wired into
  // the ECS task definition (currently `use1`); MYTHRUN_ENV is set per env.
  const mythrunEnvRaw = process.env.MYTHRUN_ENV
  if (
    mythrunEnvRaw !== 'production' &&
    mythrunEnvRaw !== 'staging' &&
    mythrunEnvRaw !== 'development'
  ) {
    throw new Error(
      `loadEnv: MYTHRUN_ENV must be one of {'production','staging','development'}, got ${JSON.stringify(mythrunEnvRaw)}`,
    )
  }
  const regionPrefix = process.env.REGION_PREFIX
  if (!regionPrefix || regionPrefix.length === 0) {
    throw new Error('loadEnv: REGION_PREFIX is required (e.g. "use1")')
  }
  const redisKeyPrefix = `${mythrunEnvRaw}:${regionPrefix}:`
  return Object.freeze({
    databaseUrl: buildDatabaseUrl(),
    redisRealtimeUrl: buildRedisUrl('realtime'),
    redisBatchUrl: buildRedisUrl('batch'),
    port,
    ...authConfig,
    frontendBaseUrl,
    mythrunEnv: mythrunEnvRaw,
    redisKeyPrefix,
    stripeSecretKey,
    stripeWebhookSecret,
    anthropicApiKey,
    voyageApiKey,
  })
}
