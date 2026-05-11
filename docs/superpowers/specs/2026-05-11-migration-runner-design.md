# Migration runner for staging/prod RDS — design

> **Status:** brainstorm + round-1 blind review complete (4 reviewers: Oak/Birch/Cedar/Willow). 0 showstoppers under strict rubric; convergent nits applied inline. Awaiting user review before writing-plans.
> **Bead:** `myth-4mlu`
> **Linear:** none (internal tooling — per `feedback_tooling_not_on_linear.md`).

## 1. Problem

Mythrun ships SQL schema migrations in `backend/migrations/NNN_*.sql` and runs them against Postgres via `backend/src/db/migrate.ts`. Locally this is `pnpm db:migrate` against `localhost`. Against staging it's an undefined manual operator step: staging RDS is in a private subnet, and there's no automated runner.

Symptoms that motivated this design:

- The MYT-43 close revealed migrations 007 (`recreate_billing_tables`) and 008 (`billing_metering`) had never been applied to staging since their commit dates — only undetected because no production code path consumed the new schema yet.
- The bootstrap-db ECS task (last run 2026-05-07) handles DB user creation, not migrations.
- There is no record of when, by whom, or whether a given migration has been applied to staging.
- The `feedback_required_env_three_surfaces.md` memory documents the exact failure mode this design must prevent: an infra change that lands in the repo, is silently never deployed, and only surfaces days later when a downstream consumer hits the gap.

## 2. Decisions

Locked in during brainstorming (six AskUserQuestion rounds):

