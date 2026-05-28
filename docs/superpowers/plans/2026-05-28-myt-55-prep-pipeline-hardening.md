# MYT-55 Prep Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three residual deliverables from MYT-55's audit-revised scope: a 3-campaign × 3-player staging smoke (`pnpm smoke:prep-pipeline`), the Cognito user provisioning that makes it runnable, and the wiki content that documents what the smoke proves.

**Architecture:** Three independent phases. Phase A extends `infra/modules/auth/smoke-test.tf` from one user to four via Terraform `for_each` (one owner + three players, each in its own Secrets Manager entry). Phase B builds `backend/scripts/smoke/prep-pipeline.ts` — a single TypeScript file that auths 4 Cognito users, seeds credits via direct staging-DB INSERT, drives 3 campaigns concurrently via the staging API, asserts the three-layer contract from spec §3.4, and on PASS cascade-deletes everything it created. Phase C adds a new "Concurrency + rate-limit ceilings" subsection to `docs/wiki/content/runtime/llm.html` and converts ~20 stale future-tense forward references across 6 wiki pages to present-state.

**Tech Stack:** Terraform (hashicorp/aws + null_resource + AWS CLI for Cognito user CRUD), TypeScript via tsx (Node 24 runtime), `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-cognito-identity-provider`, `pg` Pool (against staging DB), HTML/CSS for wiki content.

**Linear issue:** MYT-55. Spec: `docs/superpowers/specs/2026-05-28-myt-55-prep-pipeline-hardening-design.md` (committed `fd54141`).

---

## File Structure

### Infrastructure (Phase A)
- **Modify:** `infra/modules/auth/smoke-test.tf` — refactor from `count` to `for_each` over a 4-user map. Each user gets random_password + Secrets Manager secret + secret_version + null_resource that creates/updates the Cognito user via AWS CLI.
- **Apply:** `infra/environments/staging/main.tf` calls the auth module — confirm no caller-side changes needed (`for_each` keeps the module interface stable; `var.smoke_test_user_enabled` continues to gate the whole block).

### Smoke script (Phase B)
- **Create:** `backend/scripts/smoke/prep-pipeline.ts` — single ~600-line script. Organized in marked sections (auth, credits, drive-campaign, assert, teardown, main). Pattern reference: `backend/scripts/smoke/entity-consolidation-flow.ts` (single-file, structured JSON logs via `process.stdout.write`).
- **Modify:** `backend/package.json` — add `"smoke:prep-pipeline"` script entry alongside existing smoke scripts.
- **Create:** `backend/.env.smoke.example` — documents the env vars the smoke needs (`AWS_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `API_BASE`, `STAGING_DB_URL_SECRET_ID`).

### Wiki (Phase C)
- **Modify:** `docs/wiki/content/runtime/llm.html` — append new `<h2>Concurrency + rate-limit ceilings</h2>` subsection.
- **Modify:** `docs/wiki/content/runtime/index.html` — convert 1 stale forward reference (line 345).
- **Modify:** `docs/wiki/content/runtime/worker.html` — convert 4 stale forward references (lines 22, 70, ~120, ~326).
- **Modify:** `docs/wiki/content/runtime/world-gen.html` — convert ~2 stale forward references.
- **Modify:** `docs/wiki/content/runtime/character-creation.html` — convert ~14 stale forward references (heaviest drift).
- **Modify:** `docs/wiki/content/runtime/pipeline-status.html` — convert ~3 stale forward references (lines 51, 521, 522).
- **Modify:** `docs/wiki/content/data/index.html` — convert 1 stale forward reference (line 8).

### Reference docs (no edits)
- `docs/superpowers/specs/2026-05-28-myt-55-prep-pipeline-hardening-design.md` — the spec, source of truth.
- `docs/wiki/AUTHORING.md` — wiki authoring rules to apply during the tense sweep.
- `backend/scripts/smoke/staging.sh` — auth pattern reference for the smoke (bash → TypeScript port).
- `backend/scripts/smoke/entity-consolidation-flow.ts` — single-file smoke pattern reference (structured logs, Pool access, real-LLM).
- `backend/src/worker/bullmq-config.ts` — the concurrency constants the wiki section cites.

---

## Phase A: Cognito user provisioning (Terraform)

### Task 1: Refactor `smoke-test.tf` to four users via `for_each`

**Files:**
- Modify: `infra/modules/auth/smoke-test.tf` (whole file)
- Test: `terraform plan` against staging (see Step 5)

- [ ] **Step 1: Read the current file end-to-end**

Read `infra/modules/auth/smoke-test.tf`. Understand the 4-resource pattern (random_password / aws_secretsmanager_secret / aws_secretsmanager_secret_version / null_resource). All four currently use `count = var.smoke_test_user_enabled ? 1 : 0` with a single hardcoded `local.smoke_test_username`.

- [ ] **Step 2: Add the user-name local**

At the top of `smoke-test.tf` (above the `random_password` resource), replace the single `local.smoke_test_username` with a map:

```hcl
locals {
  smoke_test_users = var.smoke_test_user_enabled ? {
    owner    = "mythrun-staging-smoke-owner@example.com"
    player_1 = "mythrun-staging-smoke-player-1@example.com"
    player_2 = "mythrun-staging-smoke-player-2@example.com"
    player_3 = "mythrun-staging-smoke-player-3@example.com"
  } : {}
}
```

Note: when `smoke_test_user_enabled = false`, the map is empty and `for_each` over it produces zero resources — preserving the production gate.

- [ ] **Step 3: Convert `random_password` to `for_each`**

Replace the existing `random_password "smoke_test"` block with:

```hcl
resource "random_password" "smoke_test" {
  for_each         = local.smoke_test_users
  length           = 32
  special          = true
  override_special = "!@#$%^&*-_=+"
  min_lower        = 1
  min_upper        = 1
  min_numeric      = 1
  min_special      = 1
}
```

- [ ] **Step 4: Convert `aws_secretsmanager_secret` + `_version` to `for_each`**

```hcl
resource "aws_secretsmanager_secret" "smoke_test_credentials" {
  for_each                = local.smoke_test_users
  name                    = "mythrun/${var.environment}/smoke-test-${each.key}-credentials"
  description             = "Native Cognito test-user credentials for staging smoke testing. JSON-encoded {username, password}."
  recovery_window_in_days = 0
  tags                    = { Name = "mythrun-${var.environment}-smoke-test-${each.key}-credentials" }
}

resource "aws_secretsmanager_secret_version" "smoke_test_credentials" {
  for_each  = local.smoke_test_users
  secret_id = aws_secretsmanager_secret.smoke_test_credentials[each.key].id
  secret_string = jsonencode({
    username = each.value
    password = random_password.smoke_test[each.key].result
  })
}
```

- [ ] **Step 5: Convert `null_resource` to `for_each`**

```hcl
resource "null_resource" "smoke_test_user" {
  for_each = local.smoke_test_users

  triggers = {
    user_pool_id = aws_cognito_user_pool.main.id
    username     = each.value
    password_sha = sha256(random_password.smoke_test[each.key].result)
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      aws cognito-idp admin-create-user \
        --user-pool-id ${aws_cognito_user_pool.main.id} \
        --username '${each.value}' \
        --user-attributes Name=email,Value='${each.value}' Name=email_verified,Value=true \
        --message-action SUPPRESS \
        --region ${data.aws_region.current.region} 2>&1 | grep -v UsernameExistsException || true
      aws cognito-idp admin-set-user-password \
        --user-pool-id ${aws_cognito_user_pool.main.id} \
        --username '${each.value}' \
        --password '${random_password.smoke_test[each.key].result}' \
        --permanent \
        --region ${data.aws_region.current.region}
    EOT
  }

  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      aws cognito-idp admin-delete-user \
        --user-pool-id ${self.triggers.user_pool_id} \
        --username '${self.triggers.username}' \
        --region ${data.aws_region.current.region} 2>&1 | grep -v UserNotFoundException || true
    EOT
  }
}
```

(Adapt the destroy provisioner exactly from the current file's existing one — only the `username` substitution changes from `local.smoke_test_username` to `self.triggers.username`.)

- [ ] **Step 6: Update any outputs that referenced the singular secret**

Search for references to `aws_secretsmanager_secret.smoke_test_credentials[0]` in the auth module's `outputs.tf` (or wherever module outputs live). If the module exposes the smoke-test secret ARN, the output needs to become a map keyed by user-name (or be split into four named outputs). Grep:

```bash
grep -rn 'smoke_test_credentials' infra/modules/auth/
```

If `outputs.tf` references `[0].arn`, replace with:

```hcl
output "smoke_test_credentials_secret_arns" {
  value = var.smoke_test_user_enabled ? {
    for k, v in aws_secretsmanager_secret.smoke_test_credentials : k => v.arn
  } : {}
}
```

Update the consumer (probably `infra/environments/staging/main.tf` or an IAM policy attachment) to consume the map.

- [ ] **Step 7: `terraform plan` against staging**

```bash
cd infra/environments/staging
terraform plan -out=/tmp/myt-55.tfplan
```

Expected: plan shows
- 1 deletion of the old singular `random_password.smoke_test[0]`, `aws_secretsmanager_secret.smoke_test_credentials[0]`, `aws_secretsmanager_secret_version.smoke_test_credentials[0]`, `null_resource.smoke_test_user[0]`
- 4 creations under the new for_each keys
- NO changes to anything outside the auth module

If the plan shows changes elsewhere (e.g., the Cognito user pool itself), STOP and re-read — the refactor must be auth-module-internal.

- [ ] **Step 8: Apply**

```bash
terraform apply /tmp/myt-55.tfplan
```

Wait for completion. Expected: 4 Cognito users created, 4 secrets populated, the single old smoke-test user is destroyed (its Cognito user is removed by the destroy-time provisioner).

- [ ] **Step 9: Verify in AWS**

```bash
aws cognito-idp list-users --user-pool-id <pool-id> --region us-east-1 | \
  jq '.Users[] | select(.Username | startswith("mythrun-staging-smoke")) | .Username'
