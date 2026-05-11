# Migration runner (myth-4mlu) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land an automated migration runner for staging RDS — `db-migrate.yml` GHA workflow runs `node dist/db/migrate.js` as a one-shot ECS task; backend boot-gate probe `probeMigrationsCurrent` refuses to start the API on a schema-mismatched DB; dedicated `mythrun_staging_migrate` user with `rds_superuser` + app-user role membership; first-apply runbook lands migrations 007 + 008.

**Architecture:** Reuse the backend ECR image as a one-shot ECS task with command override `["dumb-init", "node", "dist/db/migrate.js"]`. Separate `.github/workflows/db-migrate.yml` workflow auto-fires on push-to-main when `backend/migrations/*.sql` changes, pinning the image by `${{ github.sha }}` digest. API boot-gate probe (new file `backend/src/boot/migrations-current.ts`) compares `*.sql` files baked into the image against `_migrations` rows in the DB via set inclusion. New TF resources (task def, IAM, secret, SG, log group) live in `infra/modules/serving/migrate.tf`; OIDC policy extension lives in `infra/environments/staging/main.tf`.

**Tech Stack:** TypeScript (Vitest, pino, pg), Bash (psql, AWS CLI), Terraform, GitHub Actions, ECS Fargate, AWS Secrets Manager, RDS Postgres 16.

---

## File Structure

**New files:**
- `backend/src/db/migration-filename.ts` — exports `MIGRATION_FILE_RE` (shared by migrate.ts and the probe)
- `backend/src/boot/migrations-current.ts` — boot-gate probe
- `backend/src/boot/__tests__/migrations-current.test.ts` — unit tests (4 scenarios)
- `infra/modules/serving/migrate.tf` — task def, IAM roles, secret, SG, log group for the migrate task
- `.github/workflows/db-migrate.yml` — auto-on-push workflow + manual dispatch

**Modified files:**
- `backend/src/db/migrate.ts` — import shared regex, remove inline definition
- `backend/src/server.ts` — add `probeMigrationsCurrent` call between Redis-batch probe and Stripe probe
- `backend/src/__tests__/server.test.ts` — add boot-gate scenario for migrations probe failure
- `infra/scripts/bootstrap-databases.sh` — add `provision_migrate_user` function + `--reset-migrate-password` flag + dispatch surface
- `infra/environments/staging/main.tf` — extend `gh_actions_staging` policy with `ecs:RunTask` on migrate family + `iam:PassRole` on migrate roles

**One-time operator steps (not code):**
- `terraform apply` against `infra/environments/staging/`
- Bump `bootstrap_image_tag` in `terraform.tfvars` after bootstrap-db rebuilds
- Provision GHA env vars (`PRIVATE_SUBNET_IDS`, `MIGRATE_SECURITY_GROUP_ID`) on the `staging` environment
- Trigger `db-migrate` workflow once

---

### Task 1: Extract MIGRATION_FILE_RE to a shared module

**Why:** The probe (new) and migrate.ts (existing) must agree on "what counts as a migration file." Sharing the regex constant via a single module is the lock against divergence. The constant is small but load-bearing.

**Files:**
- Create: `backend/src/db/migration-filename.ts`
- Modify: `backend/src/db/migrate.ts`

- [ ] **Step 1: Create the shared constant**

`backend/src/db/migration-filename.ts`:

```ts
// Shared filename pattern for forward-rolling SQL migrations.
//
// Consumed by:
//   - backend/src/db/migrate.ts        (the migration runner)
//   - backend/src/boot/migrations-current.ts (the boot-gate probe)
//
// Keep these consumers locked to one regex; a probe that filters
// differently than the runner produces silent count drift.
export const MIGRATION_FILE_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export function isValidMigrationFilename(name: string): boolean {
  return MIGRATION_FILE_RE.test(name)
}
```

- [ ] **Step 2: Update migrate.ts to import from the shared module**

In `backend/src/db/migrate.ts`, replace the inline regex + function (around lines 13-17):

Current code:
```ts
const FILENAME_RE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export function isValidMigrationFilename(name: string): boolean {
  return FILENAME_RE.test(name)
}
```

Replace with:
```ts
import { MIGRATION_FILE_RE, isValidMigrationFilename } from './migration-filename.js'

export { isValidMigrationFilename }
```

Then replace the one internal use of `FILENAME_RE` (around line 134) with `MIGRATION_FILE_RE`.

- [ ] **Step 3: Run tests + lint to verify the refactor is clean**

Run: `pnpm --filter backend exec vitest run src/db/__tests__/migrate-validator.test.ts --reporter=dot`
Expected: PASS (all existing validator tests still pass; the move was a no-op for behavior)

Run: `pnpm --filter backend lint`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migration-filename.ts backend/src/db/migrate.ts
git commit -m "refactor(myth-4mlu): extract MIGRATION_FILE_RE to shared module"
```

---

### Task 2: probeMigrationsCurrent — TDD all four scenarios

**Why:** The boot-gate probe is the Deploy interlock (spec D3). It compares the image's expected migration set against the DB's applied set; on mismatch, throws an operator-actionable error that surfaces through the existing rolloutState=FAILED path. Four scenarios cover the realistic state space: happy, missing migrations, fresh DB (no `_migrations`), rollback tolerance.

**Files:**
- Create: `backend/src/boot/migrations-current.ts`
- Create: `backend/src/boot/__tests__/migrations-current.test.ts`

- [ ] **Step 1: Write the failing test (all four scenarios up front)**

`backend/src/boot/__tests__/migrations-current.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { probeMigrationsCurrent } from '../migrations-current.js'

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}))

import { readdir } from 'node:fs/promises'

// readdir is typed `Promise<Dirent[]>` in some overloads; the probe uses
// the string[] overload, so we cast through unknown to the right shape.
const readdirMock = readdir as unknown as ReturnType<typeof vi.fn>

interface FakePool {
  query: ReturnType<typeof vi.fn>
}

function fakePool(queries: Array<{ rows: Array<Record<string, unknown>> }>): FakePool {
  const q = vi.fn()
  for (const result of queries) {
    q.mockResolvedValueOnce(result)
  }
  return { query: q }
}

