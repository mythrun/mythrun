# MYT-55 Prep Pipeline Hardening — Design

> **Status:** draft, pre-implementation. Pending user sign-off.
> **Linear:** MYT-55 — "Prep pipeline pre-launch hardening + end-to-end staging smoke + wiki" (10 days overdue, final issue of the Prep Pipeline milestone).
> **Audit committed:** 2026-05-28; substantial off-Linear work (coherence vocabulary, dev-tool reorg, dev-tool-verifier, fact-event rendering) covered original scope items 3 and 5; this spec covers what actually remains.

## 1. Problem

The Prep Pipeline milestone needs a verification gate before launch. We have the code; we don't have a repeatable real-LLM proof that a fresh, deployed staging environment can take a multi-campaign creation burst end-to-end without anything silently degrading.

Three residual surfaces (post-audit, per the revised Linear description):

1. **No end-to-end staging smoke.** Existing smokes are either narrow (`backend/scripts/smoke/staging.sh` only exercises `check-username`) or local (`scripts/smoke/{phantom-reconciliation,entity-consolidation-flow}.ts` skip stages and run in-process). Nothing drives the full prep flow against the deployed staging API.

2. **Concurrency + rate-limit story is undocumented.** The code has 429 mapping and worker concurrency caps (`CONCURRENCY_WORLD_GEN=3`, `CONCURRENCY_CAMPAIGN_SETUP=5`), but nothing in the wiki explains why we cap there, what Anthropic-side ceilings we sit under, or what would trigger raising the caps.

3. **Wiki narrative drift.** `pnpm wiki:check` is green (source-hash invariant), but ~20 stale "will land in MYT-X" references survive across 6 pages where the referenced ticket has already shipped. Reading the wiki today gives a misleading mental model of what's deferred vs current.

## 2. Architectural decisions

### 2.1 Combined smoke (staging e2e + burst rate-limit verification)

A single smoke script exercises both. Driving 3 concurrent campaigns saturates the worker concurrency caps (peak 8 in-flight Anthropic streams: 3 world-gen + 5 campaign-setup). Absence of 429 errors during the run IS the rate-limit verification; we don't need a separate load test.

This is cheaper than building two artifacts and the assertion is grounded — if our self-caps + Anthropic Tier 2 limits don't survive a 3-campaign burst, we'd know before launch.

### 2.2 4 dedicated Cognito users provisioned via Terraform

Extend the existing single-user smoke-test Terraform module to 4 users: 1 owner + 3 players. The script auths each via Cognito's USER_AUTH flow (same as `staging.sh`) and holds 4 access tokens for the run. Each player joins all 3 campaigns; the owner creates all 3.

**Not chosen:** smoke-script-bootstraps-users (burns Cognito sign-up quota, needs admin-delete IAM, complex teardown), reuse-one-user-serialize (defeats burst-mode test).

### 2.3 3 hand-curated fixed concepts

Three brand-aligned concepts committed at the top of the smoke script. Each has calibrated per-concept assertion floors (minEntities, minRelationships, minFactsPerEntity). Predictable verification; concepts can be authored well once.

**Not chosen:** 1-concept-replicated (most deterministic but artificial), random-library (looser floors, more upfront curation).

### 2.4 Leave-on-failure, clean-on-success teardown

PASS deletes all 3 campaigns + worlds + ledger entries created by the run; FAIL leaves everything for forensic inspection and prints the IDs. Try/finally wrapper. Staging DB stays clean across successful runs; failures leave breadcrumbs.

**Not chosen:** always-clean (no post-mortem inspection), always-leave (DB accumulates cruft).

### 2.5 Run inside the VPC via ECS Fargate task family

Staging RDS is `publicly_accessible = false` (correctly). The smoke runs inside the staging VPC as a Fargate task family — mirroring the existing `mythrun-staging-bootstrap-db` pattern. This is the same primitive that future cron + post-deploy-gate use; building it as a task family first means those future surfaces are 15-line Terraform additions, not rewrites.