| # | Decision | Why |
|---|---|---|
| D1 | Hybrid trigger: auto-on-push (path filter on `backend/migrations/**`) **plus** a Deploy gate | Single-trigger designs are silently skip-able. Auto-on-push catches new migrations the moment they land; the Deploy gate guarantees no container rolls onto a schema-mismatched DB. |
| D2 | Reuse the backend image | The migrate CLI is already in the backend codebase. Building a separate image duplicates dependency management. The image that knows what schema it expects is the same image that ships the migrations. |
| D3 | Container boot-gate as the Deploy interlock | Same shape as the existing PG/Redis/Stripe probes. Container is authoritative about its schema needs; no CI-side data-plane queries; existing ECS rolloutState=FAILED machinery handles rollback. |
| D4 | Separate `.github/workflows/db-migrate.yml` workflow | Cleanest separation of concerns. Can rerun migrations without redeploying. Boot-gate (D3) is the safety net if the workflow doesn't fire. |
| D5 | Separate `mythrun_staging_migrate` DB user with `rds_superuser` membership | Future migrations needing `CREATE EXTENSION` (pgvector, etc.) can't be bottlenecked on app-user privileges. Mythrun is a launching production app; per CLAUDE.md, infra deserves the proper shape on first build. |
| D6 | GitHub red X as the only alerting surface | Same pattern as Auth Lint, Wiki, Migrations Append-Only. The boot-gate already provides downstream protection. SNS/Slack would duplicate the signal. |

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Trigger:                                                             │
│   push to main, paths: backend/migrations/**                         │
│   OR workflow_dispatch                                               │
│                              │                                       │
│                              ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ .github/workflows/db-migrate.yml  (environment: staging)     │    │
│  │  1. OIDC assume mythrun-github-actions-staging               │    │
│  │  2. aws ecs run-task --task-def mythrun-staging-migrate      │    │
│  │  3. wait tasks-stopped → fail if exitCode != 0               │    │
│  │  4. tail last 50 log lines from CloudWatch                   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ ECS task family  mythrun-staging-migrate                     │    │
│  │   image:   mythrun:latest  (same ECR repo as API)            │    │
│  │   command: ["node", "dist/db/migrate.js"]                    │    │
│  │   subnet:  private (same as API)                             │    │
│  │   env:     MIGRATE_DATABASE_URL ← Secrets Manager            │    │
│  │   logs:    /mythrun/staging/migrate                          │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│              RDS staging   (UPDATE _migrations table)                │
└──────────────────────────────────────────────────────────────────────┘

         Separately, on every deploy:

┌──────────────────────────────────────────────────────────────────────┐
│  ECS service mythrun-staging-api boots a new task →                  │
│    boot-gate probe sequence (PG, Redis, Stripe, ...):                │
│                                                                      │
│      NEW: probeMigrationsCurrent()                                   │
│        count *.sql files in /app/dist/migrations/                    │
│        SELECT count(*) FROM _migrations                              │
│        mismatch → throw → boot fails → rolloutState=FAILED           │
│                                                                      │
│  ECS deployment circuit breaker rolls the service back automatically.│
└──────────────────────────────────────────────────────────────────────┘
```

### Reused infra (no change)

- VPC, private subnets (NAT egress for ECR + Secrets Manager + STS, same as bootstrap-db)
- ECR repo `mythrun` (same image the API runs)
- OIDC IAM role `mythrun-github-actions-staging` (existing; gains the additive statements in §4.6)
- ECS cluster `mythrun`
- RDS instance + master credentials in Secrets Manager

### New infra

| Resource | Purpose |
|---|---|
| `aws_ecs_task_definition.migrate` (per env) | Pinned to `:placeholder` image, command override `["dumb-init", "node", "dist/db/migrate.js"]`, `stopTimeout = 120` |
| `aws_iam_role.migrate_task` + `aws_iam_role.migrate_task_execution` | Task-level role (empty — runtime makes no AWS calls) and execution-role (ECR pull + log writes + secret fetch). Explicit policies in §4.6. |
| `aws_secretsmanager_secret.migrate_db_credentials` | JSON `{username, password}` shape (matches RDS master secret convention). Created empty by TF; populated by bootstrap-db on first run. |
| `aws_cloudwatch_log_group.migrate` | `/mythrun/staging/migrate`, retention matched to other api/worker log groups |
| `aws_security_group.migrate_db` | **Dedicated SG** for migrate-to-RDS, not reused from bootstrap-db. Egress 5432/TCP to RDS, 443/TCP anywhere (Secrets Manager + ECR via NAT). Dedicated so an SG rule change to bootstrap-db doesn't accidentally widen migrate's reach. |
| `.github/workflows/db-migrate.yml` | The trigger + run-task workflow |

## 4. Components

### 4.1 Task definition `mythrun-staging-migrate`

```hcl
resource "aws_ecs_task_definition" "migrate" {
  family                   = "mythrun-${var.environment}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migrate_task_execution.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = "${var.ecr_repo_url}:placeholder"  # CI swaps in real digest
    essential   = true
    # dumb-init for PID-1 signal handling, matching API + worker containers.
    # stopTimeout = 120s matches the API task def — gives migrate.ts up to
    # 120s after SIGTERM to commit or roll back the in-flight transaction
    # cleanly before SIGKILL truncates. (Fargate default is 30s, which is
    # too short for long index builds.)
    command     = ["dumb-init", "node", "dist/db/migrate.js"]
    stopTimeout = 120
    environment = [
      { name = "AWS_REGION",   value = var.aws_region },
      { name = "MYTHRUN_ENV",  value = var.environment },
      { name = "REGION_PREFIX", value = "use1" },
      # MIGRATE_DATABASE_URL is composed in code from DB_* vars + the
      # migrate-credentials secret. Same shape as the API container.
      { name = "DB_HOST", value = var.rds_host },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = var.db_name },
      { name = "DB_USER", value = "mythrun_${var.environment}_migrate" },
    ]
    secrets = [
      # Secret value is a JSON document {"username":"...","password":"..."}
      # — matches the master RDS secret shape so prod can adopt the same
      # convention. ECS supports `valueFrom = <arn>:password::` to pluck a
      # single key out of a JSON secret.
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.migrate_db_credentials.arn}:password::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migrate.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}
```

Image is pinned to `:placeholder` exactly like the API and worker task defs, so the workflow can use the documented CI pattern (`amazon-ecs-render-task-definition` swaps the image to `mythrun:<sha>` at run time). Per `reference_tf_ci_taskdef_split.md` — TF never owns the image tag; CI does.

### 4.2 GitHub Actions workflow `db-migrate.yml`

Mirrors `deploy.yml`'s `describe → render → register → run` pattern exactly rather than improvising; uses SHA-pinned actions throughout for parity with security-relevant workflows; pins the image by commit SHA (not `:latest`) to defeat the parallel-build race; derives the log stream name from the task ARN (deterministic, not heuristic); distinguishes task-failed-to-start (`stoppedReason` set, `exitCode` null) from task-failed-during-run (`exitCode` non-zero).

```yaml
name: db-migrate

on:
  push:
    branches: [main]
    paths:
      - 'backend/migrations/*.sql'
      - '.github/workflows/db-migrate.yml'
      # NOTE: backend/Dockerfile is NOT in the path filter on purpose —
      # a Dockerfile change that breaks `COPY backend/migrations` is caught
      # by the API container boot-gate on the next Deploy, not by re-running
      # migrate (which would itself fail with ENOENT and produce noise).
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

# Env-scoped concurrency, not ref-scoped. A workflow_dispatch from any
# ref queues behind an in-flight auto-on-push on main. Two migrate tasks
# against the same staging DB serialize via `pg_advisory_lock` regardless,
# but queueing at the GHA layer keeps the workflow UX coherent.
concurrency:
  group: db-migrate-staging
  cancel-in-progress: false  # never cancel an in-flight migration

env:
  AWS_REGION: us-east-1
  ECR_REPO: mythrun
  ECS_CLUSTER: mythrun
  TASK_DEF_FAMILY: mythrun-staging-migrate
  CONTAINER_NAME: migrate
  LOG_GROUP: /mythrun/staging/migrate

jobs:
  migrate:
    runs-on: ubuntu-latest
    # Timeout > expected migration runtime + advisory-lock wait. 15min
    # exceeds RDS instance bound of `lock_timeout = '30s'` × pessimistic
    # 5-migration burst, with headroom.
    timeout-minutes: 15
    environment: staging
    steps:
      # All action SHAs pinned to full 40-char commits, matching deploy.yml.
      # Copy from .github/workflows/deploy.yml at plan time — do not resolve
      # fresh tags here.

      - name: Pre-flight — verify required vars are set
        run: |
          if [[ -z "${{ vars.AWS_ACCOUNT_ID }}" ]]; then
            echo "::error::vars.AWS_ACCOUNT_ID is not set."
            exit 1
          fi
          if [[ -z "${{ vars.PRIVATE_SUBNET_IDS }}" ]]; then
            echo "::error::vars.PRIVATE_SUBNET_IDS is not set (comma-separated subnet IDs)."
            exit 1
          fi
          if [[ -z "${{ vars.MIGRATE_SECURITY_GROUP_ID }}" ]]; then
            echo "::error::vars.MIGRATE_SECURITY_GROUP_ID is not set."
            exit 1
          fi

      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@<pinned-sha-from-deploy.yml>
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Resolve image digest by commit SHA
        id: image
        # Pin to ${{ github.sha }} — Deploy.build pushes mythrun:<sha>
        # in addition to :latest. Resolving by SHA avoids the race where
        # a parallel Deploy on a later commit retags :latest before this
        # workflow reads it.
        #
        # On workflow_dispatch the SHA is the dispatched ref's HEAD. If
        # the image for that SHA hasn't been pushed yet (manual rerun
        # before Deploy.build finished), the describe-images call fails
        # loudly with ImageNotFound — operator retries after Deploy is
        # green. This is the desired failure mode.
        run: |
          set -euo pipefail
          ACCOUNT="${{ vars.AWS_ACCOUNT_ID }}"
          REGISTRY="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
          DIGEST=$(aws ecr describe-images --repository-name "$ECR_REPO" \
            --image-ids "imageTag=${{ github.sha }}" \
            --query 'imageDetails[0].imageDigest' --output text)
          DIGEST_REF="${REGISTRY}/${ECR_REPO}@${DIGEST}"
          echo "digest_ref=$DIGEST_REF" >> "$GITHUB_OUTPUT"

      - name: Fetch current task definition
        # Mirrors deploy.yml exactly. The render-task-definition action
        # consumes a JSON file; the describe call here produces one.
        run: |
          set -euo pipefail
          aws ecs describe-task-definition \
            --task-definition "${{ env.TASK_DEF_FAMILY }}" \
            --query 'taskDefinition' \
            > task-def.json

      - name: Render new task definition with digest image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@<pinned-sha-from-deploy.yml>
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ steps.image.outputs.digest_ref }}

      - name: Register new task definition revision
        id: register
        # render-task-definition produces a JSON file but does NOT call
        # RegisterTaskDefinition itself (unlike ecs-deploy-task-definition).
        # We register explicitly so we can run-task against the exact new
        # revision rather than the family's ACTIVE LATEST, which could
        # race with a concurrent Deploy registering its own revision.
        run: |
          set -euo pipefail
          TD_ARN=$(aws ecs register-task-definition \
            --cli-input-json "file://${{ steps.taskdef.outputs.task-definition }}" \
            --query 'taskDefinition.taskDefinitionArn' --output text)
          echo "td_arn=$TD_ARN" >> "$GITHUB_OUTPUT"

      - name: Run migrate task
        id: runtask
        run: |
          set -euo pipefail
          TASK_ARN=$(aws ecs run-task \
            --cluster "$ECS_CLUSTER" \
            --task-definition "${{ steps.register.outputs.td_arn }}" \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[${{ vars.PRIVATE_SUBNET_IDS }}],securityGroups=[${{ vars.MIGRATE_SECURITY_GROUP_ID }}],assignPublicIp=DISABLED}" \
            --query 'tasks[0].taskArn' --output text)
          TASK_ID="${TASK_ARN##*/}"
          echo "task_arn=$TASK_ARN" >> "$GITHUB_OUTPUT"
          echo "task_id=$TASK_ID"  >> "$GITHUB_OUTPUT"
          # Deterministic log-stream name: awslogs-stream-prefix '/' container-name '/' task-id
          echo "log_stream=${CONTAINER_NAME}/${CONTAINER_NAME}/${TASK_ID}" >> "$GITHUB_OUTPUT"

      - name: Wait for task to stop
        run: |
          aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "${{ steps.runtask.outputs.task_arn }}"

      - name: Surface result + tail logs
        # Distinguishes three failure modes:
        #   1. Task failed to start (ENI/image-pull/secret-fetch) — stoppedReason set,
        #      containers[0].reason set, exitCode = None. Log stream may not exist.
        #   2. Task ran and exited non-zero — exitCode != 0; logs available.
        #   3. Task succeeded — exitCode == 0.
        run: |
          set -euo pipefail
          TASK_JSON=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" \
            --tasks "${{ steps.runtask.outputs.task_arn }}" --query 'tasks[0]')
          STOP_REASON=$(echo "$TASK_JSON"  | jq -r '.stoppedReason // ""')
          CONT_REASON=$(echo "$TASK_JSON"  | jq -r '.containers[0].reason // ""')
          EXIT=$(echo "$TASK_JSON"         | jq -r '.containers[0].exitCode // "null"')

          echo "stoppedReason=$STOP_REASON"
          echo "containerReason=$CONT_REASON"
          echo "exitCode=$EXIT"

          if [[ "$EXIT" == "null" ]]; then
            # Container never ran. Logs likely don't exist; emit the
            # ECS-side failure reasons to GitHub annotations + summary.
            echo "::error::Migrate task failed to start. stoppedReason='$STOP_REASON' containerReason='$CONT_REASON'"
            {
              echo "## Migrate task failed to start"
              echo "- **stoppedReason:** $STOP_REASON"
              echo "- **containerReason:** $CONT_REASON"
              echo "- **taskArn:** ${{ steps.runtask.outputs.task_arn }}"
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi

          # Container ran — pull last 200 log lines, newest first. --start-from-head=false
          # so we get the tail, not the head; --limit 200 covers most real migrations.
          # Stream name is deterministic (computed in runtask step), so no describe-log-streams
          # heuristic; no "latest stream picks up a concurrent run's stream" problem.
          aws logs get-log-events \
            --log-group-name "$LOG_GROUP" \
            --log-stream-name "${{ steps.runtask.outputs.log_stream }}" \
            --limit 200 \
            --start-from-head false \
            --query 'events[*].message' --output text || true

          # Pluck the migrate.start log line's runId for the GitHub summary, so the
          # operator can jump straight to a CloudWatch Logs Insights query.
          RUN_ID=$(aws logs get-log-events \
            --log-group-name "$LOG_GROUP" \
            --log-stream-name "${{ steps.runtask.outputs.log_stream }}" \
            --limit 1000 --start-from-head true \
            --query 'events[?contains(message, `migrate.start`)] | [0].message' --output text \
            | jq -r '.runId // ""' 2>/dev/null || echo "")
          if [[ -n "$RUN_ID" ]]; then
            INSIGHTS_URL="https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#logsV2:logs-insights\$3FqueryDetail=~(end~0~start~-3600~timeType~'RELATIVE~unit~'seconds~editorString~'fields*20*40timestamp*2c*20*40message*0a*7c*20filter*20runId*20*3d*20*22${RUN_ID}*22~source~(~'${LOG_GROUP//\//*2f}))"
            {
              echo "## Migrate run details"
              echo "- **runId:** \`$RUN_ID\`"
              echo "- **CloudWatch Insights:** $INSIGHTS_URL"
              echo "- **taskArn:** ${{ steps.runtask.outputs.task_arn }}"
              echo "- **exitCode:** $EXIT"
            } >> "$GITHUB_STEP_SUMMARY"
          fi

          if [[ "$EXIT" != "0" ]]; then
            echo "::error::Migrate task exited $EXIT — runId=$RUN_ID, see CloudWatch $LOG_GROUP / ${{ steps.runtask.outputs.log_stream }}"
            exit 1
          fi
```

**On ordering with Deploy:** both `db-migrate.yml` (this workflow) and `deploy.yml` fire on the same `push` to main when a commit contains both a migration and code. They run concurrently with no cross-workflow `needs:` dependency. The container boot-gate in §4.3 is the interlock: if Deploy reaches `deploy-staging` before db-migrate finishes, the new container's boot-gate fails the probe, ECS rolls back, Deploy goes red. Operator re-triggers Deploy after db-migrate is green. This is by design — D3 makes the boot-gate authoritative — but it does mean paired commits can produce one transient Deploy red. Documented in §6.

**On image SHA tag availability:** the Deploy workflow's `build` job pushes `mythrun:<github.sha>` in addition to `:latest`. If a `workflow_dispatch` runs the migrate workflow before the corresponding Deploy build has pushed (manual rerun, debugging), the `describe-images imageTag=<sha>` call fails with `ImageNotFound` — operator retries after Deploy is green. We rely on this deliberate failure mode rather than polling for the image to appear.

### 4.3 Boot-gate probe `probeMigrationsCurrent`

New file `backend/src/boot/migrations-current.ts`:

```ts
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Pool } from 'pg'