describe('probeMigrationsCurrent', () => {
  beforeEach(() => {
    readdirMock.mockReset()
  })

  it('resolves when image files exactly match applied versions', async () => {
    readdirMock.mockResolvedValue([
      '001_initial_schema.sql',
      '002_indexes.sql',
      'README.md', // non-SQL, filtered out
    ])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] }, // to_regclass result
      { rows: [{ version: '001_initial_schema.sql' }, { version: '002_indexes.sql' }] },
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).resolves.toBeUndefined()
  })

  it('throws operator-actionable error when _migrations table does not exist', async () => {
    readdirMock.mockResolvedValue(['001_initial_schema.sql', '002_indexes.sql'])
    const pool = fakePool([
      { rows: [{ reg: null }] }, // to_regclass returns NULL
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).rejects.toThrow(
      /_migrations table does not exist.*Run `gh workflow run db-migrate`/s,
    )
  })

  it('throws when DB is missing migrations the image expects', async () => {
    readdirMock.mockResolvedValue([
      '001_initial_schema.sql',
      '002_indexes.sql',
      '003_srd_reference_data.sql',
    ])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] },
      { rows: [{ version: '001_initial_schema.sql' }] }, // missing 002, 003
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).rejects.toThrow(
      /missing 2 \(002_indexes\.sql, 003_srd_reference_data\.sql\)/,
    )
  })

  it('resolves when DB has extra applied versions not in image (rollback tolerance)', async () => {
    readdirMock.mockResolvedValue(['001_initial_schema.sql', '002_indexes.sql'])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] },
      {
        rows: [
          { version: '001_initial_schema.sql' },
          { version: '002_indexes.sql' },
          { version: '003_orphan_from_newer_rolled_back_image.sql' },
        ],
      },
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).resolves.toBeUndefined()
  })

  it('filters out non-matching filenames (uppercase, dotfiles, README, .gz)', async () => {
    readdirMock.mockResolvedValue([
      '001_initial_schema.sql',
      '002_INDEXES.sql', // uppercase prefix word — rejected by regex
      '.DS_Store',
      'README.md',
      '003_x.sql.gz',
      '004_z.sql',
    ])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] },
      { rows: [{ version: '001_initial_schema.sql' }, { version: '004_z.sql' }] },
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend exec vitest run src/boot/__tests__/migrations-current.test.ts --reporter=dot`
Expected: FAIL — `Cannot find module '../migrations-current.js'`

- [ ] **Step 3: Write the implementation**

`backend/src/boot/migrations-current.ts`:

```ts
// Boot-gate probe: ensure the DB has applied every migration this image
// expects. Run as part of the API server's boot-gate sequence in
// backend/src/server.ts.
//
// Compares by set inclusion (every file in the image is applied), NOT by
// strict count equality. Rollback to an image with fewer migrations is
// tolerated; missing migrations on the DB side is not.
//
// On a fresh DB the _migrations table does not exist. We detect that
// case explicitly via to_regclass and emit an operator-actionable error,
// rather than the generic SQLSTATE 42P01 surface.

import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { MIGRATION_FILE_RE } from '../db/migration-filename.js'

export async function probeMigrationsCurrent(pool: Pool): Promise<void> {
  // Path resolution: in the production image,
  //   /app/dist/boot/migrations-current.js → /app/migrations/*.sql
  // (three `..`s because boot/ is one deeper than dist/ root,
  // and migrations/ is a sibling of dist/).
  const here = fileURLToPath(import.meta.url)
  const migrationsDir = resolve(here, '../../../migrations')
  const allFiles = await readdir(migrationsDir)
  const sqlFiles = allFiles.filter((f) => MIGRATION_FILE_RE.test(f)).sort()

  // Check the table exists before SELECTing from it. SELECT count(*) on a
  // missing relation throws SQLSTATE 42P01; the to_regclass form returns
  // NULL and lets us emit a better error.
  const existsResult = await pool.query<{ reg: string | null }>(
    "SELECT to_regclass('public._migrations')::text AS reg",
  )
  const exists = existsResult.rows[0]?.reg ?? null
  if (exists === null) {
    const latest = sqlFiles.at(-1) ?? '(none)'
    throw new Error(
      `migrations-current: _migrations table does not exist — DB has never been migrated. ` +
        `Run \`gh workflow run db-migrate\` to apply ${String(sqlFiles.length)} migrations ` +
        `(latest in image: ${latest}).`,
    )
  }

  const appliedResult = await pool.query<{ version: string }>(
    'SELECT version FROM _migrations',
  )
  const appliedSet = new Set(appliedResult.rows.map((r) => r.version))
  const missing = sqlFiles.filter((f) => !appliedSet.has(f))

  if (missing.length > 0) {
    throw new Error(
      `migrations-current: image expects ${String(sqlFiles.length)} migrations, ` +
        `DB is missing ${String(missing.length)} (${missing.join(', ')}). ` +
        `Run \`gh workflow run db-migrate\` then re-trigger Deploy.`,
    )
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend exec vitest run src/boot/__tests__/migrations-current.test.ts --reporter=dot`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Run lint + typecheck**

Run: `pnpm --filter backend lint` → Expected: 0 errors
Run: `pnpm --filter backend typecheck` → Expected: clean

- [ ] **Step 6: Commit**

```bash
git add backend/src/boot/migrations-current.ts backend/src/boot/__tests__/migrations-current.test.ts
git commit -m "feat(myth-4mlu): probeMigrationsCurrent boot-gate probe"
```

---

### Task 3: Wire probe into server.ts boot-gate + extend server.test.ts

**Why:** A probe nobody calls is dead code. Wire it into the boot-gate sequence between the Redis-batch probe and the Stripe probe (DB-dependent → external-API). Existing rolloutState=FAILED machinery handles rollback when this throws.

**Files:**
- Modify: `backend/src/server.ts` (insert probe call around line 137)
- Modify: `backend/src/__tests__/server.test.ts` (add probe-fail scenario)

- [ ] **Step 1: Write the failing test scenario**

Open `backend/src/__tests__/server.test.ts` and add a new mock + test scenario alongside the existing PG/Redis probe-fail scenarios.

Near the top, with the other vi.mock calls, add:

```ts
const mockProbeMigrationsCurrent = vi.fn()
vi.mock('../boot/migrations-current.js', () => ({
  probeMigrationsCurrent: async (pool: unknown): Promise<void> => {
    await mockProbeMigrationsCurrent(pool)
  },
}))
```

In the `beforeEach`, alongside `mockProbe.mockReset().mockResolvedValue(undefined)`, add:

```ts
mockProbeMigrationsCurrent.mockReset().mockResolvedValue(undefined)
```

Then add a new test alongside the other probe-fail tests (look for the existing test `'Postgres probe fails → exitCode=1, app.listen NOT called, closePartials runs'` and add this one in the same describe block):

```ts
it(
  'migrations-current probe fails → exitCode=1, named in error log, app.listen NOT called',
  async () => {
    mockPgQuery.mockResolvedValue({})
    mockRtrPing.mockResolvedValue('PONG')
    mockRtbPing.mockResolvedValue('PONG')
    mockProbeMigrationsCurrent.mockRejectedValueOnce(
      new Error(
        'migrations-current: image expects 8 migrations, DB is missing 2 (007_recreate_billing_tables.sql, 008_billing_metering.sql). Run `gh workflow run db-migrate` then re-trigger Deploy.',
      ),
    )

    let errorOutput = ''
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((msg: unknown) => {
        errorOutput += String(msg) + '\n'
      })

    await import('../server.js')

    // Boot-gate aborts before app.listen runs.
    expect(mockListen).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errorOutput).toContain('migrations-current')
    expect(errorOutput).toContain('Run `gh workflow run db-migrate`')

    errSpy.mockRestore()
  },
  TEST_TIMEOUT_MS,
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend exec vitest run src/__tests__/server.test.ts -t 'migrations-current probe fails' --reporter=dot`
Expected: FAIL — probe is mocked but not actually wired into server.ts yet, so the failure path isn't exercised. Specifically, app.listen WILL be called (because no current code throws), so `expect(mockListen).not.toHaveBeenCalled()` fails.

- [ ] **Step 3: Wire the probe into server.ts**

In `backend/src/server.ts`, add an import near the other boot imports (look for `import { waitFor } from './boot/wait-for.js'` around line 8):

```ts
import { probeMigrationsCurrent } from './boot/migrations-current.js'
```

In `main()`, between the Redis-batch probe (line ~131-136) and the Stripe probe (line ~138-146), insert:

```ts
    // Schema-readiness probe: refuse to start the API on a DB that has
    // not had every migration the image expects applied. The boot-gate
    // turns the throw into a non-zero process exit; ECS rolls back the
    // deploy. See docs/superpowers/specs/2026-05-11-migration-runner-design.md.
    await probeMigrationsCurrent(pgRef)
    console.log('✓ migrations-current verified')
```

The result should look like:

```ts
    await waitFor({
      label: 'Redis (batch)',
      probe: () => rTBRef.ping(),
      signal: abortController.signal,
    })
    console.log('✓ Redis (batch) ready')

    // Schema-readiness probe: ...
    await probeMigrationsCurrent(pgRef)
    console.log('✓ migrations-current verified')

    // MYT-41: Stripe contract verification. ...
    const stripeClient = getStripeClient(env)
```

- [ ] **Step 4: Run the new test + the existing server.test.ts suite**

Run: `pnpm --filter backend exec vitest run src/__tests__/server.test.ts --reporter=dot`
Expected: PASS — 5 tests (the original 4 + the new one).

- [ ] **Step 5: Run the full backend suite to make sure no regression**

Run: `pnpm --filter backend exec vitest run --reporter=dot`
Expected: PASS — all tests green. Most importantly the existing happy-path scenario still passes (probeMigrationsCurrent default mock resolves to undefined, so it's a no-op).

- [ ] **Step 6: Run lint + typecheck**

Run: `pnpm --filter backend lint && pnpm --filter backend typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/server.ts backend/src/__tests__/server.test.ts
git commit -m "feat(myth-4mlu): wire migrations-current probe into boot gate"
```

---

### Task 4: bootstrap-databases.sh — provision_migrate_user function + CLI

**Why:** The migrate task needs a dedicated DB user with `rds_superuser` + app-user-role membership. Bootstrap-db is the canonical place for DB user provisioning; mirror the existing `create_user_only`/`rotate_password` pattern.

**Files:**
- Modify: `infra/scripts/bootstrap-databases.sh`

- [ ] **Step 1: Add the CLI flag + dispatch arm**

At the top of `infra/scripts/bootstrap-databases.sh`, update the usage comment (around line 9) from:

```bash
#   bootstrap-databases.sh --env staging [--verify | --user-only | --secret-only | --reset-password]
```

to:

```bash
#   bootstrap-databases.sh --env staging [--verify | --user-only | --secret-only | --reset-password | --migrate-user-only | --reset-migrate-password]
```

And in the docstring near line 15, add two new bullets:

```bash
#   --migrate-user-only          Provision/refresh the migrate user only.
#   --reset-migrate-password     Rotate the migrate user's password + secret value.
```

In the argument parsing case statement (around line 48-54), add two new arms before the closing `esac`:

```bash
    --migrate-user-only)     set_mode "migrate-user-only"; shift ;;
    --reset-migrate-password) set_mode "reset-migrate-password"; RESET_MIGRATE_PW=1; shift ;;
