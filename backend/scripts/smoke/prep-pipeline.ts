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
// Main — sections filled in by subsequent tasks
// ---------------------------------------------------------------------------

// Skeleton-only. Tasks 5+ make this genuinely async (auth + DB +
// per-campaign drive) — declared async here so the import-time top-level
// promise wiring at the bottom of the file already matches the eventual
// shape.
// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  const cfg = loadConfig()
  const startedAtMs = Date.now()
  log('info', 'phase', { phase: 'started', wallClockBudgetMs: cfg.wallClockBudgetMs, startedAtMs })

  // Tasks 5–11 add: auth, credits, run3Campaigns, verifyAssertions, teardown.

  log('info', 'phase', { phase: 'todo', note: 'main body lands in subsequent tasks' })
  process.exit(0)
}

main().catch((err: unknown) => {
  log('error', 'unhandled', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