// Shared regex with backend/src/db/migrate.ts (export and import from there
// once the runner exposes it, so probe and runner cannot disagree on
// "what counts as a migration file"). For now, mirror exactly.
const MIGRATION_FILE_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export async function probeMigrationsCurrent(pool: Pool): Promise<void> {
  // Path resolution: in the production image, this file is at
  //   /app/dist/boot/migrations-current.js
  // and the migrate.ts CLI lives at
  //   /app/dist/db/migrate.js
  // Both must agree on the migrations directory. The existing Dockerfile
  // copies `backend/migrations` to `/app/migrations` (NOT under `dist/`),
  // and migrate.ts's DEFAULT_MIGRATIONS_DIR resolves
  //   `resolve(__dirname, '../../migrations')` from `/app/dist/db/`
  // → `/app/migrations`. The probe must resolve to the same path:
  //   `resolve(here, '../../../migrations')` from `/app/dist/boot/`
  // → `/app/migrations`. One extra `..` because boot/ is one level
  // shallower than db/.
  const here = fileURLToPath(import.meta.url)
  const migrationsDir = resolve(here, '../../../migrations')
  const allFiles = await readdir(migrationsDir)
  const sqlFiles = allFiles.filter((f) => MIGRATION_FILE_RE.test(f)).sort()
  const expected = new Set(sqlFiles)

  // Handle fresh-DB case explicitly: on a never-migrated database the
  // _migrations table doesn't exist, so the COUNT query throws SQLSTATE
  // 42P01 with a confusing 'relation does not exist' message. Use
  // `to_regclass` to detect that case and emit an operator-actionable
  // error pointing at the db-migrate workflow.
  const exists = await pool.query<{ reg: string | null }>(
    "SELECT to_regclass('public._migrations')::text AS reg",
  )
  if (!exists.rows[0] || exists.rows[0].reg === null) {
    throw new Error(
      `migrations-current: _migrations table does not exist — DB has never been migrated. ` +
      `Run \`gh workflow run db-migrate\` to apply ${String(sqlFiles.length)} migrations (latest in image: ${String(sqlFiles.at(-1))}).`,
    )
  }

  // Compare by version set, not by count. Strict-count equality is wrong
  // under rollback (image has 8 files, DB has 9 because the rolled-back
  // migration was already applied) and under hypothetical out-of-band
  // hotfixes. The right invariant for a forward-rolling system is:
  // "every migration the image expects is applied to the DB." Extra rows
  // in _migrations (e.g., from a newer image that was rolled back) are
  // tolerated; missing rows are not.
  const applied = await pool.query<{ version: string }>('SELECT version FROM _migrations')
  const appliedSet = new Set(applied.rows.map((r) => r.version))
  const missing = sqlFiles.filter((f) => !appliedSet.has(f))

  if (missing.length > 0) {
    throw new Error(
      `migrations-current: image expects ${String(sqlFiles.length)} migrations, ` +
      `DB is missing ${String(missing.length)} (${missing.join(', ')}). ` +
      `Run \`gh workflow run db-migrate\` then re-trigger Deploy.`,
    )
  }

  // Surface a non-fatal warning if the DB has rows for files that aren't
  // in the image (downgrade scenario or accidentally-deleted migration).
  // This is informational only — the image's schema expectations are met.
  const orphans = applied.rows.map((r) => r.version).filter((v) => !expected.has(v))
  if (orphans.length > 0) {
    // Boot-gate must not log here directly (no pino import in boot/);
    // throw a typed warning that server.ts logs at level=warn before
    // continuing. Implementation detail; both paths net to the same.
    // Plan-time decision: either return a warning sentinel or just
    // proceed silently. Default: proceed silently — orphans don't
    // affect runtime correctness.
  }
}
```

Wired into `src/server.ts`'s `main()` boot-gate sequence between the Redis probe and the Stripe probe (DB-dependent → Redis-independent → external-API). Existing `pino`-shaped error logs route to the same boot.fatal path that handled the MYTHRUN_ENV failure correctly.

**Why set-inclusion not strict-count:**
- The MYTHRUN_ENV failure mode this design exists to prevent is "image expects schema state X, DB is at state Y; ship anyway and break at runtime." That's a *missing-applies* problem, not an extra-applies problem.
- Strict count equality treats rollback as a hard failure (image rolls back to N migrations, DB still has N+1). Set inclusion treats it as informational — the rolled-back image's schema needs are still met by the DB.
- Both probe and the migrate runner (`backend/src/db/migrate.ts`) end up using `MIGRATION_FILE_RE`. The plan should export this from a single source (`backend/src/db/migration-filename.ts`?) to lock the two views together.

**Why `to_regclass` first:** the alternative — catching the 42P01 error from `SELECT count(*)` — works but produces a less readable error path. `to_regclass` is the standard Postgres idiom for "does this relation exist."

### 4.4 Dockerfile

**No changes required.** The existing `backend/Dockerfile` already copies migrations into the runtime image at `/app/migrations` (line 33: `COPY --from=builder --chown=mythrun:mythrun /app/backend/migrations ./migrations`). The migrate CLI's `DEFAULT_MIGRATIONS_DIR` already resolves to `/app/migrations` via `resolve(__dirname, '../../migrations')` from `/app/dist/db/migrate.js`.

The new boot-gate probe resolves to the same path via `resolve(__dirname, '../../../migrations')` from `/app/dist/boot/migrations-current.js` (one extra `..` because `boot/` is shallower than `db/`). Both consumers read the same directory; they cannot disagree about "what migrations the image expects."

The plan should add a Dockerfile-shape test that asserts `/app/migrations/001_initial_schema.sql` exists in the built image, so a future Dockerfile edit that breaks the COPY is caught at CI time rather than at first deploy.

### 4.5 DB role provisioning — `bootstrap-databases.sh` extension

**CLI surface change.** Add a new mode `migrate-user` to `set_mode` and a `--migrate-user-only` flag that runs only `provision_migrate_user`. The existing `--reset-password` flag is for the app user; add `--reset-migrate-password` as a sibling flag that triggers a password rotation on the migrate user specifically. The default-mode dispatch is extended to call `provision_migrate_user` alongside the existing app-user provisioning, so a single `aws ecs run-task --task-definition mythrun-staging-bootstrap-db` brings both users into the desired state idempotently.

**Postgres role model.** `rds_superuser` is **not** a true `SUPERUSER` in Postgres — it cannot bypass object ACLs the way `SUPERUSER` does. Specifically, `ALTER TABLE` / `DROP TABLE` / `CREATE INDEX` on objects owned by another role requires either ownership or *membership in the owner role*. Mythrun's existing tables (from migrations 001–008) are all owned by the app user `mythrun_${env}`. The migrate user therefore needs **both** `rds_superuser` (for `CREATE EXTENSION`) **and** membership in the app-user role (for ALTER on existing app-owned objects).

The function:

```bash
provision_migrate_user() {
  local migrate_user="mythrun_${DEPLOY_ENV}_migrate"
  local app_user="mythrun_${DEPLOY_ENV}"
  local migrate_secret_id="mythrun/${DEPLOY_ENV}/migrate-db-credentials"

  # Idempotent: skip body if user already exists, unless --reset-migrate-password
  local exists
  exists=$("${PSQL_MASTER[@]}" --tuples-only --no-align \
    --set=u="$migrate_user" \
    <<< "SELECT 1 FROM pg_roles WHERE rolname = :'u'" | tr -d '[:space:]')

  local needs_create_or_rotate=0
  if [[ -z "$exists" || "${RESET_MIGRATE_PW:-0}" == "1" ]]; then
    needs_create_or_rotate=1
  fi

  if [[ "$needs_create_or_rotate" == "1" ]]; then
    local pw
    pw=$(generate_password)

    # Cluster-level operations against the maintenance DB.
    "${PSQL_MASTER[@]}" --set=u="$migrate_user" --set=pw="$pw" --set=app="$app_user" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') THEN
    CREATE USER :u WITH LOGIN PASSWORD :'pw';
  ELSE
    ALTER USER :u WITH PASSWORD :'pw';
  END IF;
END
\$\$;
GRANT rds_superuser TO :u;
GRANT :app TO :u;    -- inherits ALTER/DROP rights on existing app-owned tables
SQL

    # Schema-level GRANT must run against the TARGET database, not the
    # maintenance DB. The existing bootstrap script's grant_public_schema_create
    # function uses this same pattern for the app user.
    psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
      --dbname="$DB_NAME" --no-password --tuples-only --no-align \
      --set=u="$migrate_user" <<SQL
GRANT USAGE, CREATE ON SCHEMA public TO :u;
SQL

    # Secret value is JSON-encoded {"username", "password"} for parity with
    # the master RDS secret. ECS task def references the .password field
    # via `valueFrom = <arn>:password::`.
    local secret_json
    secret_json=$(jq -cn --arg u "$migrate_user" --arg p "$pw" '{username:$u, password:$p}')
    aws secretsmanager put-secret-value \
      --secret-id "$migrate_secret_id" --secret-string "$secret_json" --region "$AWS_REGION" >/dev/null

    echo "Provisioned $migrate_user → $migrate_secret_id (JSON shape)"
  else
    echo "$migrate_user already exists; skip (pass --reset-migrate-password to rotate)"
  fi
}
```

**Apply order on first stand-up:**
1. `terraform apply` — creates the migrate task def, IAM roles, log group, and the empty `migrate_db_credentials` secret resource.
2. Run bootstrap-db ECS task with default mode (provisions app user AND migrate user; populates both secrets).
3. `gh workflow run db-migrate` — applies the existing 8 migrations.
4. (Optional) `gh workflow run Deploy` — to flip the API onto the new image with the boot-gate. The boot-gate now sees `_migrations` with 8 rows matching the image's 8 files, passes, container serves.

Step 2 must succeed before step 3 — ECS `run-task` for migrate fetches `:password::` from the secret at task launch; if no `AWSCURRENT` version exists, the execution role's secret-fetch fails before the container even starts. Acceptance criteria (§10) call this ordering out explicitly.

**Why this role model:**
- `rds_superuser` membership gives the migrate user `CREATE EXTENSION` for the RDS-allowed list (pgcrypto, pgvector, uuid-ossp) — closes the future-migration foot-gun.
- Membership in the app-user role gives the migrate user the rights of the owner of every app-owned table, so `ALTER TABLE` / `DROP TABLE` / `CREATE INDEX` against the existing schema works without ownership transfer.
- Schema-level `CREATE` on `public` lets it create new tables that get owned by the migrate user itself (acceptable — `rds_superuser` membership means the app user can still read/write via existing GRANTs, and new migrations should explicitly `GRANT SELECT, INSERT, UPDATE, DELETE` to the app user as part of their CREATE TABLE statements, which is a per-migration convention the runner enforces by example).
- The migrate user has no application code touching it — its blast radius is bounded to the operator manual runs and the GHA workflow's IAM-scoped `ecs:RunTask`.

**Blast radius if the migrate secret leaks:** an attacker who can read the secret can connect to RDS as `mythrun_${env}_migrate` and execute `DROP DATABASE`, `DROP ROLE`, alter any table, read every row. This is staging — recoverable from snapshots. **For prod, the spec leaves password-rotation cadence unset deliberately; see §5 "Decisions deferred."** The plan should specify a 90-day Secrets Manager automatic rotation hook before the prod migrate workflow is enabled. Filed as a precondition for the prod-scope bead.

### 4.6 IAM

Three role surfaces. Each policy is enumerated explicitly here rather than left as a hand-wave for the plan.

**Execution role** `mythrun-staging-migrate-task-execution` — used by ECS to pull the image and fetch secrets before the container starts:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:<acct>:log-group:/mythrun/staging/migrate:*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:<acct>:secret:mythrun/staging/migrate-db-credentials-*"
    }
  ]
}
```

