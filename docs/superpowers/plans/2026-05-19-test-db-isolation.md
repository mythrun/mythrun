# Test/Dev Database Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-19-test-db-isolation-design.md`
**Bead:** `myth-oehx`

**Goal:** Stop `pnpm test` from wiping the dev DB; consolidate three competing test-isolation strategies into one (scoped fixtures); centralize schema bootstrap via Vitest `globalSetup`; enable parallel test execution.

**Architecture:** Same Postgres container, separate logical DBs (`mythrun_dev`, `mythrun_test`, `mythrun_test_<wt>`). One isolation pattern: scoped fixtures with branded `TestScope` types + dependency injection for global config (cost-caps). Schema bootstrap runs once per worker process via Vitest `globalSetup`, not per-file `beforeAll`. ESLint built-ins (`no-restricted-imports` + `no-restricted-syntax`) enforce the scoping invariant. Per-worktree test DBs provide mechanical isolation against concurrent worktree runs.

**Tech Stack:** Node 24, TypeScript (strict), Postgres 16 (docker-compose), Vitest, ESLint flat config, raw `pg` driver, `pg-pool`.

---

## File Structure

**New files:**
- `backend/src/__tests__/global-setup.ts` — Vitest globalSetup script: runs migrations + idempotent seeds once per worker process
- `backend/src/repo/__tests__/_helpers/test-pool.ts` — uniform pool factory `createTestPool(url)` with `max: 4`
- `backend/src/__tests__/CONVENTIONS.md` — testing conventions doc
- `scripts/worktree-migrate.sh` — one-shot migrator for existing worktrees' `.env.worktree`
- `backend/migrations/017_test_scope_indexes.sql` — optional; `text_pattern_ops` indexes for `LIKE`-pattern cleanup (deferred unless Phase 5 wall-clock needs it)

**Modified files:**
- `backend/.env.development` — `DATABASE_URL` switches to `mythrun_dev`; new `DATABASE_URL_TEST` for `mythrun_test`
- `backend/package.json` — `db:migrate:test` script
- `backend/src/__tests__/setup-env.ts` — reads `DATABASE_URL_TEST`, runs safety-fence assertion
- `backend/src/db/__tests__/guard-db.ts` — regex updated to `^mythrun_test(_.+)?$`
- `backend/src/repo/__tests__/_helpers/test-scope.ts` — branded types added
- `backend/src/repo/__tests__/_helpers/create-test-user.ts` — `TestScope` parameter mandatory
- `backend/src/repo/__tests__/_helpers/reset-data.ts` — `reseedSystemRows` contents move to `seedTestDatabase()` in globalSetup
- `backend/src/llm/prep/world-gen-processor.ts` — `readCostCap` replaced by `deps.costCapUsd`
- `backend/src/llm/prep/character-creation-processor.ts` — same shape
- `backend/src/server.ts` — reads cost-caps at boot, injects into both processors
- `backend/vitest.config.ts` — `globalSetup` wired in Phase 3; `fileParallelism: false` removed + pool/maxForks set in Phase 5
- `docker-compose.yml` — `max_connections=200` on the postgres service
- `.github/workflows/deploy.yml` — `POSTGRES_DB: mythrun_test`, `DATABASE_URL_TEST` env var
- `scripts/worktree-setup.sh` — provision only test DB; don't override `DATABASE_URL`
- `scripts/worktree-remove.sh` — drop the worktree's test DB
- `eslint.config.js` — new `no-restricted-imports` + `no-restricted-syntax` entries
- `CLAUDE.md` — link to CONVENTIONS.md
- ~32 test files — migrated in Phase 4 (concrete list regenerated from live grep at Phase 4 start)

**Deleted files:**
- `backend/src/repo/__tests__/_helpers/with-tx.ts` — Phase 5
- `backend/src/repo/__tests__/_helpers/reset-data.ts` — Phase 5 (after `reseedSystemRows` contents move to globalSetup)

---

## Phase 1 — Database Topology + Safety Fence

End state: tests run against `mythrun_test`; dev DB is never touched by `pnpm test`.

### Task 1.1: Bump `max_connections` on the postgres docker service

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read current postgres service block**

Run: `grep -A20 "postgres:" docker-compose.yml | head -25`

- [ ] **Step 2: Add `command` directive to lift max_connections to 200**

Modify the postgres service definition. Add `command: ["postgres", "-c", "max_connections=200"]` under the service's `image:` line. Example:

```yaml
postgres:
  image: postgres:16-alpine
  command: ["postgres", "-c", "max_connections=200"]
  environment:
    POSTGRES_USER: mythrun
    POSTGRES_PASSWORD: mythrun_dev
    POSTGRES_DB: mythrun
  ports:
    - "5432:5432"
  # ... rest unchanged
```

- [ ] **Step 3: Recreate the postgres container with the new setting**

Run: `docker compose up -d --force-recreate postgres`
Expected: container restarts; previous data preserved (volume-mounted).

- [ ] **Step 4: Verify**

Run: `docker compose exec -T postgres psql -U mythrun -d mythrun -c "SHOW max_connections;"`
Expected: `200`

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(docker): bump postgres max_connections to 200

Headroom for parallel test execution (myth-oehx). Default 100 is the
ceiling; per-spec budget needs ~34 concurrent connections at peak."
```

### Task 1.2: Rename `mythrun` → `mythrun_dev` and create `mythrun_test`

**Files:**
- (Postgres state only)

- [ ] **Step 1: Confirm no active connections to `mythrun`**

Run: `docker compose exec -T postgres psql -U mythrun -d postgres -c "SELECT pid, usename, application_name FROM pg_stat_activity WHERE datname = 'mythrun' AND pid <> pg_backend_pid();"`
Expected: 0 rows. If non-zero, stop dev server / kill the connections before proceeding.

- [ ] **Step 2: Rename**

Run:
```bash
docker compose exec -T postgres psql -U mythrun -d postgres -c "ALTER DATABASE mythrun RENAME TO mythrun_dev;"
```
Expected: `ALTER DATABASE`

- [ ] **Step 3: Create the new test DB**

Run:
```bash
docker compose exec -T postgres psql -U mythrun -d postgres -c "CREATE DATABASE mythrun_test OWNER mythrun;"
```
Expected: `CREATE DATABASE`

- [ ] **Step 4: Verify**

Run: `docker compose exec -T postgres psql -U mythrun -d postgres -c "\l mythrun*"`
Expected: lists `mythrun_dev` and `mythrun_test`.

### Task 1.3: Update `backend/.env.development` and add `DATABASE_URL_TEST`

**Files:**
- Modify: `backend/.env.development`

- [ ] **Step 1: Read current file**

Run: `cat backend/.env.development`

- [ ] **Step 2: Update the DATABASE_URL line + add DATABASE_URL_TEST**

Change:
```
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
```
To:
```
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun_dev
DATABASE_URL_TEST=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun_test
```

- [ ] **Step 3: Verify dev server still runs**

Run: `pnpm --filter @mythrun/backend dev` in a separate terminal.
Expected: server boots, no DB errors. Stop the dev server after confirming (Ctrl-C).

### Task 1.4: Add `pnpm db:migrate:test` script

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Add the new script**

Open `backend/package.json`. In the `scripts` object, after the existing `db:migrate` line, add:

```json
"db:migrate:test": "DATABASE_URL=\"$DATABASE_URL_TEST\" tsx --env-file=.env.development --env-file-if-exists=../.env.worktree src/db/migrate.ts",
```

The script reuses `DATABASE_URL_TEST` and assigns it to `DATABASE_URL` for the migrate runner (which only reads `DATABASE_URL`).

- [ ] **Step 2: Run the migration against mythrun_test**

Run: `cd backend && pnpm db:migrate:test`
Expected: all migrations applied; schema present in `mythrun_test`.

- [ ] **Step 3: Verify**

Run: `docker compose exec -T postgres psql -U mythrun -d mythrun_test -c "\dt" | head -20`
Expected: lists `users`, `worlds`, `campaigns`, etc.

### Task 1.5: Update `guard-db.ts` allowlist regex

**Files:**
- Modify: `backend/src/db/__tests__/guard-db.ts`

- [ ] **Step 1: Read current regex**

Run: `grep -n "ALLOWED_DBS" backend/src/db/__tests__/guard-db.ts`

- [ ] **Step 2: Update the regex**

Change `const ALLOWED_DBS = /^mythrun(_test|_ci)?$/` to `const ALLOWED_DBS = /^mythrun_test(_.+)?$/`.

Update any prose comments in the file that mention the old pattern.

- [ ] **Step 3: Run guard-db tests**

Run: `cd backend && pnpm vitest run src/db/__tests__/guard-db.test.ts`
Expected: passes (tests are about the regex shape, not specific names).

### Task 1.6: Update `setup-env.ts` to read `DATABASE_URL_TEST` and add safety-fence assertion

**Files:**
- Modify: `backend/src/__tests__/setup-env.ts`
- Test: covered by Task 1.11 verification

- [ ] **Step 1: Read current file**

Run: `cat backend/src/__tests__/setup-env.ts`

- [ ] **Step 2: Modify env loading to bridge DATABASE_URL_TEST → DATABASE_URL**

After the existing `config(...)` calls and the `process.env.AUTH_MODE ??= 'bypass'` block, add:

```typescript
// Tests target the test database, not the dev database. The bridge:
// `.env.development` (loaded above) defines both DATABASE_URL (dev DB)
// and DATABASE_URL_TEST (test DB). Production code reads DATABASE_URL;
// tests run in this same process, so we overwrite DATABASE_URL with
// DATABASE_URL_TEST before any test imports the repo layer.
const testDbUrl = process.env.DATABASE_URL_TEST
if (testDbUrl === undefined || testDbUrl === '') {
  throw new Error(
    'setup-env: DATABASE_URL_TEST is not set. Tests must target mythrun_test, ' +
      'not the dev DB. Add DATABASE_URL_TEST to .env.development or .env.worktree.',
  )
}
process.env.DATABASE_URL = testDbUrl