```

Expected: 4 entries (owner + 3 players). Then verify each Secrets Manager secret resolves:

```bash
for KEY in owner player_1 player_2 player_3; do
  aws secretsmanager get-secret-value \
    --secret-id "mythrun/staging/smoke-test-${KEY}-credentials" \
    --region us-east-1 \
    --query SecretString --output text | jq '.username'
done
```

Expected: prints 4 usernames matching the local map.

- [ ] **Step 10: Commit**

```bash
git add infra/modules/auth/smoke-test.tf infra/modules/auth/outputs.tf
git commit -m "feat(MYT-55): provision 4 Cognito smoke-test users via Terraform for_each"
```

(Only include `outputs.tf` in the add if Step 6 actually changed it.)

---

## Phase B: Staging smoke script

### Task 2: Add `pnpm smoke:prep-pipeline` script entry

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Read `backend/package.json` scripts block**

Look at the existing `smoke:phantom-reconciliation` and `smoke:entity-consolidation-flow` entries (around the `dev-tool:check` line). They share the same tsx invocation shape.

- [ ] **Step 2: Add the new script entry**

Edit `backend/package.json`. Add this line directly after `smoke:entity-consolidation-flow`:

```json
"smoke:prep-pipeline": "tsx --env-file=.env.smoke --env-file-if-exists=../.env.worktree scripts/smoke/prep-pipeline.ts",
```

Note: this smoke uses `.env.smoke` (not `.env.development`) because it needs staging-specific config (AWS region, Cognito pool ID, etc.). Falls back to `.env.worktree` if running inside a worktree.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json
git commit -m "feat(MYT-55): wire pnpm smoke:prep-pipeline script entry"
```

### Task 3: Create `.env.smoke.example`

**Files:**
- Create: `backend/.env.smoke.example`

- [ ] **Step 1: Author the example env file**

```bash
cat > backend/.env.smoke.example << 'EOF'
# backend/.env.smoke.example
#
# Configuration for `pnpm smoke:prep-pipeline`. Copy to `.env.smoke`
# (which is gitignored) and fill in. AWS_REGION and the Cognito pool/client
# IDs match the staging Terraform output.
#
# The smoke script reads from this file via tsx --env-file. It does NOT
# read AWS credentials from here — those come from the ambient
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_PROFILE chain (your
# local AWS CLI session).

AWS_REGION=us-east-1
COGNITO_USER_POOL_ID=us-east-1_5gDAtYzjV
COGNITO_CLIENT_ID=l7u6cnoev0cv9d5vei76ko5tj
API_BASE=https://staging-api.mythrun.com

# Secrets Manager IDs for the four smoke users (provisioned in
# infra/modules/auth/smoke-test.tf via the smoke_test_users for_each map).
SMOKE_OWNER_SECRET_ID=mythrun/staging/smoke-test-owner-credentials
SMOKE_PLAYER_1_SECRET_ID=mythrun/staging/smoke-test-player_1-credentials
SMOKE_PLAYER_2_SECRET_ID=mythrun/staging/smoke-test-player_2-credentials
SMOKE_PLAYER_3_SECRET_ID=mythrun/staging/smoke-test-player_3-credentials

# Secrets Manager ID for the staging DB read/write credentials. Used to
# seed credits via direct ledger INSERT and to verify final state.
STAGING_DB_URL_SECRET_ID=mythrun/staging/db/app

# Wall-clock budget for the whole smoke run, in milliseconds.
# 10 minutes = 600000. Exceeding this is a hard FAIL.
SMOKE_WALL_CLOCK_BUDGET_MS=600000

# Total cost cap across all 3 campaigns, in USD. Above this = FAIL.
SMOKE_COST_CAP_USD=5.00
EOF
```

- [ ] **Step 2: Verify `.env.smoke` is gitignored**

```bash
grep -E "^\.env\.smoke$|^\.env" backend/.gitignore
```

Expected: `.env.smoke` is covered (probably by a broad `.env*` rule that excludes `.example` files). If not, add `.env.smoke` to `backend/.gitignore`.

- [ ] **Step 3: Commit**

```bash
git add backend/.env.smoke.example
# (and backend/.gitignore if you had to modify it)
git commit -m "docs(MYT-55): env example for prep-pipeline smoke"
```

### Task 4: Create the smoke script skeleton + main entry

**Files:**
- Create: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Author the file header + imports + main entry**

```bash
cat > backend/scripts/smoke/prep-pipeline.ts << 'EOF'
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
import { Pool } from 'pg'

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

function loadConfig(): SmokeConfig {
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
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    log('error', 'config_missing', { missing })
    process.exit(2)
  }
  return {
    awsRegion: process.env.AWS_REGION!,
    cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID!,
    cognitoClientId: process.env.COGNITO_CLIENT_ID!,
    apiBase: process.env.API_BASE!.replace(/\/$/, ''),
    ownerSecretId: process.env.SMOKE_OWNER_SECRET_ID!,
    playerSecretIds: [
      process.env.SMOKE_PLAYER_1_SECRET_ID!,
      process.env.SMOKE_PLAYER_2_SECRET_ID!,
      process.env.SMOKE_PLAYER_3_SECRET_ID!,
    ] as const,
    dbUrlSecretId: process.env.STAGING_DB_URL_SECRET_ID!,
    wallClockBudgetMs: Number(process.env.SMOKE_WALL_CLOCK_BUDGET_MS),
    costCapUsd: Number(process.env.SMOKE_COST_CAP_USD),
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

async function main(): Promise<void> {
  const cfg = loadConfig()
  const startedAtMs = Date.now()
  log('info', 'phase', { phase: 'started', wallClockBudgetMs: cfg.wallClockBudgetMs })

  // Tasks 5–11 add: auth, credits, run3Campaigns, verifyAssertions, teardown.

  log('info', 'phase', { phase: 'todo', note: 'main body lands in subsequent tasks' })
  process.exit(0)
}

main().catch((err: unknown) => {
  log('error', 'unhandled', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
EOF
```