Task family `mythrun-staging-smoke-prep-pipeline`:
- Uses the existing backend Docker image (no separate build).
- Container command: `tsx scripts/smoke/prep-pipeline.ts`.
- Task role IAM scoped to read the 4 smoke-user Cognito secrets + RDS connection (via security group + read of `rds-password`).
- Logs to CloudWatch at `/ecs/mythrun-staging-smoke-prep-pipeline`.
- `DATABASE_URL` injected via task definition env (no Secrets Manager fetch from inside the script for the DB URL).
- Terraform output prints the pre-canned `aws ecs run-task --cluster mythrun --task-definition ... --launch-type FARGATE --network-configuration ...` command, exactly the pattern the bootstrap-db task family uses (`bootstrap_db_run_task_default` output).

**Not chosen:** external developer-machine script + public-RDS (security regression; rejected — production posture stays). Smoke-as-Lambda (15-min cap, cold-start, wrong shape for 5–10 min workload). New API admin-grant endpoint (adds attack surface for a one-shot setup problem).

Invocation surfaces this task family unlocks (out of scope for THIS ticket but free with the family):
- **Manual today:** `aws ecs run-task ...` + `aws logs tail`.
- **Future cron:** `aws_scheduler_schedule` EventBridge resource (~15 lines) pointing at the same task family.
- **Future deploy gate:** GitHub Actions step calls `aws ecs run-task ...` post-deploy and polls task status.

### 2.6 Credit pre-seed via one-shot ECS task (bootstrap-db extension)

The smoke users need `world_gen` credits to create campaigns (1 credit per campaign creation per `backend/src/routes/campaigns.ts`). Trial registration grants only 1 `session` credit per user.

The smoke does NOT seed credits at runtime. A separate **one-shot ECS task** — extension of the existing `mythrun-staging-bootstrap-db` family with a new `--seed-smoke-credits` command flag — pre-seeds 1,000,000 `world_gen` + 1,000,000 `session` credits per smoke user (source_type='admin', source_id=a deterministic UUID per smoke-user-and-type for idempotency). Operator runs it once after Cognito users land; smoke runs draw from the pool. At 1 credit per campaign, the seed survives ~333,000 smoke runs — effectively forever.

**Not chosen:** runtime credit seeding (recursive blocker — would need DB access from outside VPC), admin-grant API endpoint (new attack surface for a setup problem), high-frequency re-seed cron (overengineering for a slow-consume workload).

### 2.7 Peak concurrency is 8, not 25

The original MYT-55 spec text claimed "~25 in-flight Anthropic streams during a multi-campaign creation burst" without grounding. Walking through the actual code:

- World-gen queue: 3 concurrent worker slots max
- Campaign-setup queue: 5 concurrent worker slots max
- Each worker slot holds at most one active Anthropic stream at a time
- Peak total: **8 concurrent streams**, both queues saturated

The 25 number was either aspirational pre-implementation math, double-counted fan-outs that don't exist, or simply wrong. The smoke design doesn't change — 3 concurrent campaigns still saturates both queues — but the documented headroom calculation uses 8.

## 3. Smoke script

### 3.1 File location and invocation

```
backend/scripts/smoke/prep-pipeline.ts
```

The script lives in the existing backend codebase so it can import `repo/*` modules (entities, relationships, facts, etc.) directly — no raw SQL needed for stats collection or teardown.

Wired in `backend/package.json` for local-developer iteration only:

```json
"smoke:prep-pipeline": "tsx --env-file=.env.smoke scripts/smoke/prep-pipeline.ts"
```

The `.env.smoke.example` shape stays useful for documentation; at runtime, the **ECS task injects env directly via task definition** — `DATABASE_URL`, `API_BASE`, `COGNITO_*`, `AWS_REGION`, and the 4 `SMOKE_*_SECRET_ID` values. The script doesn't read `.env.smoke` at runtime inside the task.