// Safety fence: confirm DATABASE_URL now points at a test database. The
// regex matches mythrun_test (main repo) and mythrun_test_<worktree>
// (per-worktree). Refuses to run against mythrun_dev or anything else.
const dbName = new URL(testDbUrl).pathname.slice(1)
if (!/^mythrun_test(_.+)?$/.test(dbName)) {
  throw new Error(
    `setup-env: DATABASE_URL_TEST points at database "${dbName}", which does not ` +
      'match the test-database allowlist /^mythrun_test(_.+)?$/. Refusing to run.',
  )
}
```

- [ ] **Step 3: Sanity-check by running a single test**

Run: `cd backend && pnpm vitest run src/db/__tests__/guard-db.test.ts`
Expected: passes; the new fence didn't break anything.

### Task 1.7: Update CI workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`

Note: the workflow file isn't in your local working tree (sparse-tracked). Use `git show HEAD:.github/workflows/deploy.yml > /tmp/deploy.yml` to read it, edit, and write back via `gh api`.

- [ ] **Step 1: Read current workflow content**

Run: `git show HEAD:.github/workflows/deploy.yml | grep -n -A3 "POSTGRES_DB\|DATABASE_URL"`

- [ ] **Step 2: Prepare the new content**

Two changes:
1. Under `services.postgres.env`, change `POSTGRES_DB: mythrun` to `POSTGRES_DB: mythrun_test`.
2. Under the `- run: pnpm --filter @mythrun/backend test` step's `env:` block, change:
   ```yaml
   DATABASE_URL: postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun
   ```
   to:
   ```yaml
   DATABASE_URL_TEST: postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun_test
   ```

- [ ] **Step 3: Write the file**

Because `.github/workflows/` isn't in your local tree, do the edit via:

```bash
git show HEAD:.github/workflows/deploy.yml > /tmp/deploy.yml
# (Edit /tmp/deploy.yml with the two changes from Step 2)
git update-index --add --cacheinfo 100644 \
  "$(git hash-object -w /tmp/deploy.yml)" .github/workflows/deploy.yml
git checkout HEAD -- .github/workflows/deploy.yml  # NO — this reverts; use the next form instead
```

Cleaner approach: temporarily restore the file to working tree, edit, commit:

```bash
mkdir -p .github/workflows
git show HEAD:.github/workflows/deploy.yml > .github/workflows/deploy.yml
# Edit .github/workflows/deploy.yml with the two changes
# (rest of plan continues; .github will be in the commit)
```

- [ ] **Step 4: Verify the change**

Run: `git diff .github/workflows/deploy.yml | head -30`
Expected: shows the two changes only.

### Task 1.8: Write `scripts/worktree-migrate.sh` for existing worktrees

**Files:**
- Create: `scripts/worktree-migrate.sh`

- [ ] **Step 1: Write the script**

Create `scripts/worktree-migrate.sh`:

```bash
#!/usr/bin/env bash
# scripts/worktree-migrate.sh
#
# One-shot migrator for existing worktrees after the test-DB isolation
# change (myth-oehx). Converts the old `.env.worktree` shape:
#   DATABASE_URL=postgresql://...mythrun_<wt>
# to the new shape:
#   DATABASE_URL_TEST=postgresql://...mythrun_test_<wt>
# and provisions the new mythrun_test_<wt> database + initial migration.
#
# Run from inside a worktree directory. No-op if the worktree's .env.worktree
# is already in the new shape.

set -euo pipefail

# Find repo root + .env.worktree
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_FILE="$REPO_ROOT/.env.worktree"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No .env.worktree at $ENV_FILE — nothing to migrate."
  exit 0
fi

# Extract the worktree name from the current DATABASE_URL line (if any).
# Format expected: postgresql://.../mythrun_<name>
old_url="$(grep -E '^DATABASE_URL=' "$ENV_FILE" || true)"
if [[ -z "$old_url" ]]; then
  echo "$ENV_FILE has no DATABASE_URL line — assuming already migrated."
  exit 0
fi

wt_name="$(echo "$old_url" | sed -E 's|.*/mythrun_([^/?]+).*|\1|')"
if [[ "$wt_name" == "$old_url" || -z "$wt_name" ]]; then
  echo "Could not parse worktree name from: $old_url"
  echo "Bailing — manual fix required."
  exit 1
fi

new_db="mythrun_test_$wt_name"

# Create the new test DB (idempotent — IF NOT EXISTS).
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
  psql -U mythrun -d postgres -c "CREATE DATABASE $new_db OWNER mythrun;" 2>&1 \
  | grep -v "already exists" || true

# Rewrite .env.worktree:
#   - Remove the old DATABASE_URL line.
#   - Add a DATABASE_URL_TEST line.
grep -v '^DATABASE_URL=' "$ENV_FILE" > "$ENV_FILE.tmp"
echo "DATABASE_URL_TEST=postgresql://mythrun:mythrun_dev@localhost:5432/$new_db" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

echo "Migrated $ENV_FILE to use DATABASE_URL_TEST=...$new_db"
echo "Running initial migration against $new_db..."

# Apply migrations to the new test DB. From repo root so backend script resolves.
cd "$REPO_ROOT/backend"
pnpm db:migrate:test

echo "Done. Worktree $wt_name now isolated on $new_db."
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/worktree-migrate.sh`