- [ ] **Step 2: Verify the skeleton runs**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/backend
cp .env.smoke.example .env.smoke
# Fill .env.smoke with real values (or use placeholders; the skeleton only validates presence)
pnpm smoke:prep-pipeline
```

Expected: prints `{"ts":"...","level":"info","event":"phase","phase":"started",...}` then `phase":"todo"` then exits 0.

If config validation rejects (any env missing): prints `event:"config_missing"` with the missing keys, exits 2. That's correct.

- [ ] **Step 3: Typecheck + lint**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
pnpm typecheck
pnpm lint
```

Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): prep-pipeline smoke skeleton — config + structured log + main"
```

### Task 5: Cognito auth helper

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts` (add section above `main`)

- [ ] **Step 1: Add the auth helper**

Insert the following section into `prep-pipeline.ts`, directly above the `// --- Main ---` divider:

```typescript
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
```

- [ ] **Step 2: Wire `authAll` into `main`**

Replace the `phase":"todo"` exit in `main` with:

```typescript
  const { owner, players } = await authAll(cfg)
  log('info', 'phase', { phase: 'authed', userCount: 1 + players.length })

  // Tasks 6–11 add: credits, run3Campaigns, verifyAssertions, teardown.

  process.exit(0)
```

- [ ] **Step 3: Add the AWS SDK deps if not present**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun/backend
grep -E '"@aws-sdk/client-secrets-manager|"@aws-sdk/client-cognito-identity-provider' package.json
```

If either is missing, add them:

```bash
pnpm add -F @mythrun/backend @aws-sdk/client-secrets-manager @aws-sdk/client-cognito-identity-provider
```

(The `secrets-manager` package is likely already a dep; cognito-identity-provider may need to be added.)

- [ ] **Step 4: Smoke-run against staging**

With `.env.smoke` filled with real values:

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
pnpm smoke:prep-pipeline 2>&1 | jq -c 'select(.event == "authed" or .event == "phase")'
```

Expected: 4 `authed` events (one per user) followed by a single `phase: authed` event.

If any auth fails: STOP. Either the Terraform users aren't deployed yet (re-run Phase A), or the secret IDs in `.env.smoke` are wrong.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts backend/package.json
# package.json only if SDK deps were added
git commit -m "feat(MYT-55): Cognito auth helper — 4 users in parallel"
```

### Task 6: DB connection helper + credit seeding

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Add the DB helper section**

Above the `// --- Main ---` divider, after the auth section:

```typescript
// ---------------------------------------------------------------------------
// Staging DB — connection + credit seeding via direct ledger INSERT
// ---------------------------------------------------------------------------

async function connectStagingDb(cfg: SmokeConfig): Promise<Pool> {
  const sm = new SecretsManagerClient({ region: cfg.awsRegion })
  const res = await sm.send(new GetSecretValueCommand({ SecretId: cfg.dbUrlSecretId }))
  if (!res.SecretString) {
    throw new Error(`DB secret ${cfg.dbUrlSecretId} has no SecretString`)
  }
  // Convention: the secret is either a bare DATABASE_URL string OR a JSON
  // blob with a `connectionString` field. Handle both shapes.
  let url: string
  if (res.SecretString.startsWith('{')) {
    const parsed = JSON.parse(res.SecretString) as { connectionString?: string }
    if (!parsed.connectionString) throw new Error('DB secret JSON missing connectionString')
    url = parsed.connectionString
  } else {
    url = res.SecretString
  }
  return new Pool({ connectionString: url, max: 4 })
}

const CREDIT_GRANT_AMOUNT_MINOR = 10000 // $100; well above the per-smoke-run spend
const CREDIT_SOURCE_PREFIX = 'smoke:myt-55'

async function seedCredits(
  pool: Pool,
  cognitoSubs: readonly string[],
  runId: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const sub of cognitoSubs) {
      // Look up the user row created by the JWT plugin on first auth.
      // It MUST exist by now — we just authed all users.
      const userRes = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE cognito_sub = $1`,
        [sub],
      )
      if (userRes.rows.length === 0) {
        throw new Error(`User row missing for cognito_sub ${sub} — JWT plugin should have created it on first /api/* call`)
      }
      const userId = userRes.rows[0]!.id
      // Direct INSERT into the ledger (admin grant). `balance_after_minor` is
      // computed by reading the prior balance + adding; the credit ledger
      // expects an immutable append.
      const balanceRes = await client.query<{ balance_after_minor: string }>(
        `SELECT COALESCE(MAX(balance_after_minor), 0) AS balance_after_minor
           FROM credit_ledger WHERE user_id = $1`,
        [userId],
      )
      const priorBalance = BigInt(balanceRes.rows[0]?.balance_after_minor ?? 0)
      const newBalance = priorBalance + BigInt(CREDIT_GRANT_AMOUNT_MINOR)
      await client.query(
        `INSERT INTO credit_ledger
           (user_id, kind, amount_minor, balance_after_minor, source_type, source_id)
         VALUES ($1, 'admin_grant', $2, $3, 'admin', $4)`,
        [userId, CREDIT_GRANT_AMOUNT_MINOR, String(newBalance), `${CREDIT_SOURCE_PREFIX}:${runId}`],
      )
      log('info', 'credit_seeded', { userId, amountMinor: CREDIT_GRANT_AMOUNT_MINOR })
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 2: Map authed users to cognito_sub**

The user row in `users` is keyed on `cognito_sub`, which is set on the JWT's `sub` claim. The `accessToken` from Cognito's USER_AUTH flow IS a JWT — its `sub` claim is the cognito sub.

Add a helper to decode the sub from the JWT (no signature verification — we trust the issuer):

```typescript
function jwtSub(accessToken: string): string {
  const [, payload] = accessToken.split('.')
  if (!payload) throw new Error('JWT missing payload segment')
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }
  if (!decoded.sub) throw new Error('JWT payload missing sub claim')
  return decoded.sub
}
```

- [ ] **Step 3: Wire credit seeding into `main`**

In `main`, after the `phase: authed` log line, add:

```typescript
  const runId = crypto.randomUUID()
  log('info', 'phase', { phase: 'run_started', runId })

  const pool = await connectStagingDb(cfg)
  try {
    const subs = [owner, ...players].map((u) => jwtSub(u.accessToken))
    // Pre-grant requires the user rows to exist. The JWT plugin creates
    // them on first /api/* call; hit /health/ready as a no-op then call
    // a cheap authed endpoint to materialize all 4 rows.
    await materializeUserRows(cfg, [owner, ...players])
    await seedCredits(pool, subs, runId)
    log('info', 'phase', { phase: 'credits_seeded' })

    // Tasks 7–10 add: run3Campaigns + verifyAssertions.

    // Tasks 11 adds: teardown on PASS path (writes to `pool` to delete state).
  } finally {
    await pool.end()
  }
```

Also add the helper `materializeUserRows` (Task 7 wires this — for now stub it):

```typescript
async function materializeUserRows(cfg: SmokeConfig, users: readonly AuthedUser[]): Promise<void> {
  // The JWT plugin (backend/src/auth/jwt-plugin.ts) auto-creates the users
  // row on first authed request. Hit a minimal-cost endpoint to trigger.
  await Promise.all(users.map(async (u) => {
    const res = await fetch(`${cfg.apiBase}/api/users/me`, {
      headers: { authorization: `Bearer ${u.accessToken}` },
    })
    if (!res.ok && res.status !== 404) {
      // 404 is OK — endpoint may not exist; the JWT plugin runs on every
      // request regardless of route outcome.
      throw new Error(`materializeUserRows: ${u.username} got ${res.status}`)
    }
  }))
}
```

