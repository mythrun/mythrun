# MYT-55 Prep Pipeline Hardening — Pivot Plan (2026-05-28)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Pivot trigger:** Audit blocker discovered during T6 implementation of the original plan — staging RDS is correctly private (`publicly_accessible = false`), so the developer-machine + Secrets Manager + direct-RDS shape couldn't reach the DB. See commit `4be0875` (spec pivot to in-VPC ECS task family) for full rationale.

**What this plan replaces:** Tasks T6–T15 of `docs/superpowers/plans/2026-05-28-myt-55-prep-pipeline-hardening.md`. T1–T5 of that plan are DONE (commits `24994ba`, `02dba15`, `2407593`, `53c6ed8`, `9418704`); their work is preserved.

**Architecture:** Smoke becomes an ECS Fargate task family `mythrun-staging-smoke-prep-pipeline`, mirroring the existing `mythrun-staging-bootstrap-db` pattern. Container command runs `tsx scripts/smoke/prep-pipeline.ts` inside the staging VPC; DATABASE_URL injected via task definition env; reads + writes the DB via existing repo modules (entities, relationships, facts, campaigns, etc.) directly. Pre-seed credits via a new `--seed-smoke-credits` extension to the bootstrap-db task family — idempotent, 1M-credit grant per user, effectively-forever supply.

**Tech Stack:** Terraform (existing hashicorp/aws modules), TypeScript via tsx (running inside the Fargate task), `pg` Pool via injected `DATABASE_URL`, existing repo modules (`backend/src/repo/*`).

**Linear issue:** MYT-55. Updated spec: `docs/superpowers/specs/2026-05-28-myt-55-prep-pipeline-hardening-design.md` (commit `4be0875`).

---

## What's already done (from the original plan)

- **T1** — Cognito 4-user Terraform applied (`24994ba`). 4 users + 4 Secrets Manager secrets live in staging.
- **T2** — `pnpm smoke:prep-pipeline` script entry wired (`02dba15`).
- **T3** — `backend/.env.smoke.example` authored (`2407593`).
- **T4** — `backend/scripts/smoke/prep-pipeline.ts` skeleton (`53c6ed8`).
- **T5** — Cognito auth helper, 4 parallel JWT exchanges proven against staging (`9418704`).

The skeleton + auth helper still work. The pivot affects everything from T6 onward.

---

## New File Structure (pivot delta)