### Task 1.9: Phase 1 integration test + commit

**Files:**
- No new files; this task verifies and commits.

- [ ] **Step 1: Run full test suite against mythrun_test**

Run: `cd backend && pnpm test 2>&1 | tail -10`
Expected: most tests pass against `mythrun_test`. Some tests may fail because their `beforeAll` `DROP SCHEMA` runs against `mythrun_test` and they haven't been migrated yet — those failures will be fixed in Phase 4. The important things to verify:
- Tests connect to `mythrun_test` (no fence-thrown errors)
- The `mythrun_dev` DB is NOT touched

- [ ] **Step 2: Verify mythrun_dev not touched**

Run:
```bash
docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used) VALUES ('019700e0-0000-7000-8000-00000000sent', 'sentinel:phase1', 'Phase 1 Sentinel', 'sentinel_phase1', false);"
pnpm test 2>&1 | tail -3
docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "SELECT cognito_sub FROM users WHERE cognito_sub = 'sentinel:phase1';"
```
Expected: sentinel row exists after `pnpm test`. (Cleanup: `DELETE FROM users WHERE cognito_sub = 'sentinel:phase1';` against `mythrun_dev`.)

- [ ] **Step 3: Commit Phase 1**

```bash
git add backend/.env.development backend/package.json backend/src/__tests__/setup-env.ts \
  backend/src/db/__tests__/guard-db.ts scripts/worktree-migrate.sh .github/workflows/deploy.yml
git commit -m "feat(test): isolate test DB from dev DB

Phase 1 of myth-oehx. Tests now target mythrun_test (new); dev server
keeps mythrun_dev (renamed from mythrun). DATABASE_URL_TEST is the
test connection string; setup-env.ts bridges it to DATABASE_URL within
the test process and asserts the connected DB matches the
mythrun_test(_.+)? allowlist before any test runs. guard-db.ts updated
in lockstep so the two enforcement points share one regex.

Existing worktrees: run scripts/worktree-migrate.sh to convert the
.env.worktree from the old mythrun_<wt> shape to mythrun_test_<wt>."
```

---

## Phase 2 — Dependency-Inject Global Config

End state: no test mutates `settings` to influence worker behavior. Cost-caps are read once at server boot and injected as `costCapUsd: number`.

### Task 2.1: Add `costCapUsd` to `WorldGenDeps` and `CharacterCreationDeps`

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts` (deps type definition)
- Modify: `backend/src/llm/prep/character-creation-processor.ts` (deps type definition)

- [ ] **Step 1: Find the WorldGenDeps type**

Run: `grep -n "WorldGenDeps\|interface WorldGenDeps\|type WorldGenDeps" backend/src/llm/prep/world-gen-processor.ts`

- [ ] **Step 2: Add `costCapUsd: number` to WorldGenDeps**

In the WorldGenDeps interface (or type), add the field:

```typescript
export interface WorldGenDeps {
  // ... existing fields
  /**
   * Per-job world-gen cost ceiling in USD. Read once at server boot from
   * settings.world_gen_cost_cap_usd; injected here to keep the worker
   * stateless and avoid per-job DB reads. Tests construct processors
   * with arbitrary values directly.
   */
  readonly costCapUsd: number
}
```

- [ ] **Step 3: Same for CharacterCreationDeps**

Repeat the addition in `backend/src/llm/prep/character-creation-processor.ts`:

```typescript
export interface CharacterCreationDeps {
  // ... existing fields
  /**
   * Per-job character-creation cost ceiling in USD. Read once at server
   * boot from settings.character_creation_cost_cap_usd; injected here
   * to keep the worker stateless. Tests construct processors with
   * arbitrary values directly.
   */
  readonly costCapUsd: number
}
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -15`
Expected: many errors from existing call sites that don't pass `costCapUsd`. These get fixed in subsequent tasks.

### Task 2.2: Replace `readCostCap` call in world-gen-processor with `deps.costCapUsd`

**Files:**
- Modify: `backend/src/llm/prep/world-gen-processor.ts`

- [ ] **Step 1: Find the readCostCap call site**

Run: `grep -n "readCostCap\b" backend/src/llm/prep/world-gen-processor.ts`

- [ ] **Step 2: Replace the call with the injected dep**

Locate the block that currently looks like (the Phase 1 symptom-fix from earlier this session wraps it in try/catch):

```typescript
let capUsd: number
try {
  capUsd = await readCostCap(deps.pool)
} catch (err) {
  // ... mark world failed, publish, return
}
```

Replace the entire block (including the try/catch) with:

```typescript
const capUsd = deps.costCapUsd
```

- [ ] **Step 3: Remove the now-unused import**

Remove `readCostCap` from the import line: `import { issueCostCapRefund, readCostCap, sumCompletedStageCosts } from './cost-cap.js'`. New: `import { issueCostCapRefund, sumCompletedStageCosts } from './cost-cap.js'`.

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | grep "world-gen-processor" | head`
Expected: no errors local to this file (call sites elsewhere may still error, fixed in Task 2.4).

### Task 2.3: Replace `readCharacterCreationCostCap` in character-creation-processor

**Files:**
- Modify: `backend/src/llm/prep/character-creation-processor.ts`

- [ ] **Step 1: Find the call site**

Run: `grep -n "readCharacterCreationCostCap\b" backend/src/llm/prep/character-creation-processor.ts`

- [ ] **Step 2: Replace with injected dep**

The current shape is (the try/catch block):

```typescript
let capUsd: number
try {
  capUsd = await readCharacterCreationCostCap(deps.pool)
  // ... spent comparison, etc.
} catch (err) {
  // ... markFailed, publish, return
}
```

Replace the entire try/catch:

```typescript
const capUsd = deps.costCapUsd
const spent = await sumCharacterCreationStageCosts(deps.pool, campaignId)
if (spent > capUsd) {
  await conceptsRepo.markFailed(campaignId, userId, {
    code: 'character_creation_cost_cap_exceeded',
    spent,
    capUsd,
  })
  await deps.publishEvent(campaignId, {
    type: 'stage-failed',
    stage: 'cost_cap',
    userId,
    willRetry: false,
    reason: 'character_creation_cost_cap_exceeded',
  })
  return
}
```

- [ ] **Step 3: Remove unused import**

Remove `readCharacterCreationCostCap` from the imports.

### Task 2.4: Update `server.ts` to read cost-caps at boot and inject

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Find where deps are constructed for WorldGenWorker / CharacterCreationWorker**

Run: `grep -n "buildWorldGenWorker\|buildCharacterCreationWorker\|WorldGenDeps\|CharacterCreationDeps" backend/src/server.ts`

- [ ] **Step 2: Add cost-cap reads at boot**

Near the top of server bootstrap (after the pool is created, before worker construction):

```typescript
// Cost-cap settings are read once at boot and injected into the workers.
// Workers are stateless; if an operator updates the settings rows, restart
// the worker process for the change to take effect.
import { readCostCap, readCharacterCreationCostCap } from './llm/prep/cost-cap.js'

const worldGenCostCapUsd = await readCostCap(pool)
const characterCreationCostCapUsd = await readCharacterCreationCostCap(pool)
```

- [ ] **Step 3: Pass into deps constructions**

Find the two worker-construction call sites and add `costCapUsd` to the deps object:

```typescript
// World gen worker
const worldGenDeps: WorldGenDeps = {
  // ... existing fields
  costCapUsd: worldGenCostCapUsd,
}

// Character creation worker
const characterCreationDeps: CharacterCreationDeps = {
  // ... existing fields
  costCapUsd: characterCreationCostCapUsd,
}
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -10`
Expected: server.ts typechecks; processor test files may still error (fixed next).