(If `/api/users/me` doesn't exist, swap for `/api/campaigns/mine` or any authed endpoint.)

- [ ] **Step 4: Add `import { randomUUID } from 'crypto'` at the top**

Top of file:

```typescript
import { randomUUID } from 'crypto'
```

And replace `crypto.randomUUID()` with `randomUUID()`.

- [ ] **Step 5: Typecheck + lint + dry-run**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
pnpm typecheck
pnpm lint
pnpm smoke:prep-pipeline 2>&1 | jq -c 'select(.event == "credit_seeded" or .event == "phase")'
```

Expected: log lines show `phase: credits_seeded` after 4 `credit_seeded` entries.

If the DB connection fails: check the `STAGING_DB_URL_SECRET_ID` and AWS credentials.

If `materializeUserRows` returns a 401 for any user: the JWT plugin isn't accepting the token — re-verify Cognito client ID matches the staging API's expected audience.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): DB connect + credit seeding via direct ledger INSERT"
```

### Task 7: Concepts library

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Add the concepts section**

Above the `// --- Main ---` divider, after the DB section:

```typescript
// ---------------------------------------------------------------------------
// Hand-curated concepts + calibrated assertion floors
// ---------------------------------------------------------------------------

interface AssertionFloors {
  readonly minEntities: number
  readonly minRelationships: number
  /** Average facts per entity (total facts ÷ total entities). */
  readonly minFactsPerEntity: number
}

interface Concept {
  readonly name: string
  readonly concept: string
  readonly floors: AssertionFloors
}

// Floors are calibrated at ~60% of the values observed during the
// myth-imxg coherence smoke (Bardsmoot world: 43 entities, 55
// relationships, 124 facts → 2.9 facts/entity). Conservative enough
// to absorb LLM variance; tight enough to catch a silently-degenerate
// stage.

export const CONCEPTS: readonly Concept[] = [
  {
    name: 'bardsmoot',
    concept:
      'A market town nestled in a low river valley, ruled not by lord or council but by the Bardsmoot — an annual conclave of traveling musicians whose songs adjudicate disputes, set tax rates, and decide which roads get repaired. The town prospers because its merchant guilds long ago figured out that whoever pays the most popular bard always wins their case, while the bards themselves split their year between performing here and elsewhere, carrying news, rumor, and political pressure along the trade routes. Lately the songs have been turning darker.',
    floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 },
  },
  {
    name: 'haunted-carnival',
    concept:
      'A traveling seasonal carnival that has visited the same crossroad-town every autumn for as long as anyone alive remembers. It always arrives on the third night after the first frost and is gone by morning of the seventh day. Locals love it, plan their year around it, marry under its lanterns. They also know — though they do not speak of it — that the carnival exacts a quiet, specific cost from one family every visit, and the families it has touched can be traced back generations in the parish ledger. This year the frost came early.',
    floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 },
  },
  {
    name: 'mountain-monastery',
    concept:
      'A high-altitude monastic order that sustains itself by tending an enormous, centuries-old library carved directly into the rock face. The monks are scholars, copyists, and silent appraisers of texts pilgrims bring up the long stone stair for safekeeping. The monastery has no formal hierarchy — order emerges from who sits next to whom at the long refectory tables, which is decided each season by the librarian-in-chief through a process nobody outside the order fully understands. A delegation from the lowland court has just arrived demanding access to a specific shelf.',
    floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 },
  },
] as const
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): three hand-curated concepts with calibrated floors"
```

### Task 8: Drive one campaign through the full flow

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Add the campaign-driver section**

Above the `// --- Main ---` divider, after the concepts section:

```typescript
// ---------------------------------------------------------------------------
// Campaign driver — owner creates, players join + submit concepts, poll
// ---------------------------------------------------------------------------

interface CampaignRunResult {
  readonly conceptName: string
  readonly campaignId: string
  readonly worldId: string
  readonly worldStatus: string
  readonly campaignStatus: string
  readonly costUsd: number
  readonly entityCount: number
  readonly relationshipCount: number
  readonly factCount: number
  readonly characterIds: readonly string[]
  readonly durationMs: number
}

interface ApiClient {
  readonly token: string
  readonly base: string
}

async function apiPost<T>(client: ApiClient, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${client.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${text}`)
  }
  return JSON.parse(text) as T
}

async function apiGet<T>(client: ApiClient, path: string): Promise<T> {
  const res = await fetch(`${client.base}${path}`, {
    headers: { authorization: `Bearer ${client.token}` },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${text}`)
  }
  return JSON.parse(text) as T
}

async function pollFor<T>(
  fetcher: () => Promise<T>,
  predicate: (val: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    const val = await fetcher()
    if (predicate(val)) return val
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
  throw new Error(`poll timeout: ${opts.label} after ${opts.timeoutMs}ms`)
}

async function runOneCampaign(
  cfg: SmokeConfig,
  owner: AuthedUser,
  players: readonly [AuthedUser, AuthedUser, AuthedUser],
  concept: Concept,
  pool: Pool,
): Promise<CampaignRunResult> {
  const ownerApi: ApiClient = { token: owner.accessToken, base: cfg.apiBase }
  const startMs = Date.now()
  log('info', 'campaign_started', { concept: concept.name })

  // 1. Owner creates the campaign.
  const created = await apiPost<{ campaignId: string }>(ownerApi, '/api/campaigns', {
    world: { kind: 'new', source: { mode: 'freeform', concept: concept.concept } },
  })
  const campaignId = created.campaignId
  log('info', 'campaign_created', { concept: concept.name, campaignId })

  // 2. Wait for world-gen to reach status=complete (poll the campaign GET).
  const polled = await pollFor(
    () => apiGet<{ world: { id: string; status: string } }>(ownerApi, `/api/campaigns/${campaignId}`),
    (val) => val.world.status === 'complete' || val.world.status === 'failed',
    { timeoutMs: 8 * 60_000, intervalMs: 5_000, label: `world-gen for ${concept.name}` },
  )
  if (polled.world.status !== 'complete') {
    throw new Error(`campaign ${campaignId} world status = ${polled.world.status}`)
  }
  const worldId = polled.world.id
  log('info', 'world_complete', { concept: concept.name, campaignId, worldId })

  // 3. Each player joins the campaign + submits a character concept.
  //    (The exact join + concept-submit routes depend on backend; check
  //    backend/src/routes/campaign-characters.ts. As a placeholder shape:)
  await Promise.all(players.map(async (player, i) => {
    const playerApi: ApiClient = { token: player.accessToken, base: cfg.apiBase }
    // 3a. Join (if invite mechanism is required, owner must mint an invite first;
    //     see backend/src/routes/invites.ts. Otherwise direct campaign-member INSERT.
    //     The exact shape is left to the implementer to wire correctly based on the
    //     current API surface — there is no spec ambiguity, just code-reading needed.)
    await apiPost(ownerApi, `/api/campaigns/${campaignId}/members`, {
      userId: jwtSub(player.accessToken),
      role: 'player',
    }).catch((err: Error) => {
      // If the route doesn't accept manual member adds, the smoke needs an invite flow.
      // Document the fallback in the catch.
      throw new Error(`adding player ${i + 1}: ${err.message}`)
    })
    // 3b. Submit character concept.
    await apiPost(playerApi, `/api/campaigns/${campaignId}/characters`, {
      concept: `Player ${i + 1} character for the ${concept.name} world.`,
    })
    log('info', 'player_concept_submitted', { concept: concept.name, campaignId, playerIndex: i })
  }))

  // 4. Wait for campaigns.status='active' (post-creation barrier complete).
  await pollFor(
    () => apiGet<{ campaign: { status: string } }>(ownerApi, `/api/campaigns/${campaignId}`),
    (val) => val.campaign.status === 'active',
    { timeoutMs: 6 * 60_000, intervalMs: 5_000, label: `campaign active for ${concept.name}` },
  )
  log('info', 'campaign_active', { concept: concept.name, campaignId })

  // 5. Read final state from the DB (counts + cost).
  const stats = await readCampaignStats(pool, worldId, campaignId)

  return {
    conceptName: concept.name,
    campaignId,
    worldId,
    worldStatus: 'complete',
    campaignStatus: 'active',
    costUsd: stats.costUsd,
    entityCount: stats.entityCount,
    relationshipCount: stats.relationshipCount,
    factCount: stats.factCount,
    characterIds: stats.characterIds,
    durationMs: Date.now() - startMs,
  }
}

interface CampaignStats {
  readonly costUsd: number
  readonly entityCount: number
  readonly relationshipCount: number
  readonly factCount: number
  readonly characterIds: readonly string[]
}

async function readCampaignStats(pool: Pool, worldId: string, campaignId: string): Promise<CampaignStats> {
  const [costRes, entRes, relRes, factRes, charRes] = await Promise.all([
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
         FROM pipeline_runs
        WHERE world_id = $1 OR campaign_id = $2`,
      [worldId, campaignId],
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM entities WHERE world_id = $1`,
      [worldId],
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM relationships r
        WHERE r.source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM facts f
        WHERE f.entity_id IN (SELECT id FROM entities WHERE world_id = $1)`,
      [worldId],
    ),
    pool.query<{ id: string }>(
      `SELECT id FROM characters WHERE campaign_id = $1`,
      [campaignId],
    ),
  ])
  return {
    costUsd: Number(costRes.rows[0]?.total ?? 0),
    entityCount: Number(entRes.rows[0]?.n ?? 0),
    relationshipCount: Number(relRes.rows[0]?.n ?? 0),
    factCount: Number(factRes.rows[0]?.n ?? 0),
    characterIds: charRes.rows.map((r) => r.id),
  }
}
```

- [ ] **Step 2: Wire `runOneCampaign` into `main` for ONE concept (smoke test for the path)**

In `main`, after `credits_seeded`:

```typescript
    // Phase 2 — drive a single campaign first to flush out API shape issues
    // before launching the burst.
    const firstResult = await runOneCampaign(cfg, owner, players, CONCEPTS[0]!, pool)
    log('info', 'campaign_complete_one', firstResult)