### Infrastructure (new)
- **Modify:** `infra/environments/staging/main.tf` — add `aws_ecs_task_definition.smoke_prep_pipeline`, task role IAM, CloudWatch log group, and Terraform outputs for the pre-canned `aws ecs run-task` command.
- **Modify:** the bootstrap-db task family Terraform (search for `bootstrap_db_run_task_default` in `main.tf`) — add a `--seed-smoke-credits` invocation flag + corresponding Terraform output.
- **Modify:** `backend/scripts/bootstrap-db.sh` (or wherever the bootstrap-db container's entrypoint lives) — implement the `--seed-smoke-credits` SQL.

### Smoke script (modified)
- **Modify:** `backend/scripts/smoke/prep-pipeline.ts` — drop the Secrets Manager DB fetch path; read `DATABASE_URL` from env (injected by the ECS task); use existing repo modules directly for stats + teardown; add hostname sanity-check before destructive queries.

### Wiki (unchanged from original plan)
- Same 6 pages for tense sweep + new section in `runtime/llm.html`.

---

## Phase B′: ECS task family (NEW — replaces original T6)

### Task 6′: Bootstrap-db task family extension — `--seed-smoke-credits` flag

**Files:**
- Modify: the bootstrap script (likely `backend/scripts/bootstrap-db.sh` or `backend/scripts/bootstrap.ts`; verify by reading the bootstrap-db task definition in `infra/environments/staging/main.tf`)
- Modify: `infra/environments/staging/main.tf` — add a `bootstrap_db_run_task_seed_smoke_credits` Terraform output

- [ ] **Step 1: Locate the bootstrap-db task family + script**

Read `infra/environments/staging/main.tf`. Find the `bootstrap_db_run_task_default` output. The output references the task family `mythrun-staging-bootstrap-db` and its container command list (`["--env","staging"]`). Find the underlying task definition. Note the container's image + the entrypoint script.

`grep -rn 'bootstrap-db\|bootstrap_db\|bootstrap.sh' infra/ backend/scripts/`

- [ ] **Step 2: Add the `--seed-smoke-credits` mode**

Per the bootstrap script's existing pattern (the existing modes `--verify`, `--reset-password`, `--secret-only`, `--user-only` per spec §3.1), add a new `--seed-smoke-credits` mode. Implementation:

```bash
# inside bootstrap-db.sh — adapt to the existing script's idiom
if [[ "$MODE" == "--seed-smoke-credits" ]]; then
  # Looks up the 4 smoke users by username pattern. They must already
  # have logged in once (so the JWT plugin created their users row).
  # If they haven't, exit 2 with a clear message — operator must run
  # the smoke once first to materialize the rows.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
WITH smoke_users AS (
  SELECT id FROM users
   WHERE cognito_sub IN (
     SELECT cognito_sub FROM users
     WHERE EXISTS (
       SELECT 1 FROM users sub
       WHERE sub.cognito_sub = users.cognito_sub
         AND sub.cognito_sub LIKE 'b4b894c8-%'  -- replace with the real 4 subs
     )
   )
)
INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
SELECT uuidv7(), su.id, ct.kind, 1000000, 'admin',
       md5(su.id::text || ':' || ct.kind)::uuid
  FROM smoke_users su,
       (VALUES ('world_gen'), ('session')) AS ct(kind)
ON CONFLICT DO NOTHING;
SQL
  echo "Smoke credits seeded (1M each of world_gen + session per smoke user, idempotent)"
  exit 0
fi
```

NOTE: the exact lookup-by-cognito-sub shape depends on how the smoke users authenticate. Inspect `infra/modules/auth/smoke-test.tf` for the 4 emails (e.g. `mythrun-staging-smoke-owner@example.com`); the cognito_sub is set by Cognito at user creation and can be looked up via:

```sql
SELECT id, cognito_sub, username FROM users
 WHERE username = 'mythrun-staging-smoke-owner' -- or by display_name, depending on registration shape
```

Verify the right column to match on by reading `backend/src/routes/users.ts` register route.

- [ ] **Step 3: Add the Terraform output**

In `infra/environments/staging/main.tf`, find `bootstrap_db_run_task_default`. Add a sibling output:

```hcl
output "bootstrap_db_run_task_seed_smoke_credits" {
  description = "aws ecs run-task command to seed credit grants for the four smoke-test users (idempotent). Run once after smoke users have logged in at least once."
  value = "aws ecs run-task --cluster mythrun --task-definition mythrun-staging-bootstrap-db --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[<copy from existing default>],securityGroups=[<copy from existing default>],assignPublicIp=DISABLED}' --overrides '{\"containerOverrides\":[{\"command\":[\"--env\",\"staging\",\"--seed-smoke-credits\"],\"name\":\"bootstrap\"}]}'"
}
```

(Copy the subnets + security group ARNs from one of the existing `bootstrap_db_run_task_*` outputs — they're already in main.tf.)

- [ ] **Step 4: Apply Terraform — output-only change**

```bash
cd infra/environments/staging
terraform plan -out=/tmp/myt-55-pivot-t6.tfplan
```

Expected: 0 changes (output additions don't count as plan changes). If 0 changes, skip apply.

- [ ] **Step 5: HARD STOP**

Don't run the pre-seed task yet. The smoke users haven't logged in to staging yet (their `users` row doesn't exist). The pre-seed depends on the rows existing. Task 8′ runs the smoke (which triggers first-login → row creation), then Task 6′-Step-6 runs the pre-seed.

Report DONE with the Terraform output preview.

### Task 7′: ECS task definition for the smoke

**Files:**
- Modify: `infra/environments/staging/main.tf`
- Possibly modify: an existing IAM policy doc for the task role

- [ ] **Step 1: Plan the task family resources**

In `infra/environments/staging/main.tf`, the smoke task family needs these resources (mirror the bootstrap-db pattern; grep for `bootstrap_db_task_definition` to see the shape):

- `aws_ecs_task_definition.smoke_prep_pipeline` — family `mythrun-staging-smoke-prep-pipeline`
- `aws_iam_role.smoke_prep_pipeline_task_role` (or extend an existing role)
- `aws_iam_role_policy.smoke_prep_pipeline_task_role_policy` — grants `secretsmanager:GetSecretValue` on the 4 smoke-user secret ARNs only
- `aws_cloudwatch_log_group.smoke_prep_pipeline` — `/ecs/mythrun-staging-smoke-prep-pipeline` with 14-day retention

- [ ] **Step 2: Author the task definition**

```hcl
resource "aws_cloudwatch_log_group" "smoke_prep_pipeline" {
  name              = "/ecs/mythrun-staging-smoke-prep-pipeline"
  retention_in_days = 14
}

resource "aws_iam_role" "smoke_prep_pipeline_task_role" {
  name = "mythrun-staging-smoke-prep-pipeline-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "smoke_prep_pipeline_task_role_policy" {
  role = aws_iam_role.smoke_prep_pipeline_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        module.auth.smoke_test_credentials_secret_arns.owner,
        module.auth.smoke_test_credentials_secret_arns.player_1,
        module.auth.smoke_test_credentials_secret_arns.player_2,
        module.auth.smoke_test_credentials_secret_arns.player_3,
      ]
    }]
  })
}

resource "aws_ecs_task_definition" "smoke_prep_pipeline" {
  family             = "mythrun-staging-smoke-prep-pipeline"
  network_mode       = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                = "1024"  # 1 vCPU
  memory             = "2048"  # 2 GB
  execution_role_arn = <existing task execution role ARN from bootstrap-db>
  task_role_arn      = aws_iam_role.smoke_prep_pipeline_task_role.arn

  container_definitions = jsonencode([{
    name      = "smoke"
    image     = "<same image used by bootstrap-db task>"
    essential = true
    command   = ["tsx", "scripts/smoke/prep-pipeline.ts"]
    workingDirectory = "/app/backend"
    environment = [
      { name = "AWS_REGION",                     value = data.aws_region.current.region },
      { name = "API_BASE",                       value = "https://staging-api.mythrun.com" },
      { name = "COGNITO_USER_POOL_ID",           value = module.auth.user_pool_id },
      { name = "COGNITO_CLIENT_ID",              value = module.auth.client_id },
      { name = "SMOKE_OWNER_SECRET_ID",          value = "mythrun/staging/smoke-test-owner-credentials" },
      { name = "SMOKE_PLAYER_1_SECRET_ID",       value = "mythrun/staging/smoke-test-player_1-credentials" },
      { name = "SMOKE_PLAYER_2_SECRET_ID",       value = "mythrun/staging/smoke-test-player_2-credentials" },
      { name = "SMOKE_PLAYER_3_SECRET_ID",       value = "mythrun/staging/smoke-test-player_3-credentials" },
      { name = "SMOKE_WALL_CLOCK_BUDGET_MS",     value = "600000" },
      { name = "SMOKE_COST_CAP_USD",             value = "5.00" },
    ]
    secrets = [
      # DATABASE_URL is constructed at run time inside the container from
      # the RDS endpoint + the rds-password secret. Mirror the
      # bootstrap-db task's approach exactly.
      { name = "DATABASE_URL", valueFrom = "<bootstrap-db's DATABASE_URL secret ARN>" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.smoke_prep_pipeline.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

output "smoke_prep_pipeline_run_task_command" {
  description = "aws ecs run-task command to invoke the prep-pipeline smoke against staging. Pre-canned; copy-paste."
  value = "aws ecs run-task --cluster mythrun --task-definition mythrun-staging-smoke-prep-pipeline --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[<copy from bootstrap-db>],securityGroups=[<copy from bootstrap-db>],assignPublicIp=DISABLED}'"
}
```

NOTE: Many references above (`<bootstrap-db's DATABASE_URL secret ARN>`, subnet/SG ARNs, the bootstrap image reference) require reading the existing main.tf. The implementer:
1. Greps for `bootstrap_db_task_definition` in main.tf, reads the resource block.
2. Copies the `secrets`, `image`, `executionRoleArn`, network refs verbatim.
3. Plugs them into the new resources above.

The IAM module references (`module.auth.smoke_test_credentials_secret_arns`) ASSUME T1's `outputs.tf` exposes the map of secret ARNs. If T1 didn't (per the T1 review: "outputs.tf does not reference smoke_test_credentials"), add it now as a one-line fix to `infra/modules/auth/outputs.tf`:

```hcl
output "smoke_test_credentials_secret_arns" {
  value = var.smoke_test_user_enabled ? {
    for k, v in aws_secretsmanager_secret.smoke_test_credentials : k => v.arn
  } : {}
}
```

- [ ] **Step 3: `terraform plan` + STOP**

```bash
cd infra/environments/staging
terraform plan -out=/tmp/myt-55-pivot-t7.tfplan
```

Expected: ~3-4 resource creations (task def, IAM role, role policy, log group) + 1 output addition + possibly 1 outputs.tf change if added. NO destructive changes to existing resources.

Report DONE with plan output. Controller authorizes apply.

### Task 8′: Rewrite `prep-pipeline.ts` for in-VPC operation

**Files:**
- Modify: `backend/scripts/smoke/prep-pipeline.ts`

This task lands the smoke logic that the original T6-T12 was building. With in-VPC operation, the script is meaningfully simpler — no Secrets Manager DB fetch, no credit seeding (pre-seeded), uses repo modules for stats + teardown.

- [ ] **Step 1: Remove the `requireEnv` checks for SMOKE_* secret IDs**

Actually — keep them. They're still used (the script auths via Cognito → reads Cognito creds from Secrets Manager). Only `STAGING_DB_URL_SECRET_ID` is no longer used; replace with reading `DATABASE_URL` directly from env. Remove `STAGING_DB_URL_SECRET_ID` from the required env list.

- [ ] **Step 2: Add `DATABASE_URL` env reading + hostname sanity-check**

```typescript
function loadDbUrl(): string {
  const url = requireEnv('DATABASE_URL')
  // Belt-and-suspenders: refuse to proceed if the hostname doesn't contain
  // the expected env name. Catches an accidentally-pointed-at-prod task
  // definition (which is itself prevented by Terraform module scoping,
  // but defense-in-depth costs nothing).
  const hostname = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://')).hostname
  if (!hostname.includes('staging')) {
    log('error', 'db_hostname_sanity_failed', { hostname })
    throw new Error(`DATABASE_URL hostname '${hostname}' does not contain 'staging' — refusing to proceed`)
  }
  return url
}
```

- [ ] **Step 3: Add the concepts library (per original plan T7)**

Add the `CONCEPTS` array from the original T7 spec (3 concepts: bardsmoot, haunted-carnival, mountain-monastery) verbatim.

- [ ] **Step 4: Add `runOneCampaign` driver (per original plan T8)**

Same logic as original T8 — owner creates campaign, polls for world.status='complete', adds 3 players, each submits character concept, polls for campaign.status='active'.

KEY CHANGE: `readCampaignStats` uses repo modules instead of raw SQL.

```typescript
import { entities } from '../../src/repo/entities.js'
import { facts } from '../../src/repo/facts.js'
import { relationships } from '../../src/repo/relationships.js'

async function readCampaignStats(pool: Pool, worldId: string, campaignId: string): Promise<CampaignStats> {
  const client = await pool.connect()
  try {
    const ents = await entities.listByWorld(client, worldId)
    const rels = await relationships.listByWorld(client, worldId)
    const facts_ = await facts.listByEntities(client, ents.map(e => e.id))
    const charRes = await client.query<{ id: string }>(
      `SELECT id FROM characters WHERE campaign_id = $1`, [campaignId])
    const costRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM pipeline_runs
        WHERE world_id = $1 OR campaign_id = $2`, [worldId, campaignId])
    return {
      costUsd: Number(costRes.rows[0]?.total ?? 0),
      entityCount: ents.length,
      relationshipCount: rels.length,
      factCount: facts_.length,
      characterIds: charRes.rows.map(r => r.id),
    }
  } finally {
    client.release()
  }
}
```

- [ ] **Step 5: Add the concurrent burst + assertion contract + teardown (per original plan T9–T12)**

These tasks are unchanged in spirit. Use repo modules for the teardown:

```typescript
import { campaigns } from '../../src/repo/campaigns.js'  // if exists
// ... or use raw SQL DELETE with the FK cascade per migration 001
```

If a `campaigns.deleteById` doesn't exist, raw SQL is fine — just be explicit about WHERE clauses.

- [ ] **Step 6: Wire `main` end-to-end**

```typescript
async function main(): Promise<void> {
  const cfg = loadConfig()
  const dbUrl = loadDbUrl()  // includes hostname sanity-check
  const startedAtMs = Date.now()
  log('info', 'phase', { phase: 'started', wallClockBudgetMs: cfg.wallClockBudgetMs, startedAtMs })

  const { owner, players } = await authAll(cfg)
  log('info', 'phase', { phase: 'authed', userCount: 1 + players.length })

  // Materialize user rows by hitting a cheap authed endpoint (JWT plugin
  // inserts on first request). This MUST run before the pre-seed task.
  await materializeUserRows(cfg, [owner, ...players])
  log('info', 'phase', { phase: 'users_materialized' })

  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  let pass = false
  let results: readonly CampaignRunResult[] = []

  try {
    results = await Promise.all(
      CONCEPTS.map((concept) => runOneCampaign(cfg, owner, players, concept, pool)),
    )
    const wallClockMs = Date.now() - startedAtMs
    log('info', 'phase', { phase: 'burst_complete', campaigns: results.length, wallClockMs })

    const failures = await assertContract(results, cfg, pool)
    if (failures.length > 0) {
      for (const f of failures) log('error', 'assertion_failed', f)
      log('error', 'summary', { verdict: 'FAIL', wallClockMs, failureCount: failures.length, campaigns: results })
      process.exit(1)
    }
    if (wallClockMs > cfg.wallClockBudgetMs) {
      log('error', 'assertion_failed', { layer: 'C', detail: `wall-clock ${wallClockMs}ms > budget ${cfg.wallClockBudgetMs}ms` })
      process.exit(1)
    }
    log('info', 'summary', {
      verdict: 'PASS', wallClockMs,
      totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
      campaigns: results,
    })
    pass = true
  } finally {
    if (pass) {
      await teardown(pool, results)
    } else if (results.length > 0) {
      log('warn', 'leaving_state', {
        campaignIds: results.map((r) => r.campaignId),
        worldIds: results.map((r) => r.worldId),
        note: 'FAIL path — state preserved for inspection. Manual cleanup required.',
      })
    }
    await pool.end()
  }
}
```

`materializeUserRows` keeps the original T6 implementation (hit `/api/users/me` or similar to trigger the JWT plugin's first-login INSERT).

- [ ] **Step 7: Typecheck + lint + commit-ready local skeleton**

```bash
pnpm typecheck
cd backend && pnpm exec eslint scripts/smoke/prep-pipeline.ts
```

Both should be clean. Don't run the smoke locally — it needs DATABASE_URL pointing at a reachable staging DB, which only the in-VPC task has.

### Task 9′: Apply ECS task family + run first smoke

**Files:** — (Terraform apply + ECS task invocation, no file edits)

- [ ] **Step 1: Apply T7′'s Terraform plan**

```bash
cd infra/environments/staging
terraform apply /tmp/myt-55-pivot-t7.tfplan
```

Expected: task definition, IAM role + policy, log group created. Output `smoke_prep_pipeline_run_task_command` now printed.

- [ ] **Step 2: Build + push the backend image with T8′'s smoke script**

The image must contain the latest smoke script. Either:
- (a) Trigger the existing Deploy GitHub Actions workflow on main to build + push (preferred — matches normal flow)
- (b) Manually build + push to ECR (faster but bypasses CI)

Wait for the image to land in ECR before running the smoke task.

- [ ] **Step 3: Run the smoke (first time — exercises first-login + materializes user rows)**

```bash
$(terraform output -raw smoke_prep_pipeline_run_task_command)
```

Capture the task ARN from the output. Then:

```bash
aws logs tail /ecs/mythrun-staging-smoke-prep-pipeline --follow
```

Expected on this FIRST run: the smoke will FAIL at credit deduction (campaigns need credits; not seeded yet). The failure mode looks like a 402/422 from POST /api/campaigns. The smoke's `leaving_state` log line will fire.

This is EXPECTED. The user rows ARE now created — Task 6′'s pre-seed can now find them.

- [ ] **Step 4: Run the credit pre-seed task**

```bash
$(terraform output -raw bootstrap_db_run_task_seed_smoke_credits)
```

Expected: task runs, inserts 8 ledger rows (4 users × 2 credit types each), exits 0. Logs visible in `/ecs/mythrun-staging-bootstrap-db`.

Verify in the DB (via a fresh bootstrap-db `--verify` task or by running a `SELECT` query through the existing dev-tool's panel if it points at staging — otherwise read the bootstrap task logs):

```sql
SELECT credit_type, SUM(amount) FROM credit_ledger
 WHERE user_id IN (
   SELECT id FROM users WHERE cognito_sub IN (
     <the 4 smoke users' subs>
   )
 ) AND source_type = 'admin'
 GROUP BY credit_type;
```

Expected: 4,000,000 each of world_gen + session (4 users × 1,000,000).

- [ ] **Step 5: Re-run the smoke — should PASS now**

```bash
$(terraform output -raw smoke_prep_pipeline_run_task_command)
aws logs tail /ecs/mythrun-staging-smoke-prep-pipeline --follow
```

Expected: full PASS — 3 campaigns complete, all 3 worlds reach `complete`, all 3 campaigns reach `active`, summary line shows `verdict: 'PASS'` with reasonable counts, teardown removes the 3 campaigns + worlds.

If the smoke fails at any specific assertion: the logs identify which campaign + layer + detail. Either floor calibration is too tight (loosen the concept's floors in T8′'s commit, push a new image, re-run) or there's a real product issue (investigate via the surviving campaign IDs).

- [ ] **Step 6: HARD STOP — Report DONE**

Report back the task ARN of the successful smoke + the summary line. Controller commits any T8′ floor-calibration tweaks discovered during the smoke runs.

---

## Phase C: Wiki updates (UNCHANGED from original plan)

### Task 10′ (orig T13): Concurrency + rate-limit ceilings section in `runtime/llm.html`

Identical to the original plan's Task 13. The pivot doesn't change this work.

### Task 11′ (orig T14): Narrative tense sweep across 6 wiki pages

Identical to the original plan's Task 14.

---

## Task 12′: Final close-the-loop

- [ ] **Step 1: Run pre-push gate**

```bash
set -a; source backend/.env.development; set +a
pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check
```

- [ ] **Step 2: One more clean smoke run via aws ecs run-task**

Same command as Task 9′ Step 5.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Flip MYT-55 to Done**

```
mcp__linear-server__save_issue id=MYT-55 state=Done
```

Verify Prep Pipeline milestone flips to completed.

---

## Self-Review Notes

**Spec coverage (pivot edition):**
- §2.5 (in-VPC ECS task family) → Task 7′ (Terraform), Task 9′ (apply + run).
- §2.6 (credit pre-seed via bootstrap-db extension) → Task 6′ (bootstrap script flag), Task 9′ Step 4 (run pre-seed).
- §3.1 (file location + ECS-task invocation) → Tasks 7′, 8′, 9′.
- §3.2 (architecture diagram) → Task 8′ Step 6 (main wiring).
- §3.4 (three-layer assertion contract) → Task 8′ Step 5.
- §4.2 (ECS task definition + role + log group) → Task 7′.
- §4.3 (local invocation surface preserved) → No additional task; `pnpm smoke:prep-pipeline` script entry from original T2 stays.
- §4.4 (credit pre-seed) → Task 6′.
- §5 (rate-limit wiki) → Task 10′.
- §6 (wiki tense sweep) → Task 11′.
- §7 (testing) → Implicit (smoke IS the test).
- §8 (non-goals: EventBridge cron + GH Actions gate) → No tasks; deliberate non-goals.

**Placeholders:** A few `<...>` markers in Step 2 of Task 7′ where the implementer reads existing main.tf to copy subnets/SG/image references. These are directed lookups (file + grep pattern cited), not unspecified content.

**Type consistency:** New tasks use the same `SmokeConfig`, `AuthedUser`, `Concept`, `CampaignRunResult`, `AssertionFailure` shapes from T4–T5 and the original plan's later tasks. The pivot removes `connectStagingDb` + `jwtSub`'s consumers but the type shapes stay coherent.

---

## Bead state (pivot)

Original beads `myth-o3qr.6` through `myth-o3qr.15` need to close as **superseded** by the pivot. New beads file under the same parent for the pivot tasks (Task 6′–12′).

The controller handles the bead close + new-bead-file in the orchestration layer; this plan doesn't enumerate beads (the original plan's `bd create` flow is the model — same parent `myth-o3qr`).