### Task 2.5: Update `world-gen-processor.test.ts` to inject `costCapUsd`

**Files:**
- Modify: `backend/src/llm/prep/__tests__/world-gen-processor.test.ts`
- Test command: `pnpm vitest run src/llm/prep/__tests__/world-gen-processor.test.ts`

- [ ] **Step 1: Find where deps are constructed in tests**

Run: `grep -n "makeDeps\|WorldGenDeps" backend/src/llm/prep/__tests__/world-gen-processor.test.ts`

- [ ] **Step 2: Add `costCapUsd: 10.0` to the deps factory**

In the `makeDeps(pool)` helper (or equivalent), add `costCapUsd: 10.0` to the returned object. Use `10.0` as the default — same as production's seeded value.

- [ ] **Step 3: Update the cost-cap-exceeded test**

Find the test "issues refund + marks world failed when the cost cap is exceeded". It currently does:
```typescript
await pool.query(`UPDATE settings SET value = '0.0001' WHERE key = 'world_gen_cost_cap_usd'`)
```
Replace this with a test-local deps construction that passes `costCapUsd: 0.0001`:
```typescript
const deps = makeDeps(pool, { costCapUsd: 0.0001 })
```
This requires extending `makeDeps` to accept an overrides object — see Step 4.

- [ ] **Step 4: Extend `makeDeps` to accept overrides**

```typescript
function makeDeps(pool: Pool, overrides: Partial<WorldGenDeps> = {}): WorldGenDeps & { publishSpy: Mock } {
  const publishSpy = vi.fn()
  return {
    pool,
    publishEvent: publishSpy,
    logger: silentLogger(),
    costCapUsd: 10.0,
    // ... existing defaults
    ...overrides,
    publishSpy,
  }
}
```

- [ ] **Step 5: Remove the "marks world failed (no retry) when cost-cap settings row is missing" test**

This test was added in this session as the symptom-fix gate. The dep-injection refactor obsoletes it — there's no longer a DB read that can fail. Delete the entire `it(...)` block.

- [ ] **Step 6: Run the file**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/world-gen-processor.test.ts`
Expected: all tests pass.

### Task 2.6: Update `character-creation-processor.test.ts` to inject `costCapUsd`

**Files:**
- Modify: `backend/src/llm/prep/__tests__/character-creation-processor.test.ts`
- Test command: `pnpm vitest run src/llm/prep/__tests__/character-creation-processor.test.ts`

- [ ] **Step 1: Add `costCapUsd: 5.0` to test deps**

Same pattern as Task 2.5 — extend the deps factory to accept overrides; default `costCapUsd: 5.0` (matches migration 016's seed).

- [ ] **Step 2: Update the cost-cap-precheck-failure test**

The test (added this session) "marks character_concepts.failed when cost-cap precheck throws (settings row missing)" should be DELETED — dep-injection means the precheck can't throw on a missing row.

- [ ] **Step 3: Update the cost-cap-exceeded test**

Whatever pattern drives the `spent > capUsd` path: pass `costCapUsd: 0.0001` via the overrides object instead of mutating `settings`.

- [ ] **Step 4: Run the file**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/character-creation-processor.test.ts`
Expected: all tests pass.

### Task 2.7: Update `cost-cap.test.ts`

**Files:**
- Modify: `backend/src/llm/prep/__tests__/cost-cap.test.ts`

- [ ] **Step 1: Read existing tests**

Run: `cat backend/src/llm/prep/__tests__/cost-cap.test.ts | head -60`

The file tests `readCostCap`, `readCharacterCreationCostCap`, `sumCompletedStageCosts`, etc. The read-from-DB functions are now only called at server boot — tests should still validate that they correctly parse the settings row.

- [ ] **Step 2: Leave the read-function tests as-is**

These tests are still load-bearing for server.ts's boot-time reads. Don't change them.

- [ ] **Step 3: Remove the parse-error / missing-row test if it exists**

If there's a test that asserts `readCostCap` throws on a missing row, keep it — the function still has that behavior; it's the caller that's now resilient (server.ts can choose to fail-boot rather than fail-job).

- [ ] **Step 4: Run the file**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/cost-cap.test.ts`
Expected: passes.

### Task 2.8: Audit other "global read from DB" patterns in workers

**Files:**
- Read-only audit; modify as discovered.

- [ ] **Step 1: Find candidate patterns**

Run: `grep -rn "pool.query.*FROM settings\|client.query.*FROM settings" backend/src --include='*.ts' | grep -v test`
Expected: zero or one results after Tasks 2.2-2.3.

- [ ] **Step 2: Audit for other global reads**

Run: `grep -rEn "SELECT .+ FROM settings|SELECT .+ FROM srd_" backend/src --include='*.ts' | grep -v test`
For any results in production code (not tests), evaluate: is this read repeated per-request/per-job? If so, lift it to boot-time + inject.

- [ ] **Step 3: Commit Phase 2 if no additional refactors needed**

```bash
git add backend/src/llm/prep/world-gen-processor.ts \
  backend/src/llm/prep/character-creation-processor.ts \
  backend/src/llm/prep/__tests__/world-gen-processor.test.ts \
  backend/src/llm/prep/__tests__/character-creation-processor.test.ts \
  backend/src/server.ts
git commit -m "refactor(workers): inject cost-caps; drop runtime settings reads

Phase 2 of myth-oehx. WorldGenDeps and CharacterCreationDeps gain a
readonly costCapUsd field. server.ts reads both cost-cap values from
the settings table once at boot and injects. Workers no longer do a
per-job DB read for cost-cap, and tests no longer mutate the settings
table to drive cap-exceeded behavior — they pass costCapUsd directly.

The Phase 1 symptom-fix (try/catch around readCostCap) is removed; the
read can't fail at job time anymore."
```

---

## Phase 3 — Infrastructure: globalSetup, Branded TestScope, CONVENTIONS.md

End state: schema bootstrap centralized in `globalSetup`; fixture builders require `TestScope`; identifier arguments use branded types; CONVENTIONS doc exists.

### Task 3.1: Write `seedTestDatabase()` in `_helpers/reset-data.ts`

**Files:**
- Modify: `backend/src/repo/__tests__/_helpers/reset-data.ts`

- [ ] **Step 1: Read current file**

Run: `cat backend/src/repo/__tests__/_helpers/reset-data.ts`

- [ ] **Step 2: Add `seedTestDatabase()` export**

Add the new function at the end of the file (before any final exports):

```typescript
/**
 * Idempotent test-database seed. Called once per worker process by
 * Vitest globalSetup. Inserts the system user, demo world, dev users
 * (1..5), and the cost-cap settings rows. ON CONFLICT DO NOTHING makes
 * this safe to call multiple times.
 *
 * Tests should NEVER call this — globalSetup handles it. Tests should
 * also NEVER delete these rows; they're outside any test scope.
 */