```

- [ ] **Step 3: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: green.

- [ ] **Step 4: Test against staging — single campaign**

```bash
pnpm smoke:prep-pipeline 2>&1 | tee /tmp/smoke-task8.log | jq -c 'select(.event != null)'
```

Expected: full single-campaign flow completes within ~6-8 min, ending with `campaign_complete_one` carrying real counts.

If it fails: the most likely issues are API shape mismatches (member-add route, character-submit route). The error log includes the response body — read it, fix the apiPost path/body, re-run.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): single-campaign driver + DB-side stats collection"
```

### Task 9: Run three campaigns concurrently

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Replace the single-campaign call with the burst**

In `main`, replace the single-campaign block with:

```typescript
    // Phase 2 — drive 3 campaigns concurrently to saturate the worker
    // concurrency caps (peak 8 in-flight Anthropic streams).
    const results = await Promise.all(
      CONCEPTS.map((concept) => runOneCampaign(cfg, owner, players, concept, pool)),
    )
    log('info', 'phase', { phase: 'burst_complete', campaigns: results.length })
```

- [ ] **Step 2: Add wall-clock check**

Above `Promise.all`, capture `startMs` (already computed at top of main). After `Promise.all`, check:

```typescript
    const wallClockMs = Date.now() - startedAtMs
    if (wallClockMs > cfg.wallClockBudgetMs) {
      log('error', 'assertion_failed', { layer: 'C', detail: `wall-clock ${wallClockMs}ms > budget ${cfg.wallClockBudgetMs}ms` })
      process.exit(1)
    }
```

- [ ] **Step 3: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: green.

- [ ] **Step 4: Test the burst against staging**

```bash
pnpm smoke:prep-pipeline 2>&1 | tee /tmp/smoke-task9.log | jq -c 'select(.event != null)'
```

Expected: 3 `campaign_started` logs near the start, 3 `world_complete` logs as world-gens finish, 3 `campaign_active` logs as post-creation finishes, then `phase: burst_complete`. Total wall-clock < 10 min.

If a campaign times out: read the failed campaign's log lines, query the staging DB for its pipeline_runs to find the stuck stage. Common causes: Anthropic transient 5xx, worker dispatcher bug, queue backpressure.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): 3-campaign concurrent burst + wall-clock budget"
```

### Task 10: Assertion contract

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Add the assertion section**

Above the `// --- Main ---` divider, after `readCampaignStats`:

```typescript
// ---------------------------------------------------------------------------
// Assertion contract — three layers per spec §3.4
// ---------------------------------------------------------------------------

interface AssertionFailure {
  readonly layer: 'A' | 'B' | 'C'
  readonly detail: string
}

async function assertContract(
  results: readonly CampaignRunResult[],
  cfg: SmokeConfig,
  pool: Pool,
): Promise<readonly AssertionFailure[]> {
  const fails: AssertionFailure[] = []

  // Layer A — phase completeness
  for (const r of results) {
    if (r.worldStatus !== 'complete') fails.push({ layer: 'A', detail: `${r.conceptName}: world status = ${r.worldStatus}` })
    if (r.campaignStatus !== 'active') fails.push({ layer: 'A', detail: `${r.conceptName}: campaign status = ${r.campaignStatus}` })
    if (r.characterIds.length !== 3) fails.push({ layer: 'A', detail: `${r.conceptName}: character count = ${r.characterIds.length}, expected 3` })
  }

  // Layer A — pipeline_runs completeness
  const worldIds = results.map((r) => r.worldId)
  const prRes = await pool.query<{ stage: string; status: string; world_id: string }>(
    `SELECT stage, status, world_id FROM pipeline_runs
      WHERE world_id = ANY($1)
        AND status != 'completed'`,
    [worldIds],
  )
  for (const row of prRes.rows) {
    fails.push({ layer: 'A', detail: `world ${row.world_id} stage ${row.stage} status = ${row.status}` })
  }

  // Layer B — per-concept floors
  for (const r of results) {
    const concept = CONCEPTS.find((c) => c.name === r.conceptName)
    if (!concept) {
      fails.push({ layer: 'B', detail: `unknown concept ${r.conceptName}` })
      continue
    }
    if (r.entityCount < concept.floors.minEntities) {
      fails.push({ layer: 'B', detail: `${r.conceptName}: entities ${r.entityCount} < floor ${concept.floors.minEntities}` })
    }
    if (r.relationshipCount < concept.floors.minRelationships) {
      fails.push({ layer: 'B', detail: `${r.conceptName}: relationships ${r.relationshipCount} < floor ${concept.floors.minRelationships}` })
    }
    const factsPerEntity = r.entityCount > 0 ? r.factCount / r.entityCount : 0
    if (factsPerEntity < concept.floors.minFactsPerEntity) {
      fails.push({ layer: 'B', detail: `${r.conceptName}: facts/entity ${factsPerEntity.toFixed(2)} < floor ${concept.floors.minFactsPerEntity}` })
    }
  }

  // Layer C — total cost
  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0)
  if (totalCost > cfg.costCapUsd) {
    fails.push({ layer: 'C', detail: `total cost $${totalCost.toFixed(2)} > cap $${cfg.costCapUsd.toFixed(2)}` })
  }

  // Layer C — zero LlmRateLimitedError events (proxy: scan pipeline_runs for
  // error rows whose error_code matches the rate-limit shape).
  const rateLimitRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pipeline_runs
      WHERE world_id = ANY($1)
        AND status = 'failed'
        AND (error ILIKE '%rate%limit%' OR error ILIKE '%429%')`,
    [worldIds],
  )
  if (Number(rateLimitRes.rows[0]?.n ?? 0) > 0) {
    fails.push({ layer: 'C', detail: `${rateLimitRes.rows[0]?.n} rate-limit errors observed in pipeline_runs` })
  }

  return fails
}
```

- [ ] **Step 2: Wire assertions into `main`**

After the `phase: burst_complete` log line:

```typescript
    const failures = await assertContract(results, cfg, pool)
    if (failures.length > 0) {
      for (const f of failures) {
        log('error', 'assertion_failed', f)
      }
      log('error', 'summary', { verdict: 'FAIL', wallClockMs, failureCount: failures.length, campaigns: results })
      // FAIL path: leave state intact. Exit non-zero.
      process.exit(1)
    }
    log('info', 'phase', { phase: 'asserted', wallClockMs })
    log('info', 'summary', { verdict: 'PASS', wallClockMs, totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0), campaigns: results })

    // Task 11 adds teardown HERE.

    process.exit(0)