```

And initialize `RESET_MIGRATE_PW=0` near the top of the script alongside the other top-level vars (around the `MODE="default"` line ~37).

- [ ] **Step 2: Add the `provision_migrate_user` function**

Find the existing `rotate_password()` function (around lines 197-206). Add this new function below it:

```bash
# Provision the migrate user with rds_superuser + app-user role membership.
# The migrate user runs forward-only schema migrations. rds_superuser
# enables CREATE EXTENSION; membership in the app-user role grants ALTER
# rights on existing app-owned tables (rds_superuser is NOT a true
# SUPERUSER and cannot bypass object ACLs).
#
# Idempotent: skips if user already exists, unless RESET_MIGRATE_PW=1.
# The secret value is JSON {"username","password"} matching the master
# RDS secret convention.
provision_migrate_user() {
  local migrate_user="mythrun_${DEPLOY_ENV}_migrate"
  local migrate_secret_id="mythrun/${DEPLOY_ENV}/migrate-db-credentials"
  local app_user="$DB_USER"

  local exists
  exists=$("${PSQL_MASTER[@]}" --tuples-only --no-align \
    --set=u="$migrate_user" \
    <<< "SELECT 1 FROM pg_roles WHERE rolname = :'u'" | tr -d '[:space:]')

  if [[ -n "$exists" && "${RESET_MIGRATE_PW:-0}" != "1" ]]; then
    echo "$migrate_user already exists; skip (pass --reset-migrate-password to rotate)"
    return 0
  fi

  local pw
  pw=$(generate_password)

  # Cluster-level grants against the maintenance DB.
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
GRANT :app TO :u;
SQL

  # Schema-level grants must run against the TARGET DB, not the maintenance DB.
  psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
    --dbname="$DB_NAME" --no-password --tuples-only --no-align \
    --set=u="$migrate_user" <<SQL
GRANT USAGE, CREATE ON SCHEMA public TO :u;
SQL

  # JSON-shape secret value: {"username":"...","password":"..."}. ECS
  # task def references .password via `valueFrom = <arn>:password::`.
  local secret_json
  secret_json=$(jq -cn --arg u "$migrate_user" --arg p "$pw" '{username:$u, password:$p}')
  aws secretsmanager put-secret-value \
    --secret-id "$migrate_secret_id" --secret-string "$secret_json" --region "$AWS_REGION" >/dev/null
  echo "Provisioned $migrate_user → $migrate_secret_id (JSON shape)"
}
```

- [ ] **Step 3: Wire the new function into the dispatch**

Find the dispatch case at the bottom of the file (around line 209-228). Update the `default` mode block to also call `provision_migrate_user` alongside the existing app-user provisioning:

Change from:
```bash
  default)
    state=$(verify_state)
    case "$state" in
      OK)             echo "Nothing to do (already bootstrapped)." ;;
      MISSING)        create_db_and_user ;;
      DB_ONLY)        create_user_only ;;
      SECRET_MISSING) rotate_password ;;
      *)              echo "ERROR: unexpected state '$state'" >&2; exit 1 ;;
    esac
    ;;
