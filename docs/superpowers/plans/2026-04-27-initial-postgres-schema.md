# Initial Postgres Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the initial Postgres schema (35 application tables + 22 named indexes + 3 empty SRD reference tables) by transcribing Backend Core spec §4, plus add an actionable drift hint to the migration runner so the smoke→schema transition is self-documenting for contributors.

**Architecture:** Three append-only SQL migration files in `backend/migrations/`, applied via the MYT-32 runner. One integration test pins the schema contract (table list + index list + CHECK constraints + FK ON DELETE rules + partial-unique predicate). Two-line runner change adds a `hint` field to `migrate.drift_missing_files` events.

**Tech Stack:** PostgreSQL 16 (docker-compose locally; `postgres:16-alpine` service in CI), `pg@^8.13`, Vitest, MYT-32's `runMigrations`.

**Spec:** `docs/superpowers/specs/2026-04-27-initial-postgres-schema-design.md`
**Parent:** `docs/specs/2026-04-13-backend-core.md` §4 (already updated in commit `b7375a7` to fix the `pipeline_runs` UNIQUE bug — transcribe the post-fix version).

---

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `backend/migrations/001_initial_schema.sql` | NEW | `CREATE EXTENSION pgcrypto` + 35 application tables + 3 inline indexes (`idx_credit_ledger_user_type`, `idx_pipeline_runs_unique`, `idx_user_subscriptions_user`) |
| `backend/migrations/002_indexes.sql` | NEW | 22 named performance indexes including `idx_sessions_one_active` (partial unique) |
| `backend/migrations/003_srd_reference_data.sql` | NEW | 3 empty SRD reference tables (`srd_monsters`, `srd_spells`, `srd_conditions`) |
| `backend/migrations/001_smoke.sql` | DELETE | Replaced by 001_initial_schema (the smoke's `CREATE EXTENSION pgcrypto` is the first line of 001_initial_schema) |
| `backend/src/db/__tests__/migrate-schema.test.ts` | NEW | Schema-parity integration test; pins tables + indexes + CHECKs + FK deletes |
| `backend/src/db/migrate.ts` | MODIFY | Add `hint` field to `migrate.drift_missing_files` payload |
| `backend/src/db/__tests__/migrate.test.ts` | MODIFY | Test 15 gains assertion that `hint` is a non-empty string |

---

## Task 1: Author `001_initial_schema.sql` and delete smoke

**Files:**
- Create: `backend/migrations/001_initial_schema.sql`
- Delete: `backend/migrations/001_smoke.sql`

> **Implementer note:** the SQL goes verbatim from `docs/specs/2026-04-13-backend-core.md` §4 between the lines marked `### Migration 001: Initial Schema` (line 175) and the end of the SQL fence. Spec §4 was already updated in commit `b7375a7` to fix the `pipeline_runs` UNIQUE bug — transcribe the current state of the file, NOT the original. Specifically: the `pipeline_runs` `CREATE TABLE` no longer has an inline `UNIQUE(...)`; instead a separate `CREATE UNIQUE INDEX idx_pipeline_runs_unique ON pipeline_runs (...)` follows immediately after, with `::uuid` cast on the sentinel literal.

> **DDL style**: bare `CREATE TABLE` and `CREATE INDEX` (no `IF NOT EXISTS`). The runner's `_migrations` bookkeeping makes idempotency at the file level redundant. The one exception is `CREATE EXTENSION IF NOT EXISTS pgcrypto` at the top — extensions are global to the database and `IF NOT EXISTS` is the standard pattern.

> **Inline indexes**: spec §4 puts three indexes inside migration 001 alongside the tables they index: `idx_credit_ledger_user_type` (after `credit_ledger`), `idx_pipeline_runs_unique` (after `pipeline_runs`), `idx_user_subscriptions_user` (after `user_subscriptions`). Keep them where the spec puts them. Migration 002 has the rest.

- [ ] **Step 1: Author the file**

Create `backend/migrations/001_initial_schema.sql` with content that exactly matches Backend Core spec §4's "Migration 001: Initial Schema" SQL block. The file should contain:

- `CREATE EXTENSION IF NOT EXISTS "pgcrypto";` as the first statement.
- 35 `CREATE TABLE` statements in spec order: `users`, `credit_ledger`, `worlds`, `campaigns`, `campaign_members`, `campaign_invites`, `stat_blocks`, `stat_block_actions`, `entities`, `prose_kernels`, `facts`, `relationships`, `entity_hierarchy`, `random_tables`, `random_table_entries`, `characters`, `character_skills`, `character_features`, `character_equipment`, `character_spells`, `sessions`, `session_messages`, `session_participants`, `pipeline_runs`, `world_snapshots`, `session_preps`, `session_usage`, `purchases`, `world_marketplace`, `moderation_flags`, `subscription_tiers`, `user_subscriptions`, `session_packs`, `stripe_events`, `settings`.
- 3 inline `CREATE INDEX` / `CREATE UNIQUE INDEX` statements interleaved per spec (after `credit_ledger`, after `pipeline_runs`, after `user_subscriptions`).
- No comments above each table beyond what spec §4 has (preserve the section comments like `-- Users`, `-- Credit Ledger (replaces simple session_credits integer)`, etc.).

The fastest correctness check is to copy the SQL directly from spec §4, file-to-file. Do NOT retype from memory; transcription bugs are exactly what this ticket exists to NOT introduce.

- [ ] **Step 2: Delete the smoke migration**

```bash
git rm backend/migrations/001_smoke.sql
```

- [ ] **Step 3: Wipe and apply against local Postgres**

```bash
pnpm db:reset && pnpm db:migrate
```

Expected: `pnpm db:migrate` emits `migrate.start`, `migrate.lock_acquired`, `migrate.plan` with `pendingVersions: ["001_initial_schema.sql"]`, `migrate.applied`, `migrate.lock_released`, `migrate.done`, `migrate.complete`. Exit 0.

If the run fails (most likely cause: a transcription typo in the SQL), the runner emits `migrate.failed` with the pg error pointing at the offending statement. Fix and re-run from `pnpm db:reset`.

- [ ] **Step 4: Eyeball the schema**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -c "\dt" | wc -l
docker compose exec postgres psql -U mythrun -d mythrun -c "\dt" | head -10
docker compose exec postgres psql -U mythrun -d mythrun -c "SELECT extname FROM pg_extension WHERE extname='pgcrypto'"
```

Expected: 36 tables (35 application + `_migrations`); pgcrypto installed. (Tables 002+003 will add 22 indexes and 3 SRD tables in subsequent tasks.)

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/001_initial_schema.sql backend/migrations/001_smoke.sql
git commit -m "feat(myt-33): apply initial Postgres schema (migration 001)

35 application tables + 3 inline indexes per Backend Core spec §4.
Replaces the MYT-32 smoke migration; the smoke's CREATE EXTENSION
pgcrypto is now the first line of 001_initial_schema.

Local-dev note: run \`pnpm db:reset\` after pulling to clear the
\`001_smoke.sql\` row from \`_migrations\` and avoid a persistent
drift warning. Task 3 of this ticket adds an actionable hint to
that warning so future contributors don't need this commit-message
breadcrumb."
```

---

## Task 2: Author `002_indexes.sql`

**Files:**
- Create: `backend/migrations/002_indexes.sql`

- [ ] **Step 1: Author the file**

Create `backend/migrations/002_indexes.sql` matching Backend Core spec §4's "Migration 002: Indexes" SQL block. Should contain ~22 `CREATE INDEX` / `CREATE UNIQUE INDEX` statements:

- `idx_entities_world_type`, `idx_entities_world` — composite + simple on `entities(world_id, ...)`
- `idx_facts_entity`, `idx_facts_entity_access_status` — on `facts`
- `idx_relationships_source`, `idx_relationships_target`
- `idx_session_messages_session_seq` — composite for ordered replay
- `idx_campaigns_created_by`, `idx_campaign_members_user`, `idx_campaign_members_campaign`
- `idx_sessions_campaign`, `idx_session_preps_campaign`
- `idx_sessions_one_active` — `CREATE UNIQUE INDEX ... ON sessions(campaign_id) WHERE status = 'active'` (partial-unique; load-bearing for "one active session per campaign")
- `idx_pipeline_runs_world`, `idx_pipeline_runs_campaign`
- `idx_random_tables_world`
- `idx_characters_campaign`, `idx_characters_user`
- `idx_world_snapshots_campaign`
- `idx_purchases_user`

Preserve spec §4's section comments (`-- Entity queries by world and type (hot path for Scribe, ST, session loading)` etc.) as `--` comments in the SQL file.

- [ ] **Step 2: Apply against local Postgres**

```bash
pnpm db:migrate
```

Expected: `migrate.plan` shows `pendingVersions: ["002_indexes.sql"]`; one `migrate.applied`; exit 0.

- [ ] **Step 3: Eyeball the indexes**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -c "\di" | grep idx_ | wc -l
docker compose exec postgres psql -U mythrun -d mythrun -c "SELECT indexdef FROM pg_indexes WHERE indexname='idx_sessions_one_active'"
```

Expected: ~25 `idx_*` rows (3 from 001 + 22 from 002). The `idx_sessions_one_active` definition includes `WHERE (status = 'active'::text)`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/002_indexes.sql
git commit -m "feat(myt-33): performance indexes (migration 002)

22 named performance indexes per Backend Core spec §4. Includes the
partial-unique idx_sessions_one_active that enforces 'one active
session per campaign' in the DB rather than the application layer."
```

---

## Task 3: Author `003_srd_reference_data.sql`

**Files:**
- Create: `backend/migrations/003_srd_reference_data.sql`

- [ ] **Step 1: Author the file**

Create `backend/migrations/003_srd_reference_data.sql` matching Backend Core spec §4's "Migration 003: SRD Reference Tables" block. Three empty tables:

- `srd_monsters` (id TEXT PK, ~25 columns including JSONB for speed/skills/actions, TEXT[] for resistances/immunities/languages)
- `srd_spells` (id TEXT PK, ~14 columns including JSONB for damage/area_of_effect/save, TEXT[] for classes)
- `srd_conditions` (id TEXT PK, name + description + JSONB for mechanical_effects)

**No INSERT statements.** Data loading is a follow-up bead (Prep Pipeline milestone).

- [ ] **Step 2: Apply against local Postgres**

```bash
pnpm db:migrate
```

Expected: `migrate.plan` with `pendingVersions: ["003_srd_reference_data.sql"]`; one `migrate.applied`; exit 0. Re-run is no-op (`migrate.no_pending`).

- [ ] **Step 3: Eyeball the SRD tables**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -c "\dt srd_*"
docker compose exec postgres psql -U mythrun -d mythrun -c "SELECT count(*) FROM srd_monsters"
```

Expected: 3 tables (`srd_conditions`, `srd_monsters`, `srd_spells`); `count(*) = 0` for each.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/003_srd_reference_data.sql
git commit -m "feat(myt-33): SRD reference tables (migration 003)

Three empty tables (srd_monsters, srd_spells, srd_conditions) per
Backend Core spec §4. Data loading is a follow-up bead — until that
lands, no test or seed should reference srd_* rows by ID."
```

---

## Task 4: Add `hint` field to `migrate.drift_missing_files` event

**Files:**
- Modify: `backend/src/db/migrate.ts`
- Modify: `backend/src/db/__tests__/migrate.test.ts` (Test 15)

> **TDD:** modify the existing Test 15 first to assert the new `hint` field; run (FAIL); add the hint to the runner; run (PASS); commit.

- [ ] **Step 1: Modify Test 15 to assert `hint`**

In `backend/src/db/__tests__/migrate.test.ts`, find the existing Test 15 (the drift warning test that asserts `migrate.drift_missing_files` event with `missing: ['999_ghost.sql']`). Add one assertion at the bottom of the test:

```ts
    expect(typeof drift?.['hint']).toBe('string')
    expect((drift?.['hint'] as string).length).toBeGreaterThan(0)
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts -t "drift warning"
```

Expected: the new `hint`-existence assertion fails because the runner doesn't emit the field yet.

- [ ] **Step 3: Add the hint to the runner**

In `backend/src/db/migrate.ts`, find the `migrate.drift_missing_files` log emission inside `runMigrations`. It currently looks like:

```ts
    if (missing.length > 0) {
      logger.warn(
        { event: 'migrate.drift_missing_files', runId, missing },
        'migrate.drift_missing_files',
      )
    }
```

Replace with:

```ts
    if (missing.length > 0) {
      logger.warn(
        {
          event: 'migrate.drift_missing_files',
          runId,
          missing,
          hint:
            'applied migrations are missing on disk. If this is the MYT-32→MYT-33 transition, run `pnpm db:reset && pnpm db:migrate`. Otherwise, investigate before continuing — a previously-applied migration was deleted or renamed.',
        },
        'migrate.drift_missing_files',
      )
    }
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate.test.ts && pnpm typecheck && pnpm lint
```

All migrate tests pass (16 in `migrate.test.ts`); typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.ts backend/src/db/__tests__/migrate.test.ts
git commit -m "feat(myt-33): drift warning carries actionable hint

migrate.drift_missing_files events now include a 'hint' field that
points at \`pnpm db:reset\` for the smoke→schema transition. Test 15
extended to pin the hint as non-empty so a future refactor that
strips it fails loudly."
```

---

## Task 5: Author `migrate-schema.test.ts` with extracted EXPECTED_* constants

**Files:**
- Create: `backend/src/db/__tests__/migrate-schema.test.ts`

> **Strategy:** "transcribe-and-pin." Apply migrations 001+002+003 (already done in Tasks 1–3) to a clean local DB, then extract the resulting schema state via `psql` queries into TypeScript constants. Those constants ARE the contract. The test asserts that re-applying the migrations produces the same state.

- [ ] **Step 1: Reset DB and apply all migrations**

```bash
pnpm db:reset && pnpm db:migrate
```

Expected: three migrations applied cleanly.

- [ ] **Step 2: Extract EXPECTED_TABLES from the running DB**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -tAc \
  "SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name"
```

Save the 39-row output. This becomes `EXPECTED_TABLES` in the test as a `const EXPECTED_TABLES = ['_migrations', 'campaign_invites', ..., 'worlds'] as const`. Verify the count is exactly 39.

- [ ] **Step 3: Extract EXPECTED_IDX_NAMES from the running DB**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -tAc \
  "SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
     ORDER BY indexname"
```

Save the output (~25 names). This becomes `EXPECTED_IDX_NAMES`.

- [ ] **Step 4: Extract EXPECTED_CHECK_CONSTRAINTS**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -tAc \
  "SELECT t.relname || '|' || pg_get_constraintdef(c.oid)
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND n.nspname = 'public'
    ORDER BY t.relname, c.conname"
```

Save the output. Each row is `<table_name>|<check_clause>`. Convert to an array of `{ table_name, check_clause }` objects in the test as `EXPECTED_CHECK_CONSTRAINTS`. Roughly 15-20 rows expected (one per CHECK constraint in spec §4 — `auth_provider IN ('google','discord')`, `worlds.status IN (...)`, `credit_ledger.credit_type IN (...)`, etc.).

- [ ] **Step 5: Extract EXPECTED_FK_DELETE_RULES**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -tAc \
  "SELECT tc.table_name || '|' || kcu.column_name || '|' || ccu.table_name || '|' || rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu USING (constraint_name)
     JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
     JOIN information_schema.referential_constraints rc USING (constraint_name)
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name"
```

Save the output. Each row is `<table>|<column>|<foreign_table>|<delete_rule>`. Convert to an array of `{ table_name, column_name, foreign_table_name, delete_rule }` objects as `EXPECTED_FK_DELETE_RULES`. Roughly 30-35 rows.

- [ ] **Step 6: Author the test file**

Create `backend/src/db/__tests__/migrate-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../postgres.js'
import { runMigrations } from '../migrate.js'
import { guardTestDatabase } from './guard-db.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

const EXPECTED_TABLES = [
  // PASTE the 39 names from Step 2 here, sorted, one per line in the array
] as const

const EXPECTED_IDX_NAMES = [
  // PASTE the ~25 idx_* names from Step 3 here
] as const

const EXPECTED_CHECK_CONSTRAINTS: ReadonlyArray<{
  readonly table_name: string
  readonly check_clause: string
}> = [
  // PASTE the rows from Step 4 here, one object per row
]

const EXPECTED_FK_DELETE_RULES: ReadonlyArray<{
  readonly table_name: string
  readonly column_name: string
  readonly foreign_table_name: string
  readonly delete_rule: string
}> = [
  // PASTE the rows from Step 5 here, one object per row
]

function makeSilentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = { write: () => {} }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
}

describe('schema-parity (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetSchema(pool)
  })

  it('applies all three migrations and pins the schema contract', async () => {
    const applied = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: makeSilentLogger() })

    expect(applied.map((m) => m.version)).toEqual([
      '001_initial_schema.sql',
      '002_indexes.sql',
      '003_srd_reference_data.sql',
    ])

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual([...EXPECTED_TABLES])

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
         ORDER BY indexname`,
    )
    expect(indexes.rows.map((r) => r.indexname)).toEqual([...EXPECTED_IDX_NAMES])

    const partial = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_sessions_one_active'`,
    )
    expect(partial.rows[0]?.indexdef).toContain(`WHERE (status = 'active'::text)`)

    const checks = await pool.query<{ table_name: string; check_clause: string }>(
      `SELECT t.relname AS table_name, pg_get_constraintdef(c.oid) AS check_clause
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND n.nspname = 'public'
        ORDER BY t.relname, c.conname`,
    )
    expect(checks.rows).toEqual(EXPECTED_CHECK_CONSTRAINTS)

    const fks = await pool.query<{
      table_name: string
      column_name: string
      foreign_table_name: string
      delete_rule: string
    }>(
      `SELECT tc.table_name, kcu.column_name,
              ccu.table_name AS foreign_table_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu USING (constraint_name)
         JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
         JOIN information_schema.referential_constraints rc USING (constraint_name)
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        ORDER BY tc.table_name, kcu.column_name`,
    )
    expect(fks.rows).toEqual(EXPECTED_FK_DELETE_RULES)

    // Idempotency — second run is a no-op.
    const second = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: makeSilentLogger() })
    expect(second).toEqual([])
  })
})
```

Replace each `// PASTE ...` placeholder with the actual extracted content from Steps 2-5. Order matters — the queries already `ORDER BY` the right columns, so paste in the order produced.