**Operator invocation:**

```bash
aws ecs run-task \
  --cluster mythrun \
  --task-definition mythrun-staging-smoke-prep-pipeline \
  --launch-type FARGATE \
  --network-configuration '<from-terraform-output>'
aws logs tail /ecs/mythrun-staging-smoke-prep-pipeline --follow
```

The exact command is printed by Terraform as an output (mirrors `bootstrap_db_run_task_default`).

### 3.2 Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Phase 1: Auth                                                 │
│  - Read 4 Cognito creds from Secrets Manager                   │
│  - USER_AUTH Cognito flow per user → 4 access tokens           │
│  (Credits already pre-seeded via separate one-shot task —      │
│   see §2.6. Smoke does NOT seed credits at runtime.)           │
└────────────────────────────────┬───────────────────────────────┘
                                 │
       ┌─────────────────────────┴─────────────────────────┐
       ▼                         ▼                         ▼
  Campaign 1                Campaign 2                Campaign 3
  - owner creates           (same shape,              (same shape,
  - 3 players join via       parallel)                 parallel)
    invite codes
  - each player submits
    concept
  - poll until
    status='active'
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│  Phase 3: Verify (in-VPC = direct DB + repo modules)           │
│  - 3 assertion layers (see §3.4)                               │
│  - Sanity-check DB hostname contains "staging" before any      │
│    DELETE (belt-and-suspenders against accidental prod hit).   │
│  - On FAIL: print IDs + failed assertion + exit non-zero       │
│  - On PASS: cascade-delete all created state via repo modules  │
│    + exit zero                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 Concepts

Three concepts committed at the top of the script as a typed array:

```ts
const CONCEPTS: { name: string; concept: string; floors: AssertionFloors }[] = [
  { name: 'bardsmoot', concept: '...', floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 } },
  { name: 'haunted-carnival', concept: '...', floors: { ... } },
  { name: 'mountain-monastery', concept: '...', floors: { ... } },
]
```

Floors are calibrated from real runs. Initial values: derived from the Bardsmoot world generated during the MYT-imxg smoke (43 entities, 55 relationships, 124 facts → 2.9 facts/entity). Conservative floors at ~60% of observed values to absorb LLM variance without flaking.

The Bardsmoot concept used in the myth-imxg smoke can be reused as concept #1. Concepts #2 and #3 to be authored fresh (one paragraph each, brand-aligned, tonally distinct).

### 3.4 Assertion contract

Three layers, all must pass for PASS:

**Layer A — Phase completeness (hard, no tolerance):**
- Each campaign's `campaigns.status='active'`.
- Each world's `worlds.status='complete'`.
- Every `pipeline_runs` row for these worlds is `status='completed'` (zero `failed`, zero `running` at end).
- Every campaign has exactly 3 character rows (one per player).
- Total entity-PCs = 9 across the 3 worlds (3 per campaign).

**Layer B — Per-concept floors (calibrated, soft):**
- Per campaign: entity count ≥ concept.floors.minEntities.
- Per campaign: relationship count ≥ concept.floors.minRelationships.
- Per campaign: average facts/entity ≥ concept.floors.minFactsPerEntity.

**Layer C — Global gates (hard):**
- Total cumulative cost across all 3 campaigns ≤ $5 (each world targets ~$1.20 per the myth-imxg smoke; 3 × $1.20 = $3.60 with $1.40 budget headroom for character creation + integration).
- Wall-clock ≤ 10 min from Phase 2 start.
- Zero `LlmRateLimitedError` (429-derived) entries observed via worker logs or SSE error events.

### 3.5 Failure handling