```

to:
```bash
  default)
    state=$(verify_state)
    case "$state" in
      OK)             echo "Nothing to do (already bootstrapped)." ;;
      MISSING)        create_db_and_user ;;
      DB_ONLY)        create_user_only ;;
      SECRET_MISSING) rotate_password ;;
      *)              echo "ERROR: unexpected state '$state'" >&2; exit 1 ;;
    esac
    # Always (re-)assert the migrate user. Idempotent — skips if already
    # present unless --reset-migrate-password is set.
    provision_migrate_user
    ;;
```

And add two new dispatch arms before the closing `esac`:

```bash
  migrate-user-only)
    provision_migrate_user
    ;;
  reset-migrate-password)
    provision_migrate_user
    ;;
```

- [ ] **Step 4: Run shellcheck**

Run: `shellcheck infra/scripts/bootstrap-databases.sh`
Expected: 0 errors (warnings on pre-existing dollar-sign escapes are OK).

If you don't have shellcheck locally: `brew install shellcheck` first.

- [ ] **Step 5: Commit**

```bash
git add infra/scripts/bootstrap-databases.sh
git commit -m "feat(myth-4mlu): provision_migrate_user in bootstrap-db"
```

---

### Task 5: TF — migrate task def, IAM, secret, SG, log group (new file)

**Why:** All the new TF resources scoped to the migrate runner live in one new file inside the serving module, so they can be reviewed and applied as a coherent unit. The OIDC policy update (different module, different concern) lives in Task 6.

**Files:**
- Create: `infra/modules/serving/migrate.tf`

- [ ] **Step 1: Write the resource file**

`infra/modules/serving/migrate.tf`:

```hcl
# infra/modules/serving/migrate.tf
#
# Migration-runner infrastructure: ECS task def + execution/task roles +
# Secrets Manager secret + dedicated security group + log group. Wired
# together so the GHA db-migrate.yml workflow can ECS run-task this
# family with command override `node dist/db/migrate.js` to apply
# pending migrations against RDS.
#
# Spec: docs/superpowers/specs/2026-05-11-migration-runner-design.md
# Bead: myth-4mlu

# --- log group ---

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/mythrun/${var.environment}/migrate"
  retention_in_days = 30
  tags              = { Name = "mythrun-${var.environment}-migrate" }
}

# --- Secrets Manager: migrate-db-credentials ---
#
# TF creates the secret resource; bootstrap-db populates the first
# version on its next default-mode run. ECS execution role can read this
# secret; the API/worker task roles cannot.
resource "aws_secretsmanager_secret" "migrate_db_credentials" {
  name                    = "mythrun/${var.environment}/migrate-db-credentials"
  description             = "JSON {username,password} for the migrate DB user. Rotated by bootstrap-db --reset-migrate-password."
  recovery_window_in_days = 7
  tags                    = { Name = "mythrun-${var.environment}-migrate-db-credentials" }
}

# --- security group ---
#
# Dedicated SG. NOT shared with bootstrap-db so an SG-rule change to
# bootstrap-db cannot accidentally widen migrate's reach (blast-radius
# isolation per spec §3).
resource "aws_security_group" "migrate" {
  name        = "mythrun-${var.environment}-migrate"
  description = "Migrate runner task: egress to RDS + HTTPS to AWS APIs"
  vpc_id      = var.vpc_id
  tags        = { Name = "mythrun-${var.environment}-migrate" }
}

resource "aws_vpc_security_group_egress_rule" "migrate_to_rds" {
  security_group_id            = aws_security_group.migrate.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.rds_security_group_id
  description                  = "Postgres to RDS"
}

resource "aws_vpc_security_group_egress_rule" "migrate_https" {
  security_group_id = aws_security_group.migrate.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS to AWS APIs (Secrets Manager, ECR, STS) via NAT"
}

# RDS-side ingress: allow the migrate SG to reach RDS:5432. The RDS SG
# is owned outside this module; we add a one-way reference here.
resource "aws_vpc_security_group_ingress_rule" "rds_from_migrate" {
  security_group_id            = var.rds_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.migrate.id
  description                  = "Postgres from migrate task (${var.environment})"
}

# --- IAM: execution role (used by ECS to pull image + read secrets) ---

resource "aws_iam_role" "migrate_task_execution" {
  name               = "mythrun-${var.environment}-migrate-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = { Name = "mythrun-${var.environment}-migrate-task-execution" }
}

resource "aws_iam_role_policy_attachment" "migrate_task_execution_baseline" {
  role       = aws_iam_role.migrate_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "migrate_task_execution_inline" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.migrate_db_credentials.arn,
    ]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.migrate.arn}:*"]
  }
}

resource "aws_iam_role_policy" "migrate_task_execution_inline" {
  name   = "migrate-task-execution-inline"
  role   = aws_iam_role.migrate_task_execution.id
  policy = data.aws_iam_policy_document.migrate_task_execution_inline.json
}

# --- IAM: task role (no runtime AWS API access; placeholder for traceability) ---

resource "aws_iam_role" "migrate_task" {
  name               = "mythrun-${var.environment}-migrate-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = { Name = "mythrun-${var.environment}-migrate-task" }
}

# --- ECS task definition ---

resource "aws_ecs_task_definition" "migrate" {
  family                   = "mythrun-${var.environment}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.migrate_task_execution.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = "${var.ecr_repo_url}:placeholder" # CI swaps in real digest
    essential   = true
    command     = ["dumb-init", "node", "dist/db/migrate.js"]
    stopTimeout = 120
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "MYTHRUN_ENV", value = var.environment },
      { name = "REGION_PREFIX", value = "use1" },
      { name = "DB_HOST", value = var.rds_host },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = var.db_name },
      { name = "DB_USER", value = "mythrun_${var.environment}_migrate" },
    ]
    secrets = [
      {
        name      = "DB_PASSWORD"
        valueFrom = "${aws_secretsmanager_secret.migrate_db_credentials.arn}:password::"
      }
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

  # Image tag changes are CI-driven, not TF-driven. TF only owns the
  # task-def shape (env vars, secrets, IAM); CI re-registers with the
  # real ECR digest at deploy time. See reference_tf_ci_taskdef_split.md.
  lifecycle {
    ignore_changes = [
      container_definitions, # CI re-registers revisions
    ]
  }

  tags = { Name = "mythrun-${var.environment}-migrate" }
}

# --- outputs ---

output "migrate_security_group_id" {
  value       = aws_security_group.migrate.id
  description = "Set this as a GitHub Environment variable MIGRATE_SECURITY_GROUP_ID on the 'staging' environment."
}

output "migrate_task_definition_family" {
  value       = aws_ecs_task_definition.migrate.family
  description = "Task definition family name for the db-migrate workflow."
}

