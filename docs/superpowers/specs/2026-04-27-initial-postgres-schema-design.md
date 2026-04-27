# Initial Postgres Schema — Design Spec

> **Linear issue**: [MYT-33](https://linear.app/mythrun/issue/MYT-33) — Backend Core: apply initial Postgres schema (migrations 001 + 002 + 003)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §4 (Complete Postgres Schema)
> **Date**: 2026-04-27
> **Status**: v1

## 1. Goal

Land the initial Postgres schema by transcribing Backend Core spec §4 verbatim into three migration files and applying them via the MYT-32 runner. This is a transcription job — the design lives in the parent spec; this document captures the few decisions §4 doesn't pin and the dev-side workflow for replacing the existing smoke migration.

Out of scope: SRD data loading, repository layer, server-boot wiring of the runner, anything beyond §4's DDL.

## 2. Files

```
backend/migrations/
  001_initial_schema.sql         # NEW — replaces 001_smoke.sql
  002_indexes.sql                # NEW
  003_srd_reference_data.sql     # NEW (empty SRD tables, no data)
backend/src/db/__tests__/
  migrate-schema.test.ts         # NEW — schema-parity integration test
```

`001_smoke.sql` is **deleted** in this commit. Its only statement (`CREATE EXTENSION IF NOT EXISTS pgcrypto`) is the first line of `001_initial_schema.sql` per spec §4 line 179, so the work it did is preserved.

## 3. Migration Contents

Verbatim transcription from Backend Core spec §4:

- **`001_initial_schema.sql`** — spec §4 lines 178–600. `CREATE EXTENSION IF NOT EXISTS pgcrypto` followed by **35 application tables** (`users`, `credit_ledger`, `worlds`, `campaigns`, `campaign_members`, `campaign_invites`, `stat_blocks`, `stat_block_actions`, `entities`, `prose_kernels`, `facts`, `relationships`, `entity_hierarchy`, `random_tables`, `random_table_entries`, `characters`, `character_skills`, `character_features`, `character_equipment`, `character_spells`, `sessions`, `session_messages`, `session_participants`, `pipeline_runs`, `world_snapshots`, `session_preps`, `session_usage`, `purchases`, `world_marketplace`, `moderation_flags`, `subscription_tiers`, `user_subscriptions`, `session_packs`, `stripe_events`, `settings`). Tables are listed in topological FK order — verified by reading the spec; no forward references except `worlds.source_world_id` which self-references and is legal in `CREATE TABLE`.
- **`002_indexes.sql`** — spec §4 lines 605–647. ~22 performance indexes, including the partial unique `idx_sessions_one_active` for "one active session per campaign."
- **`003_srd_reference_data.sql`** — spec §4 lines 653–714. Three empty SRD reference tables: `srd_monsters`, `srd_spells`, `srd_conditions`. **No INSERT rows**; the bead body confirms data loading is out of scope. A follow-up bead loads content when the prep engine actually needs it.

## 4. DDL Style

**Bare `CREATE TABLE` and `CREATE INDEX`**, not `CREATE TABLE IF NOT EXISTS`. The runner's `_migrations` bookkeeping guarantees each file runs exactly once; `IF NOT EXISTS` here would silently paper over drift (e.g. an operator manually creating a conflicting table) instead of failing loudly. Backend Core spec §3 was updated alongside this design to scope the `IF NOT EXISTS` advice to data and ALTER migrations only.

`CREATE EXTENSION IF NOT EXISTS pgcrypto` is the one exception — extensions are global to the database, may have been created by an operator or a prior install, and `IF NOT EXISTS` is the documented Postgres pattern for them.

UUIDv7 generation is NOT in this migration. Tables declare `id UUID PRIMARY KEY` with no default; the repository layer (MYT-34) will generate UUIDs application-side via the `uuidv7` package (already a backend dep from MYT-32).

## 5. Dev-Side Migration Path

The `_migrations` row for `001_smoke.sql` exists on every dev's local DB after MYT-32. After pulling MYT-33:

- The runner sees `001_smoke.sql` in `_migrations` but not on disk → emits a `migrate.drift_missing_files` warn-level log. This is correct and documented (MYT-32 spec §5.5).
- `001_initial_schema.sql` is pending and gets applied. `CREATE EXTENSION IF NOT EXISTS pgcrypto` is a no-op against the already-installed extension; the rest of the file creates all the tables.
- Final state: schema correct, but `_migrations` has both `001_smoke.sql` and `001_initial_schema.sql` rows; the drift warning persists on every subsequent run.

**Recommended dev path**: `pnpm db:reset && pnpm db:migrate` once after pulling. This wipes the docker-compose volume, and the next migrate run starts clean — no drift warning, only `001_initial_schema.sql` + `002_indexes.sql` + `003_srd_reference_data.sql` in `_migrations`.

A one-line note in the MYT-33 commit body and (later) the wiki page tells contributors to do this. CI is unaffected — the `postgres:16-alpine` service starts fresh on every run, so it never has the smoke row.

## 6. Tests

Single integration test at `backend/src/db/__tests__/migrate-schema.test.ts`:

```
beforeAll: guardTestDatabase + createPgPool({ max: 1 })
beforeEach: drop+recreate public schema (same pattern as migrate.test.ts)
afterAll: pool.end()

it('applies all three migrations cleanly against a fresh DB', async () => {
  // Point runMigrations at the real backend/migrations/ directory.
  const { logger } = makeSpyLogger()
  const applied = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger })

  // 1. All three filenames recorded in order.
  expect(applied.map((m) => m.version)).toEqual([
    '001_initial_schema.sql',
    '002_indexes.sql',
    '003_srd_reference_data.sql',
  ])

  // 2. Expected tables exist. Hard-coded list matches spec §4.
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
  )
  expect(tables.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)

  // 3. A representative sample of indexes exist (not exhaustive — pinning
  //    every index name would be brittle. Pin the load-bearing ones:
  //    the partial-unique active-session, the composite fact lookup, the
  //    session-message ordering index).
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  )
  const names = new Set(indexes.rows.map((r) => r.indexname))
  expect(names).toContain('idx_sessions_one_active')
  expect(names).toContain('idx_facts_entity_access_status')
  expect(names).toContain('idx_session_messages_session_seq')

  // 4. Idempotency — second run is a no-op.
  const second = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger })
  expect(second).toEqual([])
})
```

`EXPECTED_TABLES` is a sorted alphabetical list of all **39 tables** in the `public` schema after migration: `_migrations` (created by the runner) + 35 application tables (from 001) + 3 SRD reference tables (from 003). Defined as a const in the test file. If a transcription typo drops a table or renames it, the test fails with a clear diff. The full list is the contract.

We do NOT pin every index by name (~22 of them) — too brittle. We pin three load-bearing ones: the partial-unique constraint that prevents duplicate active sessions, the composite fact-access index, and the session-messages ordering index. If those drift, the test catches it; lesser indexes are caught by query performance regressions later.

## 7. Verification

Beyond the integration test, the implementer runs:

```
pnpm db:reset
pnpm db:migrate
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "\dt"
docker exec -i mythrun-postgres-1 psql -U mythrun -d mythrun -c "\di"
```

Eyeball that:
- 39 tables in `\dt` (1 `_migrations` + 35 application + 3 SRD)
- `_migrations` rows show the three filenames in order
- 22 indexes in `\di` (the named ones in 002 + the implicit PK / UNIQUE indexes Postgres creates for primary keys and unique constraints will also appear; the 22 count is just the explicitly-named ones)
- `pgcrypto` extension present: `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`

Second `pnpm db:migrate` is a no-op (`migrate.no_pending`). Third sanity check: `pnpm db:reset && pnpm db:migrate` cycles cleanly.

## 8. Definition of Done

- `backend/migrations/001_initial_schema.sql` exists with verbatim spec §4 lines 178–600 content (CREATE EXTENSION + ~30 tables).
- `backend/migrations/002_indexes.sql` exists with verbatim spec §4 lines 605–647 content.
- `backend/migrations/003_srd_reference_data.sql` exists with verbatim spec §4 lines 653–714 content (3 empty tables, no INSERT).
- `backend/migrations/001_smoke.sql` is deleted.
- `backend/src/db/__tests__/migrate-schema.test.ts` covers the four assertions above.
- `pnpm db:reset && pnpm db:migrate` works locally end-to-end; second run is a no-op.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green locally and in CI.
- Backend Core spec §3 `IF NOT EXISTS` clarification landed in the same commit as the migrations (already written above this design's commit; pre-pinned for clarity).
- Commit message includes the dev-side `pnpm db:reset` note.

## 9. Follow-ups (Not This Ticket)

- **SRD content loader** (Prep Pipeline milestone). Source SRD monsters/spells/conditions, define stable IDs, build an idempotent UPSERT script (or migration-based loader). Not blocking until the prep engine references them.
- **Repository layer** (MYT-34, the next Platform issue). Builds typed accessors over this schema; uses `uuidv7` for ID generation.

## 10. Why This Spec Is Short

The design lives in Backend Core spec §4. This document exists only to:

- Capture the four decisions §4 doesn't pin (smoke-collision strategy, SRD data scope, DDL style, test strategy).
- Document the dev-side workflow for the smoke→initial-schema transition.
- Define the schema-parity test contract.

Per `feedback_blind_review_pendulum.md`: this is transcription. We do one round of review at most, then ship. No spec inflation.