- [ ] **Step 7: Run, expect PASS**

```bash
cd backend && pnpm vitest run src/db/__tests__/migrate-schema.test.ts && pnpm typecheck && pnpm lint
```

The test should pass on first run (because the EXPECTED_* constants were extracted from the same DB the test re-creates). If it fails, the most likely cause is a paste error — re-extract and retry.

- [ ] **Step 8: Commit**

```bash
git add backend/src/db/__tests__/migrate-schema.test.ts
git commit -m "test(myt-33): pin schema contract — tables, indexes, CHECKs, FK deletes

Schema-parity integration test. EXPECTED_* constants extracted from
the live local DB after applying migrations 001-003. Pins:
- 39 tables (1 _migrations + 35 application + 3 SRD)
- ~25 named indexes (idx_* prefix)
- Partial-unique predicate on idx_sessions_one_active
- All CHECK constraints with their definitions
- All FK ON DELETE rules

A transcription typo that drops a constraint, flips a cascade rule,
or changes a column type fails this test with a clear diff."
```

---

## Task 6: End-to-end verification, wiki update, push, Linear close

> **Per CLAUDE.md updated workflow ordering**: dispatch the wiki-update subagent BEFORE the final push so code + wiki land in one push (avoids the red-CI-flicker we hit on MYT-32).

