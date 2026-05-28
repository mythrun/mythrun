// backend/scripts/smoke/prep-pipeline.ts
//
// MYT-55 — end-to-end staging smoke for the prep pipeline.
//
// Drives 3 concurrent campaigns × 3 players each against the deployed
// staging API. Saturates worker concurrency caps (3 world-gen + 5
// campaign-setup = 8 in-flight Anthropic streams at peak). Verifies the
// three-layer assertion contract from the spec §3.4:
//   A. Phase completeness (campaigns active, worlds complete, all
//      pipeline_runs completed, characters present).
//   B. Per-concept floors (entity / relationship / fact counts).
//   C. Global gates (cost cap, wall-clock budget, zero 429s).
//
// On PASS: cascade-deletes everything created during the run.
// On FAIL: leaves state intact, prints IDs + the failed assertion, exits 1.
//
// Pattern reference: backend/scripts/smoke/entity-consolidation-flow.ts.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider'

// ---------------------------------------------------------------------------
// Config — env-driven, no defaults that point at production
// ---------------------------------------------------------------------------

interface SmokeConfig {
  readonly awsRegion: string
  readonly cognitoUserPoolId: string
  readonly cognitoClientId: string
  readonly apiBase: string
  readonly ownerSecretId: string
  readonly playerSecretIds: readonly [string, string, string]
  readonly dbUrlSecretId: string
  readonly wallClockBudgetMs: number
  readonly costCapUsd: number
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (v === undefined || v === '') {
    log('error', 'config_missing', { missing: [key] })
    process.exit(2)
  }
  return v
}

function loadConfig(): SmokeConfig {
  // Validate all required env vars up front (single missing-list log line
  // rather than failing on the first one accessed).
  const required = [
    'AWS_REGION',
    'COGNITO_USER_POOL_ID',
    'COGNITO_CLIENT_ID',
    'API_BASE',
    'SMOKE_OWNER_SECRET_ID',
    'SMOKE_PLAYER_1_SECRET_ID',
    'SMOKE_PLAYER_2_SECRET_ID',
    'SMOKE_PLAYER_3_SECRET_ID',
    'STAGING_DB_URL_SECRET_ID',
    'SMOKE_WALL_CLOCK_BUDGET_MS',
    'SMOKE_COST_CAP_USD',
  ]
  const missing = required.filter((k) => {
    const v = process.env[k]
    return v === undefined || v === ''
  })
  if (missing.length > 0) {
    log('error', 'config_missing', { missing })
    process.exit(2)
  }
  return {
    awsRegion: requireEnv('AWS_REGION'),
    cognitoUserPoolId: requireEnv('COGNITO_USER_POOL_ID'),
    cognitoClientId: requireEnv('COGNITO_CLIENT_ID'),
    apiBase: requireEnv('API_BASE').replace(/\/$/, ''),
    ownerSecretId: requireEnv('SMOKE_OWNER_SECRET_ID'),
    playerSecretIds: [
      requireEnv('SMOKE_PLAYER_1_SECRET_ID'),
      requireEnv('SMOKE_PLAYER_2_SECRET_ID'),
      requireEnv('SMOKE_PLAYER_3_SECRET_ID'),
    ] as const,
    dbUrlSecretId: requireEnv('STAGING_DB_URL_SECRET_ID'),
    wallClockBudgetMs: Number(requireEnv('SMOKE_WALL_CLOCK_BUDGET_MS')),
    costCapUsd: Number(requireEnv('SMOKE_COST_CAP_USD')),
  }
}

// ---------------------------------------------------------------------------
// Structured log — one JSON line per event to stdout
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', event: string, payload: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...payload }) + '\n',
  )
}

// ---------------------------------------------------------------------------
// Cognito auth — fetch creds from Secrets Manager, exchange for access token
// ---------------------------------------------------------------------------

interface CognitoCreds {
  readonly username: string
  readonly password: string
}

interface AuthedUser {
  readonly secretId: string
  readonly username: string
  readonly accessToken: string
}

async function fetchCreds(sm: SecretsManagerClient, secretId: string): Promise<CognitoCreds> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }))
  if (!res.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString`)
  }
  const parsed = JSON.parse(res.SecretString) as { username: string; password: string }
  return { username: parsed.username, password: parsed.password }
}

async function authUser(
  cog: CognitoIdentityProviderClient,
  cfg: SmokeConfig,
  creds: CognitoCreds,
): Promise<string> {
  const res = await cog.send(new InitiateAuthCommand({
    ClientId: cfg.cognitoClientId,
    AuthFlow: 'USER_AUTH',
    AuthParameters: {
      USERNAME: creds.username,
      PASSWORD: creds.password,
      PREFERRED_CHALLENGE: 'PASSWORD',
    },
  }))
  const token = res.AuthenticationResult?.AccessToken
  if (!token) {
    throw new Error(`Auth for ${creds.username} returned no AccessToken (challenge: ${res.ChallengeName ?? 'none'})`)
  }
  return token
}

async function authAll(cfg: SmokeConfig): Promise<{ owner: AuthedUser; players: readonly [AuthedUser, AuthedUser, AuthedUser] }> {
  const sm = new SecretsManagerClient({ region: cfg.awsRegion })
  const cog = new CognitoIdentityProviderClient({ region: cfg.awsRegion })
  log('info', 'auth_started', { region: cfg.awsRegion })
  const all = await Promise.all(
    [cfg.ownerSecretId, ...cfg.playerSecretIds].map(async (secretId) => {
      const creds = await fetchCreds(sm, secretId)
      const accessToken = await authUser(cog, cfg, creds)
      log('info', 'authed', { secretId, username: creds.username })
      return { secretId, username: creds.username, accessToken }
    }),
  )
  const [owner, p1, p2, p3] = all
  if (!owner || !p1 || !p2 || !p3) throw new Error('authAll: expected 4 users')
  return { owner, players: [p1, p2, p3] as const }
}

// ---------------------------------------------------------------------------
// Main — sections filled in by subsequent tasks
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig()
  const startedAtMs = Date.now()
  log('info', 'phase', { phase: 'started', wallClockBudgetMs: cfg.wallClockBudgetMs, startedAtMs })

  const { owner, players } = await authAll(cfg)
  log('info', 'phase', { phase: 'authed', userCount: 1 + players.length })

  // Tasks 6–11 add: credits, run3Campaigns, verifyAssertions, teardown.
  // Suppress unused-warnings on owner+players until T6 consumes them:
  void owner
  void players

  process.exit(0)
}

main().catch((err: unknown) => {
  log('error', 'unhandled', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