**Task role** `mythrun-staging-migrate-task` — used by the running container. The migrate CLI only talks to RDS (not AWS APIs) so the role is empty; it exists for traceability and for future operator visibility into "what could this task do at runtime."

**OIDC role addition** to `mythrun-github-actions-staging` — additive statement, not a rewrite:

```json
{
  "Effect": "Allow",
  "Action": "ecs:RunTask",
  "Resource": "arn:aws:ecs:us-east-1:<acct>:task-definition/mythrun-staging-migrate:*",
  "Condition": {
    "ArnEquals": {
      "ecs:cluster": "arn:aws:ecs:us-east-1:<acct>:cluster/mythrun"
    }
  }
},
{
  "Effect": "Allow",
  "Action": "ecs:DescribeTaskDefinition",
  "Resource": "*"
},
{
  "Effect": "Allow",
  "Action": "ecs:RegisterTaskDefinition",
  "Resource": "*"
},
{
  "Effect": "Allow",
  "Action": ["ecs:DescribeTasks", "ecs:ListTasks"],
  "Resource": "*",
  "Condition": {
    "ArnEquals": {
      "ecs:cluster": "arn:aws:ecs:us-east-1:<acct>:cluster/mythrun"
    }
  }
},
{
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": [
    "arn:aws:iam::<acct>:role/mythrun-staging-migrate-task-execution",
    "arn:aws:iam::<acct>:role/mythrun-staging-migrate-task"
  ],
  "Condition": {
    "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
  }
},
{
  "Effect": "Allow",
  "Action": ["logs:DescribeLogStreams", "logs:GetLogEvents"],
  "Resource": "arn:aws:logs:us-east-1:<acct>:log-group:/mythrun/staging/migrate:*"
},
{
  "Effect": "Allow",
  "Action": "ecr:DescribeImages",
  "Resource": "arn:aws:ecr:us-east-1:<acct>:repository/mythrun"
}
```