- Per-stage timeout 5 min (each `pipeline_runs` row that stays `running` for > 5 min triggers FAIL).
- Per-campaign timeout 8 min (whole campaign that doesn't reach `status='active'` triggers FAIL).
- Total wall-clock 10 min hard ceiling.
- No retries on Anthropic errors — the worker handles transient retries internally; the smoke fails loud on any propagated error.
- Try/finally wraps Phase 2 + 3. PASS path runs the cascade-delete; FAIL path skips it and prints state for forensic inspection.

### 3.6 Output

Structured JSON lines (one per significant event) to stdout. Examples:

```json
{"ts":"...","level":"info","event":"phase","phase":"auth_started"}
{"ts":"...","level":"info","event":"phase","phase":"auth_complete","userCount":4}
{"ts":"...","level":"info","event":"campaign","campaignId":"...","status":"created"}
{"ts":"...","level":"info","event":"campaign","campaignId":"...","status":"world_complete","durationMs":...,"costUsd":...}
{"ts":"...","level":"error","event":"assertion_failed","layer":"B","detail":"campaign X: entities=18, floor=25"}
{"ts":"...","level":"info","event":"summary","verdict":"PASS","totalCostUsd":..,"wallClockMs":..,"campaigns":[...]}
```

Pretty-printing for human terminal use is out of scope — operators pipe to `jq` or `pino-pretty` as needed.

## 4. Auth + Terraform changes

### 4.1 Cognito users via Terraform

Extend `infra/modules/auth/smoke-test.tf`. Current shape (per audit): one `mythrun-staging-smoke-test-credentials` Secrets Manager entry + one Cognito user. New shape: four Secrets Manager entries + four Cognito users.

Resource naming:

```
aws_cognito_user_pool_user.smoke_owner
aws_cognito_user_pool_user.smoke_player_1
aws_cognito_user_pool_user.smoke_player_2
aws_cognito_user_pool_user.smoke_player_3

aws_secretsmanager_secret.smoke_owner_credentials
aws_secretsmanager_secret.smoke_player_1_credentials
aws_secretsmanager_secret.smoke_player_2_credentials
aws_secretsmanager_secret.smoke_player_3_credentials
```

Username and email pattern (matches existing convention):

```
mythrun-staging-smoke-owner       → mythrun-staging-smoke-owner@example.com
mythrun-staging-smoke-player-1    → mythrun-staging-smoke-player-1@example.com
... etc
```

Passwords: random 32-char per user, stored in Secrets Manager, never logged.

### 4.2 ECS task family for the in-VPC smoke

New Terraform in `infra/environments/staging/main.tf` (or a sibling module):

- **`aws_ecs_task_definition.smoke_prep_pipeline`** — same backend image already in ECR. Container command: `tsx scripts/smoke/prep-pipeline.ts`. Memory + CPU sized like the worker task (1 vCPU / 2 GB). Env injected directly: `DATABASE_URL` (read from Terraform via the existing migrate-credentials secret reference), `API_BASE=https://staging-api.mythrun.com`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `AWS_REGION`, the 4 `SMOKE_*_SECRET_ID` values, `SMOKE_WALL_CLOCK_BUDGET_MS=600000`, `SMOKE_COST_CAP_USD=5.00`. The DB URL is constructed in Terraform from the existing RDS endpoint + `mythrun/staging/rds-password` secret value (not fetched from Secrets Manager at runtime — the task already has it in env).
- **Task role IAM** — scoped to `secretsmanager:GetSecretValue` on the 4 smoke-user secret ARNs + connect to the staging RDS security group. No write access to `iam:`, no other Secrets Manager. Uses the existing task execution role for image pull + log writes.
- **CloudWatch log group** `/ecs/mythrun-staging-smoke-prep-pipeline` with 14-day retention.
- **Network configuration** — staging VPC, private subnets, the existing worker-or-migrate security group (whichever has DB ingress).
- **Terraform output** `smoke_prep_pipeline_run_task_command` — the pre-canned `aws ecs run-task --cluster mythrun --task-definition mythrun-staging-smoke-prep-pipeline --launch-type FARGATE --network-configuration ...` command. Operator copies + pastes.

Pattern reference: `infra/environments/staging/main.tf` already has the `bootstrap_db_run_task_default`/`_verify`/`_reset_password`/etc. outputs for the migration runner task family. Smoke task family mirrors this exactly.

### 4.3 IAM for the local-developer invocation surface

The local `pnpm smoke:prep-pipeline` invocation surface (developer machine) is preserved for iteration but won't connect to staging DB end-to-end without a future bastion / SSM tunnel. Today, local iteration covers everything UP TO the DB-touch steps (auth + API requests against `https://staging-api.mythrun.com`); the DB-touch portion only works inside the ECS task. The script detects "no DB reachable" and skips the in-DB assertions + teardown with a clear log line so a developer can still iterate on the auth + API portions locally.

### 4.4 Credit pre-seed via one-shot ECS task

Extend the existing `mythrun-staging-bootstrap-db` task family with a new `--seed-smoke-credits` command flag. The implementation runs the SQL:

```sql
-- Inserts 1,000,000 each of world_gen + session credits per smoke user,
-- one row per (user, credit_type), source_type='admin', source_id derived
-- deterministically from (user_id, credit_type) so re-runs are idempotent
-- (ON CONFLICT DO NOTHING via a partial unique index on source_id where
-- source_type='admin').
INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
SELECT uuidv7(), u.id, ct.kind, 1000000, 'admin',
       uuid_generate_v5('00000000-0000-0000-0000-000000000000'::uuid,
                        u.id::text || ':' || ct.kind)
  FROM users u, (VALUES ('world_gen'), ('session')) AS ct(kind)
 WHERE u.cognito_sub IN (
   <four sub UUIDs from Cognito list-users, looked up at script time>
 )
ON CONFLICT DO NOTHING;
```

The script (server-side in the bootstrap task) reads the four Cognito subs from the `users` table (matching by `cognito_sub` after the smoke users have logged in once — they're materialized in the users table at first auth). 1M credits × 1 credit per campaign = 1M campaigns of headroom. Effectively forever.

Operator runs the pre-seed task ONCE after Phase A's Cognito user creation + after each smoke user has been materialized via first-login (which the smoke does anyway on first run). Re-running is idempotent (ON CONFLICT).

Terraform output `bootstrap_db_run_task_seed_smoke_credits` prints the command.

## 5. Rate-limit wiki content

Adds a new top-level subsection to `docs/wiki/content/runtime/llm.html` titled **"Concurrency + rate-limit ceilings"**. Content shape (~200-300 words):

- The two independent ceilings: our self-imposed BullMQ caps vs Anthropic's tier limits. Quick table.
- Current values: cap = 3 + 5 = 8 concurrent streams; Anthropic Tier 2 ≈ 50 RPM / 800k TPM input. Real numbers from the Anthropic console at authoring time.
- The constraint stack that justifies the cap:
  - pg connection pool (each in-flight job holds a pg client; pool size 10-ish; 8 leaves headroom)
  - ECS task memory (Vercel AI SDK buffers streaming JSON; 1 vCPU / 2 GB task)
  - ECS task CPU (Node single-threaded parse + repair chain)
  - Billing-burst safety (concurrency cap is a passive budget rate-limiter)
  - Atomic-claim contention (higher concurrency = more lock contention = rollback storms)
- Scaling levers: horizontal (more ECS tasks) vs vertical (bigger task + raise pg pool). Pointer to the trigger signals.
- Trigger signals that would warrant raising the cap:
  - pg connection pool utilization > 80% during peak
  - Worker queue depth > 50 for > 5 minutes
  - Observed Anthropic 429s in production
- A pointer to the smoke as the verification artifact: "`pnpm smoke:prep-pipeline` exercises the burst at peak concurrency; absence of 429s + completion within wall-clock budget is the running proof."

Wiki rationale callout (`<aside class="wiki-rationale">`) at the cap-justification point explains why we DON'T just raise the cap to match Anthropic Tier 2 — prep work is bursty-but-rare at launch traffic shape; the cap is not the bottleneck.

## 6. Wiki narrative sweep

Mechanical pass across 6 pages:

- `docs/wiki/content/runtime/index.html`
- `docs/wiki/content/runtime/worker.html`
- `docs/wiki/content/runtime/world-gen.html`
- `docs/wiki/content/runtime/character-creation.html` (heaviest drift — ~14 of the ~20 references)
- `docs/wiki/content/runtime/pipeline-status.html`
- `docs/wiki/content/data/index.html`

For each page:

1. Search for: `will land in MYT-`, `lands in MYT-`, `ships as MYT-`, `MYT-XX`, `TODO.*MYT`, `reserved for.*MYT-`.
2. For each hit, check the referenced ticket's current status via `mcp__linear-server__get_issue` or by grep against `git log`.
3. If shipped → rewrite to present-state. If still pending → leave the future-tense reference.
4. Apply the mental-model test from `docs/wiki/AUTHORING.md`: would a reader's mental model after reading this page match reality? If no, rewrite the surrounding narrative, not just the offending sentence.

Source-hash invariant: the source files those wiki pages declare in `<!-- source: -->` haven't changed (we're not touching backend code for the sweep). `pnpm wiki:accept-drift` is NOT used — these are narrative rewrites, not hash-only refreshes.

## 7. Testing

- **The smoke IS the test.** No unit tests for the smoke script itself; it's a one-shot integration runner. If assertions are wrong (false positive on healthy staging, or false negative on broken staging), the operator notices and adjusts.
- Terraform changes verified via `terraform plan` + `terraform apply` against staging (one-shot, not re-runnable).
- Wiki edits verified by `pnpm wiki:check` (source-hash invariant — passes because we don't change source files).
- The repo's existing gates apply: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm dev-tool:check`.

## 8. Non-goals

- **Dev-tool env switcher (local↔staging).** Decided 2026-05-28 — dev tool stays local-only. Staging verification is the curl-based smoke in this spec + the existing `staging.sh` Cognito-auth pattern.
- **Production smoke + paging.** This is staging-only. Production smoke + alerting + paging is a separate post-launch concern.
- **EventBridge cron + GitHub Actions deploy gate.** The ECS task family this ticket lands is the primitive that BOTH cron and deploy-gate would use. Future tickets wire each in ~15 lines of Terraform / one workflow step. Out of scope here; the artifact unlocks both.
- **Raising the worker concurrency caps.** The 3 + 5 caps are appropriate for launch traffic; raising them would require coordinated pg pool + task sizing changes documented in §5 but out of scope for this ticket.
- **Load testing beyond 3 campaigns.** The smoke saturates worker caps and that's the meaningful gate. Sustained load testing (hours of traffic) is a separate concern.
- **Wiki sweeps on pages outside the 6 named in §6.** The audit identified the drift scope; other pages may have minor drift but are out of scope.

## 9. Open questions

None at spec-writing time. Decisions captured:

- Smoke combines e2e + rate-limit verification (vs separate items).
- 4 dedicated Cognito users via Terraform (vs bootstrap-and-teardown or single-user-serialized).
- 3 hand-curated concepts (vs 1-replicated or random library).
- Leave-on-failure, clean-on-success teardown (vs always-clean or always-leave).
- Run inside the VPC via ECS Fargate task family (vs external dev-machine — rejected because staging RDS is correctly private).
- Pre-seed credits via one-shot ECS task with 1M-grant idempotent SQL (vs runtime seeding or new admin-grant API).
- Manual invocation today, primitive unlocks cron + deploy-gate without rewrite.
- Peak concurrency documented as 8, not 25 (corrects the original MYT-55 framing).