output "migrate_log_group_name" {
  value       = aws_cloudwatch_log_group.migrate.name
  description = "Log group name for the db-migrate workflow."
}
```

- [ ] **Step 2: Add the assume-role trust document if missing**

Check whether `data.aws_iam_policy_document.ecs_tasks_trust` already exists in `infra/modules/serving/main.tf`. Run:

```bash
grep -n 'ecs_tasks_trust\|ecs-tasks.amazonaws.com' infra/modules/serving/main.tf
```

If the trust doc already exists (look for `data "aws_iam_policy_document" "ecs_tasks_trust"`), no action needed — the new resources reference it.

If it doesn't exist, the existing `task_execution` and `task` roles inline their trust policy via `assume_role_policy = jsonencode(...)`. Match that pattern in `migrate.tf` by extracting the trust into a shared `data` block. Or, simpler: inline the same trust document in each migrate role:

Replace the two `assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json` lines with:

```hcl
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
```

- [ ] **Step 3: Add input variable for `rds_security_group_id`**

Check whether `var.rds_security_group_id` already exists in `infra/modules/serving/variables.tf`. Run:

```bash
grep -n 'rds_security_group_id' infra/modules/serving/variables.tf
```

If absent, add to `infra/modules/serving/variables.tf`:

```hcl
variable "rds_security_group_id" {
  description = "Security group ID for the RDS instance — migrate task adds ingress + egress rules referencing it."
  type        = string
}
```

And pass it in `infra/environments/staging/main.tf` where the `module "serving"` block is defined. Find the existing module call and add the line:

```hcl
  rds_security_group_id = <existing reference to RDS SG, e.g., aws_security_group.rds.id or module.data.rds_security_group_id>