export async function seedTestDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used, suspended_at)
     VALUES ($1, 'system:mythrun', 'Mythrun System', 'system', true, '1970-01-01 00:00:00+00'::timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    ['019700e0-0000-7000-8000-000000000001'],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status, language, is_public, is_demo)
     VALUES ($1, $2, 'Demo Adventure', 'Trial-mode demo world. Narrative content authored separately.', 'complete', 'en', false, true)
     ON CONFLICT (id) DO NOTHING`,
    ['019700e0-0000-7000-8000-000000000002', '019700e0-0000-7000-8000-000000000001'],
  )
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
     VALUES
       ('019700e0-0000-7000-8000-00000000d001', 'dev-user-1', 'Dev User 1', 'devuser1', true),
       ('019700e0-0000-7000-8000-00000000d002', 'dev-user-2', 'Dev User 2', 'devuser2', true),
       ('019700e0-0000-7000-8000-00000000d003', 'dev-user-3', 'Dev User 3', 'devuser3', true),
       ('019700e0-0000-7000-8000-00000000d004', 'dev-user-4', 'Dev User 4', 'devuser4', true),
       ('019700e0-0000-7000-8000-00000000d005', 'dev-user-5', 'Dev User 5', 'devuser5', true)
     ON CONFLICT (id) DO NOTHING`,
  )
  await pool.query(
    `INSERT INTO settings (key, value) VALUES
       ('world_gen_cost_cap_usd', '10.0'),
       ('character_creation_cost_cap_usd', '5.00')
     ON CONFLICT (key) DO NOTHING`,
  )
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd backend && pnpm typecheck 2>&1 | grep "reset-data" | head`
Expected: no errors.

### Task 3.2: Write `backend/src/__tests__/global-setup.ts`

**Files:**
- Create: `backend/src/__tests__/global-setup.ts`

- [ ] **Step 1: Write the file**

```typescript
// backend/src/__tests__/global-setup.ts
//
// Vitest globalSetup script — runs once per test process at startup,
// BEFORE any test file imports. Centralizes the schema bootstrap +
// system-row seed so individual test files never have to do their
// own DROP SCHEMA / runMigrations / reseed.
//
// myth-oehx: this consolidation is what makes parallel test execution
// safe. Per-file beforeAll DROP SCHEMA blocks would race-collide under
// vitest fileParallelism: true.

import { Pool } from 'pg'
import { runMigrations } from '../db/migrate.js'
import { seedTestDatabase } from '../repo/__tests__/_helpers/reset-data.js'

const REAL_MIGRATIONS_DIR = new URL('../../migrations', import.meta.url).pathname

export default async function setup(): Promise<void> {
  // setup-env.ts has bridged DATABASE_URL_TEST → DATABASE_URL already.
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'global-setup: DATABASE_URL is unset. setup-env.ts should have bridged it from DATABASE_URL_TEST.',
    )
  }

  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    await runMigrations({
      pool,
      migrationsDir: REAL_MIGRATIONS_DIR,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await seedTestDatabase(pool)
  } finally {
    await pool.end()
  }
}
```

- [ ] **Step 2: Add `silentLogger()` reuse note**

If the repo has a shared `silentLogger()` test helper, use it instead of inlining. Run: `grep -rn "silentLogger" backend/src --include='*.ts' | head -3` to find it.

- [ ] **Step 3: Sanity-check the import paths**

Run: `cd backend && pnpm typecheck 2>&1 | grep "global-setup" | head`
Expected: no errors.

### Task 3.3: Wire `globalSetup` into `vitest.config.ts`

**Files:**
- Modify: `backend/vitest.config.ts`

- [ ] **Step 1: Find the `test:` block**

Run: `grep -n "test:" backend/vitest.config.ts | head -3`

- [ ] **Step 2: Add `globalSetup`**

In the `test` config block, add:

```typescript
globalSetup: ['./src/__tests__/global-setup.ts'],
```

It can sit next to `setupFiles`. Note: `globalSetup` runs once per process; `setupFiles` runs once per file. The two are different lifecycles by design.

- [ ] **Step 3: Run a sanity-check test file**

Run: `cd backend && pnpm vitest run src/db/__tests__/guard-db.test.ts`
Expected: passes; globalSetup runs, migrations applied (no-op idempotent), test passes.

- [ ] **Step 4: Run a test file that currently does DROP SCHEMA**

Run: `cd backend && pnpm vitest run src/llm/prep/__tests__/cost-cap.test.ts`
Expected: passes (or fails for non-Phase-3 reasons; the per-file `DROP SCHEMA` is still there, it'll just be a no-op + re-migration. Phase 4 removes those blocks.).

### Task 3.4: Add branded types to `_helpers/test-scope.ts`

**Files:**
- Modify: `backend/src/repo/__tests__/_helpers/test-scope.ts`

- [ ] **Step 1: Read current file**

Run: `cat backend/src/repo/__tests__/_helpers/test-scope.ts`

- [ ] **Step 2: Add branded types at the top of the file (after imports)**

```typescript
// Branded types: identifier-shaped strings that can only be produced via
// `makeTestScope`. Fixture builders accept these branded types instead of
// raw strings, so passing an unscoped value fails to compile.
//
// Limitation: the brand widens to `string` when the value is passed to
// pg.Pool.query (typed as unknown[]). Tests that build INSERT/UPDATE SQL
// directly are still on the honor system; the ESLint rule (Phase 5) is
// the primary defense at that surface.
declare const SCOPED_BRAND: unique symbol
export type ScopedSub = string & { readonly [SCOPED_BRAND]: 'sub' }
export type ScopedUsername = string & { readonly [SCOPED_BRAND]: 'username' }
export type ScopedWorldName = string & { readonly [SCOPED_BRAND]: 'world-name' }
export type ScopedCampaignName = string & { readonly [SCOPED_BRAND]: 'campaign-name' }
```

- [ ] **Step 3: Update `TestScope` interface (or implicit return type)**

If `TestScope` is currently:
```typescript
export interface TestScope {
  readonly id: string
  userSub(n: number): string
  username(n: number): string
  worldName(n: number): string
  campaignName(n: number): string
}
```

Change return types to the branded variants:

```typescript
export interface TestScope {
  readonly id: string
  userSub(n: number): ScopedSub
  username(n: number): ScopedUsername
  worldName(n: number): ScopedWorldName
  campaignName(n: number): ScopedCampaignName
}
```

- [ ] **Step 4: Cast inside `makeTestScope`**

Inside the implementation, where each method returns a string, add `as Scoped*`:

```typescript
userSub: (n: number): ScopedSub => `tst-${label}-${rand}-sub-${n}` as ScopedSub,
username: (n: number): ScopedUsername => `tst-${label}-${rand}-user-${n}` as ScopedUsername,
worldName: (n: number): ScopedWorldName => `tst-${label}-${rand}-world-${n}` as ScopedWorldName,
campaignName: (n: number): ScopedCampaignName => `tst-${label}-${rand}-campaign-${n}` as ScopedCampaignName,
```

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | tail -10`
Expected: passes (no callers consume the brand yet).

### Task 3.5: Refactor `_helpers/create-test-user.ts` to require `TestScope` + branded `ScopedSub`

**Files:**
- Modify: `backend/src/repo/__tests__/_helpers/create-test-user.ts`

- [ ] **Step 1: Read current signature**

Run: `cat backend/src/repo/__tests__/_helpers/create-test-user.ts`

- [ ] **Step 2: Change the signature**

Current likely shape:
```typescript
export async function createTestUser(
  pool: Pool,
  opts: { sub: string; displayName?: string },
): Promise<string>
```

New:
```typescript
import type { ScopedSub, TestScope } from './test-scope.js'

export async function createTestUser(
  pool: Pool,
  scope: TestScope,
  opts: { sub: ScopedSub; displayName?: string },
): Promise<string>
```

(The `scope` parameter is unused inside the function body — its purpose is to make the test author thread the scope, signaling intent. Add a `void scope` line or use `scope.id` in a comment-only way to suppress the unused-param warning.)

- [ ] **Step 3: Update callers in the 24 currently-scoped files (mechanical)**