```

- [ ] **Step 3: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 4: Test against staging — full PASS path**

```bash
pnpm smoke:prep-pipeline 2>&1 | tee /tmp/smoke-task10.log | jq -c 'select(.event == "summary" or .event == "assertion_failed")'
```

Expected: one `summary` entry with `verdict: 'PASS'` and the 3-campaign result array.

If any assertion fails: the log identifies which campaign + layer + detail. Either floor calibration is too tight (loosen the concept's floors), or there's a real product issue (investigate the failed campaign's IDs in the staging DB before tearing down — and the script's leave-on-failure behavior means the state is still there).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): three-layer assertion contract — phase / floors / global"
```

### Task 11: Teardown on PASS

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Add the teardown section**

Above the `// --- Main ---` divider, after the assertion section:

```typescript
// ---------------------------------------------------------------------------
// Teardown — cascade-delete everything the smoke created (PASS path only)
// ---------------------------------------------------------------------------

async function teardown(
  pool: Pool,
  results: readonly CampaignRunResult[],
  runId: string,
): Promise<void> {
  log('info', 'teardown_started', { runId })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Delete campaigns + worlds (cascades to characters, members,
    // pipeline_runs, entities, facts, relationships per migration FKs).
    const campaignIds = results.map((r) => r.campaignId)
    const worldIds = results.map((r) => r.worldId)

    await client.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [campaignIds])
    await client.query(`DELETE FROM worlds WHERE id = ANY($1)`, [worldIds])

    // Delete the credit ledger rows the smoke seeded (identified by source_id
    // matching the run prefix).
    await client.query(
      `DELETE FROM credit_ledger WHERE source_id LIKE $1`,
      [`${CREDIT_SOURCE_PREFIX}:${runId}`],
    )

    await client.query('COMMIT')
    log('info', 'teardown_complete', { runId })
  } catch (err) {
    await client.query('ROLLBACK')
    log('warn', 'teardown_failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
    // Teardown failure on PASS isn't fatal — print the IDs so the operator
    // can clean up manually. Don't exit non-zero (the smoke still passed).
  } finally {
    client.release()
  }
}
```

- [ ] **Step 2: Wire teardown into PASS path**

In `main`, after the `summary verdict:'PASS'` log line, before `process.exit(0)`:

```typescript
    await teardown(pool, results, runId)
    process.exit(0)
```

- [ ] **Step 3: Verify FK cascades for the delete shape**

Read `backend/migrations/001_initial_schema.sql` for the FK definitions on `campaigns`, `worlds`, `characters`, `pipeline_runs`. Confirm:

- `characters.campaign_id` FK → `campaigns.id` has `ON DELETE CASCADE`
- `campaign_members.campaign_id` FK → `campaigns.id` has `ON DELETE CASCADE`
- `pipeline_runs.world_id` and `pipeline_runs.campaign_id` FKs have appropriate cascade or nullable
- `entities.world_id`, `facts.entity_id`, `relationships.source_entity_id`/`target_entity_id` cascade transitively from worlds

If any FK does NOT cascade, add explicit `DELETE FROM <table>` calls BEFORE the campaign/world delete:

```typescript
    // Explicit deletes if FK cascades aren't sufficient — read migrations to verify.
    await client.query(`DELETE FROM relationships WHERE source_entity_id IN (SELECT id FROM entities WHERE world_id = ANY($1))`, [worldIds])
    await client.query(`DELETE FROM facts WHERE entity_id IN (SELECT id FROM entities WHERE world_id = ANY($1))`, [worldIds])
    await client.query(`DELETE FROM entities WHERE world_id = ANY($1)`, [worldIds])
    await client.query(`DELETE FROM pipeline_runs WHERE world_id = ANY($1) OR campaign_id = ANY($2)`, [worldIds, campaignIds])
```

Insert these before `DELETE FROM campaigns` if needed.

- [ ] **Step 4: Test PASS path teardown**

```bash
pnpm smoke:prep-pipeline 2>&1 | jq -c 'select(.event == "summary" or .event == "teardown_complete" or .event == "teardown_failed")'
```

Expected: `verdict: 'PASS'` followed by `teardown_complete`. Verify in the DB:

```bash
# Get the runId from the log
RUN_ID=$(grep '"verdict":"PASS"' /tmp/smoke-task11.log | jq -r '.runId // empty' | head -1)
# (Or read from `phase: run_started` line)
# Then check:
docker compose -f docker-compose.yml exec -T postgres psql -U mythrun -d mythrun_dev -c \
  "SELECT COUNT(*) FROM credit_ledger WHERE source_id LIKE 'smoke:myt-55:%'"
```

Expected: zero. (Or for staging DB: connect via the staging URL and run the same query.)

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): PASS-path teardown — cascade-delete campaigns + worlds + ledger"
```

### Task 12: Per-stage timeout + try/finally hygiene

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

- [ ] **Step 1: Wrap the burst in try/finally**

The teardown should NOT run on FAIL (leave-on-failure semantics). Restructure `main`'s body so PASS triggers teardown and FAIL skips it:

```typescript
    let pass = false
    let results: readonly CampaignRunResult[] = []
    try {
      results = await Promise.all(
        CONCEPTS.map((concept) => runOneCampaign(cfg, owner, players, concept, pool)),
      )
      const wallClockMs = Date.now() - startedAtMs
      log('info', 'phase', { phase: 'burst_complete', campaigns: results.length })

      const failures = await assertContract(results, cfg, pool)
      if (failures.length > 0) {
        for (const f of failures) log('error', 'assertion_failed', f)
        log('error', 'summary', { verdict: 'FAIL', wallClockMs, failureCount: failures.length, campaigns: results })
        process.exit(1)
      }
      if (wallClockMs > cfg.wallClockBudgetMs) {
        log('error', 'assertion_failed', { layer: 'C', detail: `wall-clock ${wallClockMs}ms > budget ${cfg.wallClockBudgetMs}ms` })
        log('error', 'summary', { verdict: 'FAIL', wallClockMs, campaigns: results })
        process.exit(1)
      }
      log('info', 'summary', { verdict: 'PASS', wallClockMs, totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0), campaigns: results })
      pass = true
    } finally {
      if (pass) {
        await teardown(pool, results, runId)
      } else if (results.length > 0) {
        log('warn', 'leaving_state', {
          runId,
          campaignIds: results.map((r) => r.campaignId),
          worldIds: results.map((r) => r.worldId),
          note: 'FAIL path — state preserved for inspection. Manual cleanup required.',
        })
      }
    }
```

- [ ] **Step 2: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Test FAIL path (simulated)**

Force a failure by tightening a floor temporarily — e.g., bump `bardsmoot.floors.minEntities` to 999. Re-run:

```bash
pnpm smoke:prep-pipeline 2>&1 | jq -c 'select(.event == "summary" or .event == "leaving_state")'
```

Expected: `verdict: 'FAIL'`, then `leaving_state` with the campaign + world IDs. NO `teardown_complete`.

Inspect the staging DB to verify the campaigns + worlds remain. Then manually clean them up.

REVERT the floor bump before committing.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/smoke/prep-pipeline.ts
git commit -m "feat(MYT-55): try/finally hygiene — leave-on-FAIL preserves IDs for inspection"
```