```

If you can't immediately tell which variable holds it, run:

```bash
grep -n 'rds.*security_group\|aws_security_group.rds' infra/environments/staging/main.tf infra/modules/data/*.tf 2>/dev/null
```

- [ ] **Step 4: Run `terraform fmt` + `terraform validate`**

```bash
cd infra/environments/staging
terraform fmt -recursive ../../modules/serving/
terraform validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Run `terraform plan`**

```bash
terraform plan -out=migrate.tfplan
```
Expected: roughly 7 new resources to add:
- `aws_cloudwatch_log_group.migrate`
- `aws_secretsmanager_secret.migrate_db_credentials`
- `aws_security_group.migrate`
- `aws_vpc_security_group_egress_rule.migrate_to_rds`
- `aws_vpc_security_group_egress_rule.migrate_https`
- `aws_vpc_security_group_ingress_rule.rds_from_migrate`
- `aws_iam_role.migrate_task_execution` + 1 policy attachment + 1 inline policy
- `aws_iam_role.migrate_task`
- `aws_ecs_task_definition.migrate`

Plus 3 new outputs.

No deletions, no modifications to existing resources (other than the SG ingress rule on the RDS SG — make sure that's an ADD not a REPLACE).

**Stop here and ask the user to review the plan output before applying** if anything in the plan diff is unexpected (e.g., replacements of unrelated resources, deletions).

- [ ] **Step 6: Commit (apply is a separate step in Task 8)**

```bash
git add infra/modules/serving/migrate.tf infra/modules/serving/variables.tf infra/environments/staging/main.tf
git commit -m "infra(myth-4mlu): migrate task def + IAM + secret + SG + log group"
```

---

### Task 6: TF — OIDC role policy additions for migrate

**Why:** The GHA OIDC role needs new grants to `ecs:RunTask` on the migrate task family, `ecs:DescribeTasks`/`ListTasks` on the cluster (already there in the existing grant), `iam:PassRole` on the new migrate roles, plus `logs:DescribeLogStreams`/`GetLogEvents` on the migrate log group and `ecr:DescribeImages` on the mythrun repo.

**Files:**
- Modify: `infra/environments/staging/main.tf`

- [ ] **Step 1: Locate the existing OIDC policy doc**

Open `infra/environments/staging/main.tf` and find the `data "aws_iam_policy_document" "gh_actions_staging"` block (around line 256-353). Read through it to understand existing statements:
- `ecs:UpdateService` etc. on cluster
- `ecs:RegisterTaskDefinition` on `mythrun-${env}-*:*` family pattern (this already covers migrate)
- `ecs:DescribeTaskDefinition` on `*`
- `iam:PassRole` on the shared task-execution + task roles

- [ ] **Step 2: Add new statements**

After the existing `iam:PassRole` statement (around line 336-348), add three new statements:

```hcl
  # ecs:RunTask scoped to the migrate task definition family + cluster.
  # The existing UpdateService/RegisterTaskDefinition grants do NOT
  # imply RunTask — this is a meaningful new privilege class on the
  # OIDC role. Scoped tightly so it can only launch migrate tasks in
  # the mythrun cluster.
  statement {
    actions   = ["ecs:RunTask"]
    resources = [
      "arn:aws:ecs:us-east-1:${data.aws_caller_identity.current.account_id}:task-definition/mythrun-${var.environment}-migrate:*",
    ]
    condition {
      test     = "StringEquals"
      variable = "ecs:cluster"
      values = [
        "arn:aws:ecs:us-east-1:${data.aws_caller_identity.current.account_id}:cluster/mythrun",
      ]
    }
  }

  # iam:PassRole for the new migrate roles. The existing PassRole
  # statement covers the shared serving roles; the migrate task uses
  # dedicated roles for blast-radius isolation, so they need their own
  # PassRole grant.
  statement {
    actions = ["iam:PassRole"]
    resources = [
      module.serving.migrate_task_execution_role_arn,
      module.serving.migrate_task_role_arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # CloudWatch log reads for the migrate workflow's "tail + surface" step.
  # Scoped to the migrate log group only.
  statement {
    actions   = ["logs:DescribeLogStreams", "logs:GetLogEvents"]
    resources = [
      "${module.serving.migrate_log_group_arn}:*",
    ]
  }

  # ECR describe-images for resolving the SHA-pinned digest at run time.
  statement {
    actions   = ["ecr:DescribeImages"]
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
    ]
  }
```

- [ ] **Step 3: Add the new module outputs referenced above**

Edit `infra/modules/serving/migrate.tf` and append two more outputs (these are referenced by the OIDC policy):

```hcl
output "migrate_task_execution_role_arn" {
  value = aws_iam_role.migrate_task_execution.arn
}

output "migrate_task_role_arn" {
  value = aws_iam_role.migrate_task.arn
}

output "migrate_log_group_arn" {
  value = aws_cloudwatch_log_group.migrate.arn
}
```

- [ ] **Step 4: Re-run `terraform plan`**

```bash
cd infra/environments/staging
terraform plan -out=migrate-oidc.tfplan
```
Expected: the policy doc on `aws_iam_role_policy.github_actions_staging` shows a content change (new statements appended), plus the new outputs from Task 5. Make sure the plan does NOT show "destroy" on the policy doc; appending statements to an inline policy is an in-place update.

- [ ] **Step 5: Commit**

```bash
git add infra/environments/staging/main.tf infra/modules/serving/migrate.tf
git commit -m "infra(myth-4mlu): OIDC policy extension for migrate (RunTask + PassRole + logs + ECR)"
```

---

### Task 7: `terraform apply` against staging

**Why:** Register the new resources so the GHA workflow can run-task against the new family. Per `reference_tf_ci_taskdef_split.md`, image is pinned to `:placeholder` — CI swaps in the real digest at run time.

**This task has no code commit** — it's a one-shot operator apply.

- [ ] **Step 1: Authenticate to AWS**

```bash
aws sts get-caller-identity --query Arn
```
Expected: `arn:aws:iam::862127484110:user/mythrun-admin` (or whichever admin user is configured). If session expired, refresh via SSO / `aws login`.

- [ ] **Step 2: Apply**

```bash
cd infra/environments/staging
terraform apply -auto-approve
```

Expected output: `Apply complete! Resources: ~11 added, 1 changed, 0 destroyed.` (rough numbers — depends on what's been applied recently).

Read the outputs section for `migrate_security_group_id` and `migrate_task_definition_family` — copy these values, they're needed in Task 9.

- [ ] **Step 3: Verify task def exists**

```bash
aws ecs describe-task-definition --task-definition mythrun-staging-migrate --region us-east-1 \
  --query 'taskDefinition.{rev:revision, image:containerDefinitions[0].image, env:containerDefinitions[0].environment[?name==`MYTHRUN_ENV` || name==`REGION_PREFIX` || name==`DB_USER`]}'
```

Expected:
- `rev: 1`
- `image: ...:placeholder`
- env list contains `MYTHRUN_ENV=staging`, `REGION_PREFIX=use1`, `DB_USER=mythrun_staging_migrate`

- [ ] **Step 4: Verify empty secret exists**

```bash
aws secretsmanager describe-secret --secret-id mythrun/staging/migrate-db-credentials --region us-east-1 \
  --query '{arn:ARN, versionStages:VersionIdsToStages}'
```

Expected: ARN is present; `VersionIdsToStages` is `null` (no AWSCURRENT yet — bootstrap-db populates it in Task 8).

---

### Task 8: Rebuild bootstrap-db image + run task to populate migrate secret

**Why:** The new `provision_migrate_user` function is in the bootstrap-db image; the staging cluster runs whatever image revision is pinned in `terraform.tfvars`'s `bootstrap_image_tag`. We need to rebuild the image with the new function and bump the tfvars.

- [ ] **Step 1: Push a commit to trigger bootstrap-db-build**

The bootstrap-db-build workflow already auto-fires on changes to `infra/scripts/bootstrap-databases.sh` (verified — see `.github/workflows/bootstrap-db-build.yml:7-10`). Task 4's commit should have already triggered it. Verify:

```bash
gh run list --workflow=bootstrap-db-build --limit 3
```

Expected: a recent run for the commit from Task 4, status `success`. If still in-progress, wait. If failed, debug.

- [ ] **Step 2: Read the bump line from the workflow's notice annotation**

The workflow's "Print operator bump command" step emits a `::notice::` with the line to paste into tfvars. Get it from the run page:

```bash
RUN_ID=$(gh run list --workflow=bootstrap-db-build --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --log | grep "bootstrap_image_tag" | head -3
```

Look for a line like:
`bootstrap_image_tag = "bootstrap-db-<sha>-<run_attempt>"`

- [ ] **Step 3: Update `terraform.tfvars` + re-apply**

Edit `infra/environments/staging/terraform.tfvars`, replace the existing `bootstrap_image_tag` line with the new one. Then:

```bash
cd infra/environments/staging
terraform plan -out=bootstrap.tfplan
# Expected: aws_ecs_task_definition.bootstrap_db must be replaced (image changed)
terraform apply -auto-approve bootstrap.tfplan
```

- [ ] **Step 4: Commit the tfvars bump**

```bash
git add infra/environments/staging/terraform.tfvars
git commit -m "infra(myth-4mlu): bump bootstrap_image_tag to include provision_migrate_user"
```

- [ ] **Step 5: Run bootstrap-db ECS task in default mode**

The TF outputs include the exact `aws ecs run-task` command:

```bash
cd infra/environments/staging
RUN_TASK_CMD=$(terraform output -raw bootstrap_db_run_task_default)
echo "$RUN_TASK_CMD"
# Inspect the command — should be `aws ecs run-task --cluster mythrun --task-definition mythrun-staging-bootstrap-db ...`
TASK_ARN=$(eval "$RUN_TASK_CMD" | jq -r '.tasks[0].taskArn')
echo "Started task: $TASK_ARN"
aws ecs wait tasks-stopped --cluster mythrun --tasks "$TASK_ARN" --region us-east-1
aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" --region us-east-1 \
  --query 'tasks[0].{exit:containers[0].exitCode, reason:containers[0].reason, stoppedReason:stoppedReason}'
```

Expected: `exit: 0`. The bootstrap script ran `verify_state` (likely returned OK since the app user is already provisioned), then called `provision_migrate_user`, which created the migrate user and populated the secret.

- [ ] **Step 6: Verify the migrate secret has AWSCURRENT**

```bash
aws secretsmanager describe-secret --secret-id mythrun/staging/migrate-db-credentials --region us-east-1 \
  --query '{versionStages:VersionIdsToStages}'
```

Expected: a UUID key mapped to `["AWSCURRENT"]`.

Also verify the JSON shape:

```bash
aws secretsmanager get-secret-value --secret-id mythrun/staging/migrate-db-credentials --region us-east-1 \
  --query SecretString --output text | jq 'keys'
```

Expected: `["password", "username"]` (don't print the values).

---

### Task 9: GHA env vars + workflow file

**Why:** The workflow needs two repo-level GitHub Environment vars (`PRIVATE_SUBNET_IDS`, `MIGRATE_SECURITY_GROUP_ID`) before it can run. Then commit the workflow file.

**Files:**
- Create: `.github/workflows/db-migrate.yml`

- [ ] **Step 1: Pull the SHA-pinned action versions from deploy.yml**

```bash
grep -n "uses:.*@" .github/workflows/deploy.yml | head -10
```

Copy the exact `@<sha> # <version>` strings for:
- `actions/checkout`
- `aws-actions/configure-aws-credentials`
- `aws-actions/amazon-ecs-render-task-definition`

You'll paste these into the workflow file in Step 4.

- [ ] **Step 2: Get the private subnet IDs**

```bash
cd infra/environments/staging
# Pull from TF state, or list from the AWS console under VPC → Subnets → mythrun-staging-private-*
terraform state show 'module.network.aws_subnet.private[0]' 2>/dev/null | grep '^\s*id ' | awk '{print $3}'
terraform state show 'module.network.aws_subnet.private[1]' 2>/dev/null | grep '^\s*id ' | awk '{print $3}'
```

If those don't return the IDs, list via CLI:

```bash
aws ec2 describe-subnets --region us-east-1 --filters Name=tag:Name,Values='mythrun-staging-private-*' \
  --query 'Subnets[].SubnetId' --output text
```

You'll get something like `subnet-0a3cbedc926460fa6 subnet-07ff5e9391c234651`. Format as comma-separated for the GHA var: `subnet-0a3cbedc926460fa6,subnet-07ff5e9391c234651`.

- [ ] **Step 3: Set the two env vars in the `staging` GitHub Environment**

Via web UI: Settings → Environments → staging → Environment variables → Add variable.

Set:
- `PRIVATE_SUBNET_IDS` = the comma-separated subnet IDs from Step 2
- `MIGRATE_SECURITY_GROUP_ID` = the value from `terraform output -raw migrate_security_group_id` (Task 7)

Or via CLI (requires `gh auth refresh -s admin:repo_hook`):

```bash
gh variable set PRIVATE_SUBNET_IDS --env staging --body "subnet-aaa,subnet-bbb"
gh variable set MIGRATE_SECURITY_GROUP_ID --env staging --body "sg-xxxxx"
```

Verify:

```bash
gh variable list --env staging
```

Expected: both vars present.

- [ ] **Step 4: Write `.github/workflows/db-migrate.yml`**

Use the action SHAs from Step 1. Replace `<CHECKOUT_SHA>`, `<AWS_CREDS_SHA>`, `<RENDER_TASKDEF_SHA>` below with the actual pinned commit SHAs.

```yaml
name: db-migrate

on:
  push:
    branches: [main]
    paths:
      - 'backend/migrations/*.sql'
      - '.github/workflows/db-migrate.yml'
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: db-migrate-staging
  cancel-in-progress: false

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
    timeout-minutes: 15
    environment: staging
    steps:
      - name: Pre-flight — verify required vars are set
        run: |
          set -euo pipefail
          for v in AWS_ACCOUNT_ID PRIVATE_SUBNET_IDS MIGRATE_SECURITY_GROUP_ID; do
            val="${!v:-}"
            if [[ -z "$val" ]]; then
              echo "::error::Required GH variable $v is not set on the staging environment."
              exit 1
            fi
          done
        env:
          AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
          PRIVATE_SUBNET_IDS: ${{ vars.PRIVATE_SUBNET_IDS }}
          MIGRATE_SECURITY_GROUP_ID: ${{ vars.MIGRATE_SECURITY_GROUP_ID }}

      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@<AWS_CREDS_SHA>
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Resolve image digest by commit SHA
        id: image
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
        run: |
          set -euo pipefail
          aws ecs describe-task-definition \
            --task-definition "${{ env.TASK_DEF_FAMILY }}" \
            --query 'taskDefinition' \
            > task-def.json

      - name: Render new task definition with digest image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@<RENDER_TASKDEF_SHA>
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ steps.image.outputs.digest_ref }}

      - name: Register new task definition revision
        id: register
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
          echo "task_id=$TASK_ID" >> "$GITHUB_OUTPUT"
          echo "log_stream=${CONTAINER_NAME}/${CONTAINER_NAME}/${TASK_ID}" >> "$GITHUB_OUTPUT"

      - name: Wait for task to stop
        run: |
          aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "${{ steps.runtask.outputs.task_arn }}"

      - name: Surface result + tail logs
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
            echo "::error::Migrate task failed to start. stoppedReason='$STOP_REASON' containerReason='$CONT_REASON'"
            {
              echo "## Migrate task failed to start"
              echo "- **stoppedReason:** $STOP_REASON"
              echo "- **containerReason:** $CONT_REASON"
              echo "- **taskArn:** ${{ steps.runtask.outputs.task_arn }}"
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi

          aws logs get-log-events \
            --log-group-name "$LOG_GROUP" \
            --log-stream-name "${{ steps.runtask.outputs.log_stream }}" \
            --limit 200 \
            --start-from-head false \
            --query 'events[*].message' --output text || true

          RUN_ID=$(aws logs get-log-events \
            --log-group-name "$LOG_GROUP" \
            --log-stream-name "${{ steps.runtask.outputs.log_stream }}" \
            --limit 1000 --start-from-head true \
            --query 'events[?contains(message, `migrate.start`)] | [0].message' --output text 2>/dev/null \
            | jq -r '.runId // ""' 2>/dev/null || echo "")

          {
            echo "## Migrate run details"
            echo "- **runId:** \`${RUN_ID:-unknown}\`"
            echo "- **taskArn:** ${{ steps.runtask.outputs.task_arn }}"
            echo "- **exitCode:** $EXIT"
            echo "- **logStream:** $LOG_GROUP / ${{ steps.runtask.outputs.log_stream }}"
          } >> "$GITHUB_STEP_SUMMARY"

          if [[ "$EXIT" != "0" ]]; then
            echo "::error::Migrate task exited $EXIT — runId=${RUN_ID:-unknown}, see CloudWatch $LOG_GROUP"
            exit 1
          fi
```

- [ ] **Step 5: Commit the workflow**

```bash
git add .github/workflows/db-migrate.yml
git commit -m "ci(myth-4mlu): db-migrate workflow (auto-on-push + dispatch)"
```

Hold on pushing until Task 10.

---

### Task 10: Push branch + first workflow_dispatch run

**Why:** Verify the workflow can run end-to-end against staging before any auto-fire. The first run applies migrations 007 + 008 to staging RDS.

- [ ] **Step 1: Push all commits so far**

```bash
git push origin main
```

The push includes commits from Tasks 1-9. The `Deploy` workflow auto-fires (since backend src changed); the `db-migrate` workflow does NOT auto-fire (the migration files themselves haven't changed). Watch Deploy:

```bash
gh run list --workflow=Deploy --limit 1
```

Wait for Deploy to be green. (If Deploy goes red on the new boot-gate probe, that's expected — Task 11 is exactly the fix.)

Actually — Deploy WILL go red here because the boot-gate now refuses to boot against a DB that's missing 007 + 008. That's the point. Continue to Step 2.

- [ ] **Step 2: Trigger db-migrate via workflow_dispatch**

```bash
gh workflow run db-migrate
sleep 6
RUN_ID=$(gh run list --workflow=db-migrate --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Run ID: $RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

Expected: `✓ migrate in <Ns>` (typically 60-180s for 2 pending migrations against a small staging DB).

If the run fails:
- `exitCode: null` → check `stoppedReason`/`containerReason` annotations in the workflow log. Likely ENI/image-pull issue. Verify the image with `imageTag=${{ github.sha }}` exists in ECR.
- `exitCode: 1` (fetch failed) → check CloudWatch `/mythrun/staging/migrate` logs.
- `exitCode: 1` with a 42501 (insufficient_privilege) → the migrate user doesn't have ALTER rights. Verify the `GRANT mythrun_staging TO mythrun_staging_migrate` ran during bootstrap (re-run bootstrap-db with `--reset-migrate-password` to re-issue grants).

- [ ] **Step 3: Verify _migrations table has 8 rows**

Easiest path: have the next Deploy succeed and check via the API's logs (the boot-gate probe logs `✓ migrations-current verified` on success). Or run a one-off SQL via bootstrap-db's verify mode (not a feature today — defer).

Alternative: trigger `db-migrate` again and watch the log for "no migrations to apply" (idempotent re-run confirms the previous run completed):

```bash
gh workflow run db-migrate
sleep 6
RUN_ID=$(gh run list --workflow=db-migrate --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep -E "migrate.applied|migrate.no_pending|no migrations" | head -5
```

Expected log lines: `migrate.no_pending` or similar (the runner logs structured events).

---

### Task 11: Re-trigger Deploy to roll the API onto the new boot-gate

**Why:** The boot-gate code is shipped in the new image, but the running API is on whatever revision shipped before this change. Trigger a Deploy to roll it. Boot-gate should now pass (DB has all 8 migrations applied).

- [ ] **Step 1: Trigger Deploy via workflow_dispatch**

```bash
gh workflow run Deploy
sleep 6
RUN_ID=$(gh run list --workflow=Deploy --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expected: green. The deploy-staging job's boot-gate sees `_migrations` with 8 rows, all matching the image's 8 SQL files, passes.

- [ ] **Step 2: Verify the running task is on the new revision**

```bash
aws ecs describe-services --cluster mythrun --services mythrun-staging-api --region us-east-1 \
  --query 'services[0].{running:runningCount, desired:desiredCount, td:taskDefinition, lastEvent:events[0].message}'
```

Expected: `running: 1, desired: 1`, task definition revision incremented, last event `has reached a steady state.`

- [ ] **Step 3: Hit the /health endpoint**

```bash
curl -s -o /dev/null -w "HTTP %{http_code} (%{time_total}s)\n" https://staging-api.mythrun.com/health
```

Expected: `HTTP 200`.

- [ ] **Step 4: Pull the boot log line for the probe**

```bash
aws logs tail /mythrun/staging/api --since 10m --region us-east-1 --filter-pattern "migrations-current verified"
```

Expected: at least one matching log line for the new task.

---

### Task 12: Document GHA env vars + close the loop

**Why:** Future operators standing up a new env (or rotating the migrate secret) need to know which GitHub Environment variables exist. The wiki already documents infra workflows; add a small note.

**Files:**
- Modify: `docs/wiki/content/infra/ci-cd.html` (or wherever the workflow inventory lives)

- [ ] **Step 1: Identify the right wiki page**

```bash
grep -rln "deploy.yml\|gh-actions\|GitHub Actions" docs/wiki/content/ | head -5
```

The hits are likely under `docs/wiki/content/infra/ci-cd.html` and possibly `docs/wiki/content/auth-billing/billing-metering.html` for the price-check workflow. The migration runner belongs alongside Deploy in `infra/ci-cd.html`.

- [ ] **Step 2: Add a section to the CI/CD page**

Add a new `<section>` describing `db-migrate.yml` — triggers, required GHA env vars (`PRIVATE_SUBNET_IDS`, `MIGRATE_SECURITY_GROUP_ID`), the boot-gate interlock, and a one-line link to the design spec. The wiki uses HTML with rationale callouts; mirror the existing surrounding section style.

You'll need to also add a source declaration at the top of the page:

```html
<!-- source: .github/workflows/db-migrate.yml -->
<!-- source: backend/src/boot/migrations-current.ts -->
```

- [ ] **Step 3: Rebuild + accept-drift**

```bash
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:build
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:accept-drift
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun pnpm wiki:check
```

Expected: all three exit 0.

- [ ] **Step 4: Format pass + commit**

```bash
pnpm format:check || pnpm exec prettier --write 'docs/wiki/content/infra/ci-cd.html'
git add docs/wiki/content/infra/ci-cd.html
git commit -m "docs(wiki): document db-migrate workflow + required GHA env vars"
git push origin main
```

- [ ] **Step 5: Close myth-4mlu**

```bash
bd close myth-4mlu --reason "Migration runner shipped: db-migrate.yml workflow + boot-gate probe + provision_migrate_user + TF infra. Applied to staging, migrations 007+008 landed, Deploy boot-gate verified green. Wiki updated."
```

---

## Acceptance criteria (mirror of spec §11)

- [ ] `gh workflow run db-migrate` against staging applies pending migrations and exits green
- [ ] A push to main that adds a new `backend/migrations/*.sql` file auto-fires `db-migrate.yml` and reaches green
- [ ] Deploy against a staging API container whose image carries unapplied migrations produces `rolloutState=FAILED` with the boot-gate error clearly identifying which migrations are pending (verified by inspecting CloudWatch logs from a previous failed attempt)
- [ ] `bootstrap-db --reset-migrate-password` rotates the secret cleanly and the next migrate workflow run authenticates successfully
- [ ] `mythrun_staging_migrate` user exists with `rds_superuser` membership AND membership in `mythrun_staging` (the app user role)
- [ ] Wiki has a section documenting the workflow + required GHA env vars

---

## Self-review notes

**Spec coverage check:**
- §4.1 task def → Task 5 ✓
- §4.2 workflow → Task 9 ✓
- §4.3 probe → Tasks 1, 2, 3 ✓
- §4.4 Dockerfile (no changes — existing pattern works) → covered in Task 2 path-resolution comment ✓
- §4.5 bootstrap-db extension → Task 4 ✓
- §4.6 IAM (3 surfaces) → Task 5 (execution + task roles) + Task 6 (OIDC) ✓
- §5 production scope → flagged in spec as deferred; no plan task ✓
- §6 failure modes → covered by Task 9's workflow logic (stoppedReason handling) + Task 2's probe error messages ✓
- §7 testing → Task 2 (probe unit), Task 3 (server boot-gate scenario), Task 10 (manual smoke) ✓
- §10 first-apply runbook → Tasks 7, 8, 10, 11 walk through it ✓
- §11 acceptance criteria → mirrored above ✓

**Placeholder scan:** no "TBD", "TODO", "implement later" in any task. All steps have concrete code or commands.

**Type consistency:** `probeMigrationsCurrent(pool: Pool)` signature is consistent across Tasks 2, 3. `MIGRATION_FILE_RE` exported from `migration-filename.ts` is imported by name in both consumers (Tasks 1, 2). Secret ARN reference `${aws_secretsmanager_secret.migrate_db_credentials.arn}:password::` is consistent between TF (Task 5) and the GHA workflow (Task 9).