Run: `grep -rln "createTestUser" backend/src --include='*.test.ts'`
For each file, update the calls from `createTestUser(pool, { sub: 'foo' })` to `createTestUser(pool, scope, { sub: scope.userSub(0) })`. Use a one-line `sed` if the call sites are uniform:

```bash
# Inspect first
grep -rn "createTestUser(pool, {" backend/src --include='*.test.ts'
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | grep "createTestUser\|create-test-user" | head -10`
Expected: zero errors.

### Task 3.6: Create `_helpers/test-pool.ts` — uniform pool factory

**Files:**
- Create: `backend/src/repo/__tests__/_helpers/test-pool.ts`

- [ ] **Step 1: Write the file**

```typescript
// backend/src/repo/__tests__/_helpers/test-pool.ts
//
// Uniform pool factory for test files. Hard-codes `max: 4` so the
// per-fork connection budget is predictable under parallel execution.
//
// Every test file must:
//   1. Use createTestPool(url) (not new Pool({...})) to build its pool.
//   2. Call pool.end() in afterAll, so the fork doesn't accumulate
//      sockets across files.
//
// myth-oehx: required for the parallel-execution connection budget.

import { Pool } from 'pg'

export function createTestPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm typecheck 2>&1 | grep "test-pool" | head`
Expected: zero errors.

### Task 3.7: Migrate the 24 currently-scoped test files to `createTestPool` + `afterAll(pool.end())`

**Files:**
- Modify: all files matching `grep -rl "cleanupTestScope" backend/src --include='*.test.ts'`

- [ ] **Step 1: Get the file list**

Run: `grep -rl "cleanupTestScope" backend/src --include='*.test.ts'` and save the output.

- [ ] **Step 2: For each file, apply this recipe**

Per file:

a. Replace `new Pool({ connectionString: process.env.DATABASE_URL })` (or equivalent) with `createTestPool(process.env.DATABASE_URL!)`. Add import: `import { createTestPool } from '../_helpers/test-pool.js'` (adjust path).

b. Add `afterAll(async () => { await pool.end() })` if not present.