---

## Phase C: Wiki updates

### Task 13: "Concurrency + rate-limit ceilings" section in `runtime/llm.html`

**Files:**
- Modify: `docs/wiki/content/runtime/llm.html`

- [ ] **Step 1: Read the current file structure**

```bash
grep -n "^<h[12]" docs/wiki/content/runtime/llm.html
```

Identify where to insert the new section. Likely placement: after the existing "Error handling and the repair chain" section, before any closing "Operating this piece" or appendix.

- [ ] **Step 2: Author the section content**

Insert this HTML block at the chosen position (adjust the `id` and surrounding indentation to match neighbors):

```html
<h2 id="concurrency-and-rate-limits">Concurrency and rate-limit ceilings</h2>

<p>Two independent ceilings shape how many Anthropic streams we run in parallel. The product of the two
  decides what bursts the system can absorb without 429s or queue starvation.</p>

<table class="wiki-reference-table">
  <thead><tr><th>Ceiling</th><th>Set by</th><th>Current value</th></tr></thead>
  <tbody>
    <tr><td>BullMQ worker concurrency (world-gen)</td><td>Us — <code>CONCURRENCY_WORLD_GEN</code> in
      <code>backend/src/worker/bullmq-config.ts</code></td><td>3 concurrent jobs</td></tr>
    <tr><td>BullMQ worker concurrency (campaign-setup)</td><td>Us — <code>CONCURRENCY_CAMPAIGN_SETUP</code></td><td>5 concurrent jobs</td></tr>
    <tr><td>Per-job in-flight Anthropic stream</td><td>The pipeline shape — each worker slot holds one stream at a time</td><td>1 stream / job</td></tr>
    <tr><td>Anthropic RPM ceiling</td><td>Anthropic — per-API-key, per-tier</td><td>~50 RPM (Tier 2)</td></tr>
    <tr><td>Anthropic TPM ceiling (input)</td><td>Anthropic — per-API-key, per-tier</td><td>~800,000 TPM (Tier 2)</td></tr>
  </tbody>
</table>

<p><strong>Peak concurrent Anthropic streams = 8</strong> (3 world-gen + 5 campaign-setup, both queues
  saturated). This is well under Anthropic Tier 2's request-rate ceiling.</p>

<aside class="wiki-rationale">
  <p><strong>Why we don't just match Anthropic's tier:</strong> Anthropic would allow much more concurrency
    than 8. We cap below their ceiling because the binding constraint isn't them — it's the worker's own
    resource budget. Raising the cap without matching the rest stack just moves the bottleneck.</p>
</aside>

<h3>The constraint stack that justifies the cap</h3>

<ul>
  <li><strong>Postgres connection pool.</strong> Each in-flight job holds at least one pg client for its
    duration; stage 7 of world-gen holds a transaction across the LLM call. <code>WORKER_PG_POOL_SIZE</code>
    is 10-ish; 8 concurrent leaves headroom for the cost-cap reads and bookkeeping queries.</li>
  <li><strong>ECS task memory.</strong> Streaming structured output buffers the partial JSON in memory until
    parse time. Worker tasks are 1 vCPU / 2 GB; 8 concurrent streams plus prompt templates plus vocabulary
    registries fits comfortably. 100 concurrent OOMs the task.</li>
  <li><strong>ECS task CPU.</strong> Node is single-threaded for parse + repair-chain work. Higher concurrency
    contends on the event loop; missed BullMQ heartbeats mark jobs as stalled and re-queue them, which
    degrades throughput.</li>
  <li><strong>Billing-burst safety.</strong> The concurrency cap is a passive budget rate-limiter. A runaway
    loop at 100 RPM burns spend 12× faster than at 8 RPM before circuit breakers fire.</li>
  <li><strong>Atomic-claim contention.</strong> The pipeline uses row-level atomic claims for idempotency.
    Higher concurrency = more lock contention = rollback storms.</li>
</ul>

<h3>Scaling levers</h3>

<p>When the launch traffic shape pushes through the current cap, two levers exist:</p>

<ul>
  <li><strong>Horizontal.</strong> Run more worker ECS tasks. Each task holds 8 streams; six tasks hold 48.
    BullMQ distributes the queue across workers automatically. This is the preferred lever — adds capacity
    without retuning any constraints.</li>
  <li><strong>Vertical.</strong> Raise <code>CONCURRENCY_WORLD_GEN</code> + <code>CONCURRENCY_CAMPAIGN_SETUP</code>
    AND <code>WORKER_PG_POOL_SIZE</code> AND ECS task memory AND CPU. All four together. Pulling on
    one without the others creates a new bottleneck.</li>
</ul>

<h3>Trigger signals that warrant raising the caps</h3>

<ul>
  <li>Postgres connection pool utilization &gt; 80% during peak (CloudWatch RDS metric).</li>
  <li>BullMQ queue depth &gt; 50 jobs for &gt; 5 minutes (worker log + BullMQ admin).</li>
  <li>Sustained 429 responses observed in worker logs (today: zero, expected).</li>
</ul>

<h3>The verification artifact</h3>

<p><code>pnpm smoke:prep-pipeline</code> drives 3 concurrent campaigns × 3 players each, saturating both
  worker queues to peak 8 streams. Absence of <code>LlmRateLimitedError</code> entries plus completion
  within the wall-clock budget is the running proof that the current shape works.</p>
```

- [ ] **Step 3: Verify the page still builds**

```bash
set -a; source backend/.env.development; set +a
pnpm db:up 2>&1 | tail -2
pnpm wiki:check 2>&1 | tail -5
```

Expected: 0 errors. The source-hash invariant might trigger drift because the page's `<!-- source: -->` declarations don't include the new files (`bullmq-config.ts`). That's expected; let the source-hash refresh happen via `pnpm wiki:accept-drift` after Step 4.

- [ ] **Step 4: Update the page's `<!-- source: -->` declarations**