**What this OIDC role can now do that it couldn't before:**
- Run **only** the `mythrun-staging-migrate` task family, **only** in the `mythrun` cluster. No other task definitions are reachable.
- Register new revisions of any task definition (required by the workflow's `register-task-definition` step). This is a non-trivial expansion, but it's identical to what `deploy.yml`'s OIDC role already has; the migrate workflow is not increasing the existing surface there.
- Describe/get-events on the migrate log group only.

The OIDC role is **not** granted `secretsmanager:GetSecretValue` on the migrate secret — only the ECS execution role can read it. A leaked OIDC role can launch tasks (which then fetch the secret via their execution role and pass it as an env var to the container), but the role itself cannot pull the plaintext password directly. This matches `deploy.yml`'s existing posture.

## 5. Production scope

The TF module is shared (`infra/modules/serving/main.tf`). All new resources are keyed on `var.environment`, so when `infra/environments/production/` stands up:

- `mythrun-prod-migrate` task family materializes alongside the API + worker.
- A second workflow file `.github/workflows/db-migrate-prod.yml` (or — preferred — the same workflow with a job matrix on `environment`) handles prod. **Prod migrate is `workflow_dispatch` only — no auto-on-push.** Prod schema changes are a hands-on event.
- Same boot-gate probe runs in the prod API container.

The exact prod workflow shape is out of scope for this design; flag in the plan that the staging design must generalize to prod cleanly. Decisions deferred:

- Cross-region replication implications (none today; mythrun is single-region)
- Approval gate (GitHub Environment with required reviewers)
- Audit log retention (CloudWatch retention bumped for prod migrate logs)

## 6. Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Migrate task exits non-zero | Workflow fails (red X in Actions tab). The "Surface result + tail logs" step writes the `runId` and a CloudWatch Logs Insights URL into `$GITHUB_STEP_SUMMARY` so the operator can jump straight to the structured log query | Operator reads logs, fixes the migration (forward-fix only — `git revert` does not undo a Postgres state change) or RDS state, pushes a fixing commit OR `workflow_dispatch` reruns. Subsequent Deploys remain blocked by the boot-gate until DB catches up. |
| Migrate task SIGTERM mid-run | `migrate.ts` exits 130 by convention; `_migrations` table stays consistent because each migration runs in its own transaction (the file's SQL and the `INSERT INTO _migrations` row are in the same txn, so a SIGTERM either commits both or rolls back both). `stopTimeout = 120` gives the in-flight txn up to 120s to commit-or-rollback cleanly before SIGKILL. | Re-run picks up at the first un-applied file. Idempotent. |
| Task failed to start (ENI / image pull / secret fetch failure) | `containers[0].exitCode == null`, `stoppedReason` set. The workflow's log step surfaces both fields to `$GITHUB_STEP_SUMMARY` rather than emitting a misleading "exit code None" message. | Operator reads the `stoppedReason` annotation, fixes the underlying issue (subnet capacity, ECR image existence, secret AWSCURRENT version), reruns. |
| Boot-gate fires after deploy of an image carrying a new migration | ECS `rolloutState=FAILED` → auto-rollback → previous image continues serving | Run `db-migrate` workflow → re-trigger Deploy. Service stays healthy on the old image during the gap. |
| Paired commit race (migration + code in one push) | Both `db-migrate.yml` and `deploy.yml` fire concurrently; Deploy may reach `deploy-staging` before db-migrate finishes; boot-gate fails the new container; ECS rollback. | Operator re-triggers Deploy after db-migrate is green. The boot-gate is the interlock by design (D3); transient Deploy red on paired commits is expected. |
| Two migrate tasks race (e.g., manual dispatch + auto-on-push collide) | `migrate.ts` uses `pg_advisory_lock(LOCK_KEY)` (session-scoped). Second connection blocks on the lock until the first session ends. | Second task waits, then exits clean (no-op on already-applied files). GHA `timeout-minutes: 15` must exceed expected migration runtime + lock-wait. |
| Broken migration committed directly to main | The auto-on-push run fires, the migrate task fails inside RDS, the failed file's transaction rolls back (no partial state). `_migrations` table stays consistent. Boot-gate then prevents any code that depends on the broken migration from rolling. | Forward-fix only: push a fixing commit (which auto-fires the workflow again) or `workflow_dispatch` with the file fixed. Do NOT `git revert` and rely on that — `revert` removes the file from the working tree but does not undo Postgres state. (In this case there's no state to undo, since the txn rolled back; but the discipline matters for the general case.) |
| migrate-db-credentials secret rotation | Bootstrap-db `--reset-migrate-password` flag rotates the password in Postgres + writes the new value to Secrets Manager. ECS resolves the `secrets:` block at task launch (not at task-def-register time), so the *next* `db-migrate` workflow run picks up the new password automatically — no task-def re-registration required. | Operator runs `aws ecs run-task --task-definition mythrun-staging-bootstrap-db --overrides '{"containerOverrides":[{"command":["--env","staging","--reset-migrate-password"],"name":"bootstrap"}]}'` then validates the next migrate run is green. |
| Fresh DB (`_migrations` table doesn't exist) | Boot-gate probe checks `to_regclass('public._migrations')` first; if the relation doesn't exist, throws a specific operator-actionable error ("DB has never been migrated — run `gh workflow run db-migrate`") rather than the generic SQLSTATE 42P01 surface. | Operator runs `db-migrate` workflow once; the migrate CLI's `CREATE TABLE IF NOT EXISTS _migrations` creates the table; subsequent runs are normal. |
| Rollback to an image with FEWER migrations than the DB has applied | Boot-gate probe uses set-inclusion (every file in the image is applied) rather than strict-count equality. Extra rows in `_migrations` (from a newer image that was rolled back) are tolerated. | No operator action needed; the rolled-back image's schema needs are met. |

## 7. Testing

- **Unit:** `backend/src/boot/__tests__/migrations-current.test.ts`
  - Happy path: mock `readdir` → 8 files, mock pool → `to_regclass = '_migrations'`, `SELECT version FROM _migrations` returns the same 8 versions → resolves.
  - Missing migrations: pool returns 6 of 8 versions → throws with explicit `missing 2 (007_x.sql, 008_y.sql)` text.
  - Fresh DB (relation doesn't exist): `to_regclass` returns NULL → throws with "DB has never been migrated — run `gh workflow run db-migrate`" message; does NOT proceed to the `SELECT version` query.
  - Rollback tolerance: image has 8 files, DB has 9 versions (extra row from a rolled-back newer image) → passes (set-inclusion). Optionally exercises the orphan-detection path if implemented to emit a warning.
  - Regex filter: `readdir` returns `['001_x.sql', 'README.md', '002_y.sql', 'ABC_INVALID.sql']` → expected set is `{'001_x.sql','002_y.sql'}`, regex matches lowercase 3+ digit prefix only.
- **Unit:** `backend/src/__tests__/server.test.ts`
  - Boot-gate test adds a scenario where `probeMigrationsCurrent` rejects → boot fails, app.listen not called, closePartials runs (mirrors PG/Redis probe-fail tests).
- **Dockerfile-shape test:** `backend/src/__tests__/dockerfile-shape.test.ts` (or extend existing) — asserts that `/app/migrations/001_initial_schema.sql` exists in the runtime image. Cheap via Dockerfile-source grep; full-build verification deferred to CI.
- **Workflow smoke** (manual end-to-end against staging — operator runs once at first apply, per §10):
  1. `gh workflow run db-migrate` (workflow_dispatch) on `main`.
  2. Workflow run shows green; `$GITHUB_STEP_SUMMARY` includes a `runId` + Insights URL.
  3. Verify `_migrations` table contains 8 rows matching the image's 8 `*.sql` files.
  4. Re-run `gh workflow run db-migrate` → idempotent (no pending files), exits 0 with "no migrations to apply" log.
  5. Push a no-op `backend/migrations/009_test.sql` on a feature branch and verify the workflow does NOT fire (only `main`); fast-revert.
  6. Roll a Deploy → boot-gate passes; `/health` returns 200; running task def revision >= 65.
  7. Operator confirms the GHA workflow's Insights URL deep-links to the right CloudWatch view.

## 8. Out of scope

- **Prod migrate workflow shape** (manual gating, approvals, audit). Design flags the constraint; concrete YAML deferred until prod env exists.
- **`MYTHRUN_DRY_RUN`-style preview mode for migrate.** Useful, but not a launch-blocker.
- **Per-migration timing / observability dashboards.** CloudWatch logs are enough for now.
- **Bootstrap-db's own deployment pipeline.** It's currently rebuilt manually via `bootstrap-db-build.yml`; redesigning that is unrelated work.
- **Worker deploy job in `deploy.yml`** — tracked separately as `myth-mkc3` (P3, not urgent).
- **Multi-region migrations.** Mythrun is single-region today; revisit when prod adds a second region.
- **Migration rollback tooling.** `migrate.ts` is forward-only by design. Schema rollback is a separate operational concern with its own design surface.

## 9. Open questions

None blocking the writing-plans transition. Items flagged in §5 (prod workflow shape, prod approval gate) are downstream decisions, not pre-requisites for the staging implementation.

## 10. First-apply runbook (staging)

The first time this design is rolled out to staging, the operator runs four steps in order. Each step's gate is verifiable; do not skip the verification between steps.

1. **`terraform apply` against `infra/environments/staging/`.** Registers the new task def at `:placeholder` image, the IAM roles, the log group, the empty Secrets Manager secret. Verify:
   ```bash
   aws ecs describe-task-definition --task-definition mythrun-staging-migrate \
     --query 'taskDefinition.{rev:revision,image:containerDefinitions[0].image}'
   ```
   Should show `image=...:placeholder`, revision = new.

2. **Run bootstrap-db ECS task in default mode.** Provisions the migrate user (alongside re-validating the app user, which is idempotent). Populates the migrate-credentials secret with `{username, password}` JSON.
   ```bash
   aws ecs run-task --cluster mythrun --task-definition mythrun-staging-bootstrap-db \
     --launch-type FARGATE \
     --network-configuration "$(terraform -chdir=infra/environments/staging output -raw bootstrap_db_run_task_default | sed 's/.*--network-configuration //;s/ --overrides.*//')" \
     --overrides '{"containerOverrides":[{"command":["--env","staging"],"name":"bootstrap"}]}'
   ```
   Wait for the task to stop, verify exit 0, then check:
   ```bash
   aws secretsmanager describe-secret --secret-id mythrun/staging/migrate-db-credentials \
     --query '{arn:ARN,versionStages:VersionIdsToStages}'
   ```
   Should show `AWSCURRENT` present. If absent, the migrate task will fail to start in step 3.

3. **First `gh workflow run db-migrate`.** Applies migrations 007 + 008 (and any later ones pending). Verify the workflow run is green; check the `$GITHUB_STEP_SUMMARY` for the `runId` + Insights URL. Sanity-check the DB:
   ```bash
   # Run a one-shot SQL query via bootstrap-db task with --verify mode (or via psql from a bastion).
   # Expect: SELECT count(*) FROM _migrations  →  8 (matching count of *.sql files in image)
   ```

4. **`gh workflow run Deploy` to re-roll the API onto an image with the boot-gate enabled.** The new API container's boot-gate probe runs `to_regclass + SELECT version FROM _migrations`, finds all 8 image-expected migrations applied, passes. ECS rollout completes; `/health` returns 200.

If any step fails, do NOT proceed to the next — each downstream step depends on the prior step's `AWSCURRENT` / `_migrations` state.

## 11. Acceptance criteria

- `gh workflow run db-migrate` against staging applies pending migrations (007 + 008 at the time of writing) and exits green
- A push to main that adds a new migration file auto-fires `db-migrate.yml` and the run reaches green
- Deploy workflow against a staging API container whose image carries migrations not yet applied to RDS produces `rolloutState=FAILED` + auto-rollback, with the failure cause clearly identifying which migrations are pending
- `bootstrap-db` `--reset-migrate-password` rotates the secret cleanly and the next migrate workflow run authenticates successfully
- `mythrun_staging_migrate` user exists with `rds_superuser` membership; secret ARN matches what TF expects