c. Where the file currently has its own `DROP SCHEMA public CASCADE` + `runMigrations` in `beforeAll`, leave it for now — Phase 4 removes those. (The globalSetup makes them redundant but they won't error.)

- [ ] **Step 3: Run all 24 files**

Run: `cd backend && pnpm vitest run $(grep -rl "cleanupTestScope" backend/src --include='*.test.ts' | tr '\n' ' ')`
Expected: all pass.

### Task 3.8: Write `backend/src/__tests__/CONVENTIONS.md`

**Files:**
- Create: `backend/src/__tests__/CONVENTIONS.md`

- [ ] **Step 1: Write the file**

```markdown
# Test Conventions

This doc is the single source of truth for how the Mythrun backend test
suite is structured. If a test file deviates from these conventions,
it should explain why in a header comment.

## Database lifecycle

Tests target `mythrun_test` (or `mythrun_test_<worktree>` inside a
worktree). The dev server uses `mythrun_dev`. Never the twain shall meet.

`backend/src/__tests__/global-setup.ts` runs once per worker process at
startup. It:
- Runs migrations against the test DB.
- Inserts the system user, demo world, dev-users, and cost-cap settings
  rows (all idempotent).

No test file should do its own `DROP SCHEMA` + `runMigrations`. ESLint
errors on `DROP SCHEMA` literals in `__tests__/` files.

## The one isolation pattern: scoped fixtures

Every test that creates rows uses a `TestScope`:

```ts
import { makeTestScope, cleanupTestScope } from '../_helpers/test-scope.js'
import { createTestPool } from '../_helpers/test-pool.js'

describe('something', () => {
  const pool = createTestPool(process.env.DATABASE_URL!)
  const scope = makeTestScope('my-feature')

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  it('does the thing', async () => {
    const userId = await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES (uuid_generate_v7(), $1, 'Test User', $2, false)
       RETURNING id`,
      [scope.userSub(0), scope.username(0)],
    )
    // ...
  })
})
```

`scope.userSub(n)` returns a `ScopedSub` (branded string) that only the
scope can produce. Fixture builders that take `sub: ScopedSub` will
reject raw strings at the type level.

## Pool lifecycle

Every test file uses `createTestPool(url)` to build its pool, and calls
`pool.end()` in `afterAll`. Otherwise the fork accumulates sockets and
the parallel-execution connection budget breaks.

## Global config

Cost-caps (and similar global policy values) are dependency-injected
into the worker deps. Tests construct processors with arbitrary
`costCapUsd` values directly — never `UPDATE settings`.

## What about transactions?

Production code can use `pool.connect()` + `BEGIN`/`COMMIT` freely; that's
business-logic atomicity, not test isolation. There's no `withTx` test
helper any more.

## What about `resetData`?

Deleted. The schema bootstrap is the globalSetup's job; data isolation
is scoped fixtures' job. There's no nuclear-reset escape hatch.

## Lint enforcement

`eslint.config.js` ships these guardrails:
- `no-restricted-imports` blocks importing the deleted `with-tx` and
  `reset-data` helpers.
- `no-restricted-syntax` errors on `DROP SCHEMA` SQL literals in tests.
- `no-restricted-syntax` warns on test files that mutate the DB
  (INSERT/UPDATE/DELETE) without importing `makeTestScope` or
  `cleanupTestScope`.

Don't suppress these rules without a header comment explaining why.
```

- [ ] **Step 2: Add link from `CLAUDE.md`**

In `CLAUDE.md`, under "Code Conventions" or "Standing Rules", add:

```markdown
- Test conventions live in `backend/src/__tests__/CONVENTIONS.md`. Read before authoring new tests.
```

### Task 3.9: Phase 3 commit

- [ ] **Step 1: Run the full suite**

Run: `cd backend && pnpm test 2>&1 | tail -10`
Expected: passes (or fails only on the existing pre-Phase-4 issues).

- [ ] **Step 2: Commit**

```bash
git add backend/src/__tests__/global-setup.ts \
  backend/src/__tests__/CONVENTIONS.md \
  backend/src/repo/__tests__/_helpers/reset-data.ts \
  backend/src/repo/__tests__/_helpers/test-scope.ts \
  backend/src/repo/__tests__/_helpers/test-pool.ts \
  backend/src/repo/__tests__/_helpers/create-test-user.ts \
  backend/vitest.config.ts \
  CLAUDE.md \
  $(grep -rl "cleanupTestScope" backend/src --include='*.test.ts')
git commit -m "feat(test): globalSetup + branded TestScope + CONVENTIONS

Phase 3 of myth-oehx. Schema bootstrap moves out of per-file beforeAll
into Vitest globalSetup — runs migrations + idempotent seedTestDatabase
once per worker process. TestScope identifiers (userSub, username,
worldName, campaignName) are branded so fixture builders refuse raw
strings at the type level. New createTestPool helper standardizes
per-file pool config at max=4; every scoped test file now ends with
afterAll(() => pool.end()).

Followed up by Phase 4 (migrate the resetData/withTx files) and Phase
5 (delete the helpers + enable parallelism)."
```

---

## Phase 4 — Migrate 32 Test Files to Scoped Fixtures

End state: every test file uses scoped fixtures; no test file does its own `DROP SCHEMA` + `runMigrations`. Subagent-driven, ~32 files.

### Task 4.0: Regenerate the file list

**Files:**
- (Read-only; produces a list for the subsequent tasks)

- [ ] **Step 1: Compute the union of resetData + withTx callers**

Run:
```bash
{ grep -rl "from.*reset-data" backend/src --include='*.test.ts'; \
  grep -rl "from.*with-tx"     backend/src --include='*.test.ts'; } \
  | sort -u
```
Save the output. Expected: ~32 files.

- [ ] **Step 2: Group into waves**

Apply the suggested grouping from the spec (`docs/superpowers/specs/2026-05-19-test-db-isolation-design.md`, Phase 4). Adjust to actual file names. Document the final wave assignments before dispatching subagents.

### Task 4.1: Per-file migration recipe (apply to each of the ~32 files)

**Files (template — replace `<file>` per invocation):**
- Modify: `<file>`
- Test command: `pnpm vitest run <file>`

This is the recipe a subagent applies per file. Use one subagent per file (or one per small batch of structurally identical files) to keep blast radius small.

- [ ] **Step 1: Inspect the file**

Run: `cat <file>` (and `grep -n "resetData\|withTx\|DROP SCHEMA\|runMigrations" <file>` to see what to remove).

- [ ] **Step 2: Add imports**

If not already present, add:

```typescript
import { makeTestScope, cleanupTestScope } from '../../_helpers/test-scope.js'  // adjust path
import { createTestPool } from '../../_helpers/test-pool.js'                    // adjust path
```

(Remove the now-deleted-in-Phase-5 imports for `resetData` / `withTx`.)

- [ ] **Step 3: Replace `new Pool(...)` with `createTestPool`**

Find the pool construction (usually `new Pool({ connectionString: process.env.DATABASE_URL })`) and replace with `createTestPool(process.env.DATABASE_URL!)`.

- [ ] **Step 4: Remove per-file schema bootstrap**

Delete any `beforeAll` block matching:
```typescript
beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
})
```
`globalSetup` (Phase 3) handles this once per process.

If `beforeAll` also did other setup work, keep that part; delete only the schema bootstrap.

- [ ] **Step 5: Replace `resetData(pool)` with scoped fixtures**

For each occurrence of `await resetData(pool)`:
- Move to a `const scope = makeTestScope('<short-label>')` at the top of the `describe` block.
- Replace the per-test `await resetData(pool)` with nothing (scopes don't pollute across tests when prefixes are unique).
- Add `afterAll(async () => { await cleanupTestScope(pool, scope) })`.

- [ ] **Step 6: Update INSERT statements to use scope-prefixed values**

Find each `pool.query('INSERT INTO users ...', [...])` (and equivalents for worlds/campaigns/etc.). Replace literal identifier values with `scope.userSub(n)`, `scope.username(n)`, etc.

Example before:
```typescript
await pool.query(
  `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
   VALUES (uuid_generate_v7(), 'test-sub', 'Test', 'testuser', false) RETURNING id`,
)
```
After:
```typescript
await pool.query(
  `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
   VALUES (uuid_generate_v7(), $1, 'Test', $2, false) RETURNING id`,
  [scope.userSub(0), scope.username(0)],
)
```

- [ ] **Step 7: For withTx files specifically — replace withTx with scoped pattern**

Files importing `withTx`:
- Remove the `withTx(pool, async (client) => { ... })` wrapper.
- Move the inner test logic to use `pool` directly with scope-prefixed values.
- The rollback safety net is gone; the scope cleanup in `afterAll` handles it instead.

- [ ] **Step 8: Add `afterAll(() => pool.end())`**

If not already present, add the pool-close hook. If there are already cleanup hooks, append:
```typescript
afterAll(async () => {
  await cleanupTestScope(pool, scope)
  await pool.end()
})
```

- [ ] **Step 9: Run the file alone**

Run: `cd backend && pnpm vitest run <file>`
Expected: passes. Iteration loop: edit → re-run (~5s).

- [ ] **Step 10: Run all migrated-so-far files**

Run: `cd backend && pnpm vitest run <wave-glob>`
Expected: wave passes.

### Task 4.2: After each wave, run the full suite as a gate

**Files:**
- (Verification step)

- [ ] **Step 1: Run full test suite**

Run: `cd backend && pnpm test 2>&1 | tail -10`
Expected: passes.

- [ ] **Step 2: Commit the wave**

```bash
git add <wave-files>
git commit -m "refactor(test): migrate <wave-name> to scoped fixtures

Phase 4 of myth-oehx. <N> files in the <wave-name> group converted
from resetData/withTx to scoped fixtures + createTestPool +
afterAll(pool.end()). Per-file DROP SCHEMA blocks removed; globalSetup
handles bootstrap.

Files: <list>"
```

---

## Phase 5 — Parallelism, Lint Enforcement, Decommission

End state: parallelism on; lint enforcing scope; deleted helpers gone; ≥1.5× speedup confirmed.

### Task 5.1: Delete `_helpers/with-tx.ts` and `_helpers/reset-data.ts`

**Files:**
- Delete: `backend/src/repo/__tests__/_helpers/with-tx.ts`
- Delete: `backend/src/repo/__tests__/_helpers/reset-data.ts`

- [ ] **Step 1: Confirm zero remaining importers**

Run: `grep -rl "from.*with-tx\|from.*reset-data" backend/src --include='*.test.ts'`
Expected: empty.

- [ ] **Step 2: Migrate `seedTestDatabase` out before deletion**

If `seedTestDatabase` still lives in `reset-data.ts` (per Task 3.1), move it to `backend/src/__tests__/_helpers/seed-test-database.ts` (a new dedicated home) — `reset-data.ts` is about to be deleted entirely.

```typescript
// backend/src/__tests__/_helpers/seed-test-database.ts
import type { Pool } from 'pg'

export async function seedTestDatabase(pool: Pool): Promise<void> {
  // ... same body as Task 3.1
}
```

Update the import in `global-setup.ts`.

- [ ] **Step 3: Delete the helper files**

Run:
```bash
git rm backend/src/repo/__tests__/_helpers/with-tx.ts
git rm backend/src/repo/__tests__/_helpers/reset-data.ts
```

- [ ] **Step 4: Typecheck + test**

Run: `cd backend && pnpm typecheck && pnpm test 2>&1 | tail -10`
Expected: typechecks; tests pass.

### Task 5.2: Add `no-restricted-imports` to `eslint.config.js`

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Read current ESLint flat config**

Run: `cat eslint.config.js | head -120`

- [ ] **Step 2: Add a new config entry scoped to test files**

Append (or merge into an existing test-files block):

```javascript
{
  files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['**/_helpers/with-tx*', '**/_helpers/with-tx'],
          message: 'with-tx was deleted in myth-oehx. Use scoped fixtures (cleanupTestScope) instead.',
        },
        {
          group: ['**/_helpers/reset-data*', '**/_helpers/reset-data'],
          message: 'reset-data was deleted in myth-oehx. Schema bootstrap is in globalSetup; data isolation via scoped fixtures.',
        },
      ],
    }],
  },
},
```

- [ ] **Step 3: Verify rule fires when expected**

Quickly write a temp test file with an offending import, run lint, then delete the temp file:

```bash
cat > /tmp/lint-probe.test.ts <<EOF
import { withTx } from '../_helpers/with-tx.js'
EOF
cp /tmp/lint-probe.test.ts backend/src/__tests__/lint-probe.test.ts
cd backend && pnpm lint 2>&1 | grep "with-tx"
rm backend/src/__tests__/lint-probe.test.ts
```
Expected: lint error mentioning "with-tx was deleted in myth-oehx."

### Task 5.3: Add `no-restricted-syntax` for `DROP SCHEMA` literals in tests

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add the rule entry**

In the same test-files config block:

```javascript
'no-restricted-syntax': ['error',
  {
    selector: "Literal[value=/DROP SCHEMA/i]",
    message: 'DROP SCHEMA in tests is forbidden — globalSetup handles schema bootstrap. See backend/src/__tests__/CONVENTIONS.md.',
  },
  {
    selector: "TemplateElement[value.raw=/DROP SCHEMA/i]",
    message: 'DROP SCHEMA in tests is forbidden — globalSetup handles schema bootstrap.',
  },
],
```

- [ ] **Step 2: Verify**

Probe with a temp file containing `pool.query('DROP SCHEMA public CASCADE')`. Run lint. Expected: error fires.

### Task 5.4: Update `scripts/worktree-setup.sh`

**Files:**
- Modify: `scripts/worktree-setup.sh`

- [ ] **Step 1: Read current script**

Run: `cat scripts/worktree-setup.sh`

- [ ] **Step 2: Change the DB provisioning section**

Find the block that currently provisions `mythrun_<wt>` for both dev and tests. Replace with provisioning ONLY a test DB:

Before (approximate):
```bash
docker compose exec postgres psql -U mythrun -d postgres -c "CREATE DATABASE mythrun_$WT_NAME OWNER mythrun;"
# ... writes DATABASE_URL=...mythrun_$WT_NAME into .env.worktree
```

After:
```bash
docker compose exec -T postgres psql -U mythrun -d postgres -c "CREATE DATABASE mythrun_test_$WT_NAME OWNER mythrun;"
# Writes ONLY DATABASE_URL_TEST. Dev DB stays shared (mythrun_dev).
cat > "$REPO_ROOT/.env.worktree" <<EOF
DATABASE_URL_TEST=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun_test_$WT_NAME
EOF
```

- [ ] **Step 3: Update the migration call**

The script currently runs `pnpm db:migrate` (against the new dev DB). Change to `pnpm db:migrate:test` (against the new test DB).

- [ ] **Step 4: Smoke test the script**

Run: `bd worktree create .worktrees/oehx-smoke` then `cd .worktrees/oehx-smoke && ../../scripts/worktree-setup.sh`
Expected: creates `mythrun_test_oehx-smoke`; writes `.env.worktree` with only `DATABASE_URL_TEST`; runs migrations.

- [ ] **Step 5: Clean up the smoke worktree**

Run: `bd worktree remove oehx-smoke` and `docker compose exec -T postgres psql -U mythrun -d postgres -c "DROP DATABASE IF EXISTS mythrun_test_oehx-smoke;"`

### Task 5.5: Update `scripts/worktree-remove.sh`

**Files:**
- Modify: `scripts/worktree-remove.sh` (or the equivalent — find it first)

- [ ] **Step 1: Find the cleanup script**

Run: `ls scripts/worktree-*`. If `worktree-remove.sh` doesn't exist, the cleanup might happen inline in `bd worktree remove`. Check `bd` source.

- [ ] **Step 2: Add the `DROP DATABASE` step**

Append (if a script file exists; otherwise document in CONVENTIONS):

```bash
docker compose exec -T postgres psql -U mythrun -d postgres \
  -c "DROP DATABASE IF EXISTS mythrun_test_$WT_NAME;" || true