- [ ] **Step 1: Final all-green check**

```bash
pnpm db:reset && pnpm db:migrate
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all migrations apply cleanly; no-op on second `pnpm db:migrate`; full test suite green (should be 82 backend tests + Test 15 hint assertion + the new migrate-schema test = ~83 backend tests).

- [ ] **Step 2: Eyeball-verify per design spec §7**

```bash
docker compose exec postgres psql -U mythrun -d mythrun -c "\dt" | wc -l
docker compose exec postgres psql -U mythrun -d mythrun -c "\di" | grep idx_ | wc -l
docker compose exec postgres psql -U mythrun -d mythrun -c "SELECT version, applied_at FROM _migrations ORDER BY version"
```

Expected:
- ~42 lines (header + 39 table rows + footer + blank)
- 25 idx_* rows (3 from 001 + 22 from 002)
- 3 rows in `_migrations`: `001_initial_schema.sql`, `002_indexes.sql`, `003_srd_reference_data.sql`

- [ ] **Step 3: Dispatch the wiki-update subagent**

Per the post-Linear-close hook prompt template (`.claude/hooks/post-linear-close.sh`) and `docs/wiki/AUTHORING.md`:

Use the Agent tool with `subagent_type=general-purpose`, `model=opus`, and a prompt parameterized with `linearIssueId=MYT-33`. The subagent will:
- Read MYT-33's description and walk the diffs from this branch
- Update or extend wiki content under `docs/wiki/content/data/` (the existing `migrations.html` page authored for MYT-32 needs an update reflecting the real schema landing; consider whether a new `data/schema.html` page makes more sense for the long-form schema overview)
- Run `pnpm wiki:accept-drift` for any drifted source-hashes
- Run `pnpm wiki:check`
- Commit the wiki changes locally — **do NOT push from inside the subagent.** The controller pushes everything together in Step 5.

The subagent's commit lands in the local branch alongside the migration commits.

- [ ] **Step 4: Verify wiki + tests still green**

```bash
pnpm wiki:check
pnpm typecheck && pnpm lint && pnpm test
```

All green.

- [ ] **Step 5: Push**

```bash
git push origin main
```

This pushes the migration commits + drift hint + schema test + wiki update as one event. CI's `wiki-check.yml` and `deploy.yml` both run on the consistent state.

- [ ] **Step 6: Flip Linear MYT-33 to Done**

Use `mcp__linear-server__save_issue` with `id=MYT-33` and `state=Done`. The post-close hook fires; since the wiki was already updated in Step 3, the hook's reminder serves only as a backstop.

- [ ] **Step 7: Close all MYT-33 beads** (if any were opened during implementation)

```bash
bd close myth-<id> [...]  # close the implementer's beads if applicable
```

---

## Self-Review

1. **Spec coverage**: every section of the design spec maps to a task — file authoring (Tasks 1-3), drift hint (Task 4), schema test (Task 5), verification + wiki + close (Task 6). Nothing missed.

2. **Placeholder scan**: the "PASTE the ..." placeholders in Task 5's test file are intentional and necessary — the actual values must come from a live DB extraction, not be invented. Each placeholder is paired with the exact `psql` command that produces its content. No "TBD" or "fill in later" in the steps themselves.

3. **Type / signature consistency**: `EXPECTED_TABLES` is `as const` (readonly tuple); `EXPECTED_IDX_NAMES` ditto. `EXPECTED_CHECK_CONSTRAINTS` and `EXPECTED_FK_DELETE_RULES` are `ReadonlyArray<{...}>` since they're not lexicographic literals. The `expect(...).toEqual([...EXPECTED_TABLES])` spread is required because `toEqual` against an `as const` tuple is too strict.

4. **Order-of-operations**: Tasks 1-3 land the migrations; Task 4 is independent (runner change); Task 5 needs Tasks 1-3 to be applied (so the EXPECTED_* extraction has data to read); Task 6 wraps everything. Workable in this order.

5. **Time budget**: ~1 working day per the Linear estimate. SQL transcription (Tasks 1-3): 2-3 hours including verification. Drift hint (Task 4): 15 min. Schema test (Task 5): 1-2 hours including extraction + paste + verification. Verification + wiki + push (Task 6): 1 hour. Total ~5-6 hours, within budget.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-27-initial-postgres-schema.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Tasks 1-3 are highly mechanical (good fit for fast subagents); Tasks 4-5 want more care.
2. **Inline Execution** — execute in this session using executing-plans, batch with checkpoints.

Which approach?