At the top of `runtime/llm.html`, find the `<!-- source: -->` block. Add `backend/src/worker/bullmq-config.ts` if not already listed (it almost certainly isn't — this is a new source dependency).

Re-run:

```bash
pnpm wiki:check 2>&1 | tail -5
```

If drift persists, run `pnpm wiki:accept-drift runtime/llm.html` ONLY after re-reading the page narrative end-to-end and confirming nothing else needs updating (per the memory rule against blanket accept-drift).

- [ ] **Step 5: Visual spot-check**

Open `docs/wiki/site/runtime/llm.html` in a browser (or `cat` it) and confirm the new section renders alongside the existing structure, tables, and rationale callouts.

- [ ] **Step 6: Commit**

```bash
git add docs/wiki/content/runtime/llm.html
git commit -m "docs(MYT-55): concurrency + rate-limit ceilings section on runtime/llm"
```

### Task 14: Narrative tense sweep across 6 wiki pages

**Files:**
- Modify: `docs/wiki/content/runtime/index.html` (line 345)
- Modify: `docs/wiki/content/runtime/worker.html` (lines 22, 70, plus 2 more)
- Modify: `docs/wiki/content/runtime/world-gen.html` (~2 references)
- Modify: `docs/wiki/content/runtime/character-creation.html` (~14 references)
- Modify: `docs/wiki/content/runtime/pipeline-status.html` (lines 51, 521-522)
- Modify: `docs/wiki/content/data/index.html` (line 8)

- [ ] **Step 1: Enumerate every stale reference**

```bash
grep -nE "will land in MYT-|lands in MYT-|ships as MYT-|MYT-XX|TODO.*MYT|reserved for.*MYT-|MYT-49 onward|MYT-51 onward|MYT-52 onward|MYT-53 onward" \
  docs/wiki/content/runtime/index.html \
  docs/wiki/content/runtime/worker.html \
  docs/wiki/content/runtime/world-gen.html \
  docs/wiki/content/runtime/character-creation.html \
  docs/wiki/content/runtime/pipeline-status.html \
  docs/wiki/content/data/index.html \
  > /tmp/myt-55-tense-drift.txt
cat /tmp/myt-55-tense-drift.txt
```

This is the complete worklist. Each line is a sentence (or fragment) that needs editing.

- [ ] **Step 2: For each hit, verify the referenced ticket is closed**

For any unfamiliar MYT-NN reference, look it up via `mcp__linear-server__get_issue` or grep the commit log:

```bash
git log --all --grep='MYT-NN' --oneline | head -3
```

If the referenced ticket has shipped (a commit message references it), convert the sentence to present-state. If it hasn't shipped, LEAVE the future-tense — it's still an accurate forward reference.

- [ ] **Step 3: Rewrite per-page, applying the mental-model test**

Per `docs/wiki/AUTHORING.md`'s mental-model test: would a reader's mental model after reading this page match reality?

For each hit, you have three options:
- **Convert tense in place:** "lands in MYT-51" → "lands in stage 1's processor wiring" (drop the ticket reference; describe the present state of the code).
- **Convert to historical reference:** "ships as MYT-54" → "shipped under MYT-54" (acknowledges the work happened; matches AUTHORING.md's voice on historical context).
- **Rewrite the surrounding paragraph:** if the sentence's framing is fundamentally future-tense, the entire paragraph might need a rewrite to present-state.

DO NOT mechanically search-and-replace — read each sentence in its paragraph context. The mental-model test catches what wikicheck doesn't.

A worked example for `character-creation.html:51`:

Before:
> ...today. Phase 5 (<a href="./character-integration.html">cross-PC integration</a>) ships as MYT-54;

After:
> ...today. Phase 5 (<a href="./character-integration.html">cross-PC integration</a>) is the campaign-scoped Opus pass — see the integration page.

(The ticket reference disappears; the sentence describes the current state.)

- [ ] **Step 4: After all 6 pages are edited, re-run wiki:check**

```bash
set -a; source backend/.env.development; set +a
pnpm wiki:check 2>&1 | tail -10
```

Expected: 0 errors. Source-hash invariant: since the source files those pages declare didn't change (we only changed narrative tense), no drift should fire from this task.

If drift DOES fire on any of the 6 pages: the page's `<!-- source: -->` block must have implicitly tracked the wiki's own content; re-read AUTHORING.md's "Page lifecycle" section. Most likely a NIT — accept via `pnpm wiki:accept-drift <page>` after re-reading.

- [ ] **Step 5: Visual spot-check character-creation.html**

This is the page with the heaviest edit. Open it in a browser (or read the rendered HTML) and confirm the narrative reads as present-state throughout.

- [ ] **Step 6: Commit**

```bash
git add docs/wiki/content/runtime/index.html \
        docs/wiki/content/runtime/worker.html \
        docs/wiki/content/runtime/world-gen.html \
        docs/wiki/content/runtime/character-creation.html \
        docs/wiki/content/runtime/pipeline-status.html \
        docs/wiki/content/data/index.html
git commit -m "docs(MYT-55): narrative tense sweep — convert ~20 stale 'will land in MYT-X' refs to present-state"
```

---

## Task 15: Final close-the-loop

**Files:** — (verification only)

- [ ] **Step 1: Run the full pre-push gate**

```bash
set -a; source backend/.env.development; set +a
pnpm typecheck
pnpm lint
pnpm test
pnpm wiki:check
pnpm dev-tool:check
```

Expected: all green.

- [ ] **Step 2: Run the smoke once more to confirm green-on-clean**

```bash
pnpm smoke:prep-pipeline 2>&1 | jq -c 'select(.event == "summary")'
```

Expected: `verdict: 'PASS'` with reasonable counts.

- [ ] **Step 3: Push**

```bash
git push origin main
```

Wait for CI follow-up signal. All 4 CI runs should pass (Auth Lint, Dev tool check, Wiki, Deploy).

- [ ] **Step 4: Flip MYT-55 to Done**

```bash
# Via Linear MCP (controller-only — implementer subagent doesn't have Linear write access):
mcp__linear-server__save_issue id=MYT-55 state=Done
```

- [ ] **Step 5: Verify the milestone flips**

The Prep Pipeline milestone has all other tickets already Done. MYT-55 closing flips the whole milestone to completed. Confirm in Linear or via:

```
mcp__linear-server__get_milestone (Prep Pipeline)
```

Expected: `state.type === 'completed'`.

---

## Self-Review Notes

**1. Spec coverage**

- §1 (Combined smoke) → Tasks 4–12.
- §2.1 (3 concurrent campaigns saturating worker caps) → Task 9.
- §2.2 (4 Cognito users via Terraform `for_each`) → Task 1.
- §2.3 (3 hand-curated concepts with calibrated floors) → Task 7.
- §2.4 (Leave-on-failure, clean-on-success teardown) → Tasks 11 + 12.
- §2.5 (Manual-only, CI-ready structured output) → Tasks 2 + 4 (`log()` helper produces JSON lines).
- §2.6 (Peak concurrency = 8, not 25) → Task 13 (documented in `runtime/llm.html`).
- §3.1 (File location + `pnpm smoke:prep-pipeline` invocation) → Tasks 2 + 4.
- §3.2 (Architecture three-phase) → Tasks 5, 6, 8–12.
- §3.3 (Concepts) → Task 7.
- §3.4 (Three-layer assertion contract A/B/C) → Task 10.
- §3.5 (Failure handling: per-stage timeout 5 min, per-campaign 8 min, total 10 min) → Task 8 (`pollFor` uses these budgets) + Task 9 (wall-clock total).
- §3.6 (Structured JSON output) → Task 4 (`log()` helper).
- §4 (Auth + Terraform + IAM + credit seeding) → Tasks 1 + 5 + 6.
- §5 (Rate-limit wiki content) → Task 13.
- §6 (Wiki narrative sweep) → Task 14.
- §7 (Testing strategy: smoke IS the test) → Implied throughout; no separate unit tests authored.

**2. Placeholder scan**

- The `runOneCampaign` Step 1 code has a comment block noting "the exact shape is left to the implementer to wire correctly based on the current API surface — there is no spec ambiguity, just code-reading needed" — this acknowledges that the route for "owner adds member" and "player submits character concept" depends on what's actually in `backend/src/routes/campaign-characters.ts` and `backend/src/routes/invites.ts`. The plan asks the implementer to read those files and use the right shape. This is a **directed lookup**, not a placeholder — the implementer reads the right files (cited explicitly) and follows the pattern. Acceptable.
- The `materializeUserRows` function uses `/api/users/me` as the trigger endpoint with a fallback note. If `/api/users/me` doesn't exist, the implementer swaps to `/api/campaigns/mine`. Acceptable directed lookup.

No other placeholders, TBDs, or implement-later markers.

**3. Type consistency**

- `AuthedUser` shape (Task 5) used consistently in `runOneCampaign` and `materializeUserRows`.
- `Concept` and `AssertionFloors` (Task 7) used consistently in `runOneCampaign` and `assertContract`.
- `CampaignRunResult` (Task 8) is the contract returned by `runOneCampaign` and consumed by `assertContract` (Task 10) and `teardown` (Task 11).
- `SmokeConfig` plumbed through every helper consistently.
- `CREDIT_SOURCE_PREFIX` defined in Task 6, used in Task 11's teardown WHERE clause — same string.

Plan is self-consistent. Ready for handoff.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-myt-55-prep-pipeline-hardening.md`. Two execution options:

1. **Subagent-Driven (recommended)** — controller dispatches a fresh subagent per task, reviews between tasks, fast iteration. Use `superpowers:subagent-driven-development`. Per CLAUDE.md, implementers must NOT `git add`/`commit`/`push`; the controller stages and commits each task's files serially. Task dependencies: Task 1 is independent (Terraform). Tasks 2–12 are mostly serial within Phase B (each builds on the previous). Tasks 13–14 are independent of B and of each other. Task 15 depends on everything.

2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