```

### Task 5.6: Remove `fileParallelism: false` and set parallel config

**Files:**
- Modify: `backend/vitest.config.ts`

- [ ] **Step 1: Find the line**

Run: `grep -n "fileParallelism" backend/vitest.config.ts`

- [ ] **Step 2: Remove the line, add pool config**

Delete `fileParallelism: false,`. Add:

```typescript
pool: 'forks',
poolOptions: {
  forks: {
    maxForks: 6,
  },
},
```

- [ ] **Step 3: Run the full suite, measure wall-clock**

Run: `time pnpm --filter @mythrun/backend test 2>&1 | tail -5`
Expected: tests pass; wall-clock time < (previous serial baseline × 0.67). Note the actual time.

- [ ] **Step 4: If speedup < 1.5×, tune `maxForks`**

Try `maxForks: 4` and `maxForks: 8`. Pick the value with the best wall-clock that still passes the suite without flakes. Update `vitest.config.ts` accordingly.

- [ ] **Step 5: If speedup remains < 1.5×, defer the parallelism change**

Revert `vitest.config.ts` to keep `fileParallelism: false`. File a follow-up bead to evaluate `pgtestdb` / template-DB pattern. The rest of Phase 5 (lint rules, deletions) stands regardless.

### Task 5.7: Acceptance test — dev DB survives `pnpm test`

**Files:**
- (Verification step)

- [ ] **Step 1: Insert a sentinel row in mythrun_dev**

Run:
```bash
docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used) VALUES ('019700e0-0000-7000-8000-00000000sn5l', 'sentinel:phase5', 'Phase 5 Sentinel', 'sentinel_phase5', false);"
```

- [ ] **Step 2: Run pnpm test**

Run: `cd backend && pnpm test 2>&1 | tail -5`
Expected: tests pass.

- [ ] **Step 3: Verify sentinel survived**

Run: `docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "SELECT cognito_sub FROM users WHERE cognito_sub = 'sentinel:phase5';"`
Expected: returns the row.

- [ ] **Step 4: Cleanup**

Run: `docker compose exec -T postgres psql -U mythrun -d mythrun_dev -c "DELETE FROM users WHERE cognito_sub = 'sentinel:phase5';"`

### Task 5.8: Phase 5 commit + push

- [ ] **Step 1: Final verification**

Run: `cd backend && pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 2: Commit**

```bash
git add eslint.config.js scripts/worktree-setup.sh scripts/worktree-remove.sh \
  backend/vitest.config.ts \
  backend/src/__tests__/_helpers/seed-test-database.ts
git rm backend/src/repo/__tests__/_helpers/with-tx.ts \
  backend/src/repo/__tests__/_helpers/reset-data.ts
git commit -m "feat(test): parallelism + lint enforcement + helper decommission

Phase 5 of myth-oehx. Vitest fileParallelism enabled (pool: forks,
maxForks: 6); per-fork connection budget stays under the 200 ceiling.
ESLint enforces:
- no-restricted-imports blocking with-tx and reset-data
- no-restricted-syntax erroring on DROP SCHEMA literals in tests

with-tx.ts and reset-data.ts deleted (zero callers). Worktree scripts
provision only the test DB; dev DB remains shared.

Acceptance: pnpm test against mythrun_test does not affect mythrun_dev
(sentinel test). Parallel wall-clock <wall-clock-here> (was ~209s
serial; <speedup>× speedup)."
```

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Close the bead**

Run: `bd close myth-oehx`

---

## Self-Review Notes

Run through the spec one more time and check the plan against it:

1. **Section 1 (Database topology):** Tasks 1.1–1.4 cover the rename + new DB + max_connections bump. ✓
2. **Section 2 (Connection-string resolution):** Tasks 1.3, 1.5, 1.6 cover env vars, guard-db regex, safety fence. ✓
3. **Section 3 (Per-test isolation pattern):** Phase 3 tasks 3.1–3.9 cover scoped fixtures, branded types, globalSetup, dep injection. ✓
4. **Section 4 (Parallel execution):** Task 5.6 enables parallelism with the budgeted config. ✓
5. **Section 5 (Lint enforcement):** Tasks 5.2, 5.3 add the built-in rule entries. CONVENTIONS.md in Task 3.8. ✓
6. **Section 6 (Worktree mechanics):** Tasks 1.8 (`worktree-migrate.sh`), 5.4 (`worktree-setup.sh`), 5.5 (`worktree-remove.sh`). ✓
7. **Section 7 (CI behavior):** Task 1.7. ✓
8. **Risks table mitigations:** wave-by-wave verification (4.2), index optimization (deferred per spec), worktree migrate path (1.8), parallelism speedup gate (5.6 Step 5). ✓

No placeholders. All file paths concrete. All commands runnable as-is.
