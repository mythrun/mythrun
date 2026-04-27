# Initial Postgres Schema — Design Spec

> **Linear issue**: [MYT-33](https://linear.app/mythrun/issue/MYT-33) — Backend Core: apply initial Postgres schema (migrations 001 + 002 + 003)
> **Parent spec**: `docs/specs/2026-04-13-backend-core.md` §4 (Complete Postgres Schema)
> **Date**: 2026-04-27
> **Status**: v2 (post-blind-review)

## 1. Goal

Land the initial Postgres schema by transcribing Backend Core spec §4 into three migration files and applying them via the MYT-32 runner. The blind review caught a real SQL bug in spec §4 that this ticket also fixes; otherwise this is transcription. The contract is "the SQL we ship matches the spec exactly," so the test pins constraints + indexes + cascade rules — not just table names.

Out of scope: SRD data loading, repository layer, server-boot wiring of the runner.

## 2. Files

```
backend/migrations/
  001_initial_schema.sql            # NEW — replaces 001_smoke.sql
  002_indexes.sql                   # NEW
  003_srd_reference_data.sql        # NEW (empty SRD tables, no data)
backend/src/db/__tests__/
  migrate-schema.test.ts            # NEW — schema-parity integration test
backend/src/db/migrate.ts           # MODIFIED — drift warning gets remediation hint
docs/specs/2026-04-13-backend-core.md  # MODIFIED — §4 pipeline_runs UNIQUE fix, §3 IF NOT EXISTS scoping
```

`001_smoke.sql` is **deleted** in this commit; its only statement (`CREATE EXTENSION IF NOT EXISTS pgcrypto`) is the first line of `001_initial_schema.sql` per spec §4 line 179, so the work is preserved.

## 3. Migration Contents

Verbatim transcription from the (just-updated) Backend Core spec §4:

- **`001_initial_schema.sql`** — `CREATE EXTENSION IF NOT EXISTS pgcrypto` followed by **35 application tables** (`users`, `credit_ledger`, `worlds`, `campaigns`, `campaign_members`, `campaign_invites`, `stat_blocks`, `stat_block_actions`, `entities`, `prose_kernels`, `facts`, `relationships`, `entity_hierarchy`, `random_tables`, `random_table_entries`, `characters`, `character_skills`, `character_features`, `character_equipment`, `character_spells`, `sessions`, `session_messages`, `session_participants`, `pipeline_runs`, `world_snapshots`, `session_preps`, `session_usage`, `purchases`, `world_marketplace`, `moderation_flags`, `subscription_tiers`, `user_subscriptions`, `session_packs`, `stripe_events`, `settings`) plus the new `CREATE UNIQUE INDEX idx_pipeline_runs_unique` (see §3.1). Tables are listed in topological FK order; only self-reference is `worlds.source_world_id`, legal in `CREATE TABLE`.
- **`002_indexes.sql`** — 22 named performance indexes including the partial-unique `idx_sessions_one_active` (`WHERE status = 'active'`).
- **`003_srd_reference_data.sql`** — 3 empty SRD reference tables (`srd_monsters`, `srd_spells`, `srd_conditions`). **No INSERT rows**; data is a follow-up bead.

### 3.1 Spec §4 Bug Fix (load-bearing)

Spec §4's original `pipeline_runs` declaration carried a table-level `UNIQUE(COALESCE(world_id, campaign_id), stage, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'))`. Postgres table-level `UNIQUE` constraints accept only column lists, not expressions; transcribed verbatim, the `CREATE TABLE` would fail with a syntax error.

The fix (already applied to spec §4 alongside this design): drop the inline `UNIQUE(...)` and ship the same invariant as a separate `CREATE UNIQUE INDEX` that DOES accept expressions, with an explicit `::uuid` cast on the sentinel literal so type unification works:

```sql
CREATE UNIQUE INDEX idx_pipeline_runs_unique
  ON pipeline_runs (
    COALESCE(world_id, campaign_id),
    stage,
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
```

Same semantics, valid SQL.

## 4. DDL Style

Bare `CREATE TABLE` and `CREATE INDEX`. The runner's `_migrations` bookkeeping makes `IF NOT EXISTS` redundant and undesirable (silent drift). One exception: `CREATE EXTENSION IF NOT EXISTS pgcrypto`, which is the documented Postgres pattern for global extensions. Backend Core spec §3 was tightened in the same commit to scope the `IF NOT EXISTS` advice to data and ALTER migrations only.

UUIDv7 generation lives in MYT-34. Tables declare `id UUID PRIMARY KEY` with no default.

## 5. Dev-Side Migration Path + Drift Hint

The boot gate (`BOOT_GATE_ENABLED=1` in `.env.development`) only probes Postgres connectivity; **it does not run migrations**. A contributor who pulls MYT-33 and runs `pnpm dev` without first migrating gets a cleanly-booting API on top of a smoke-only schema, and discovers it on the first write attempt — far from the cause.

Two changes mitigate this:

1. **Recommended workflow**: `pnpm db:reset && pnpm db:migrate` once after pulling. This wipes the docker-compose volume (clearing the `001_smoke.sql` row from `_migrations`), re-applies the three new migrations cleanly, and leaves no drift warning.
2. **Actionable drift hint**: the runner's `migrate.drift_missing_files` warn-level event currently emits only the missing filename(s). This ticket adds a `hint` field to the payload so a contributor seeing it knows what to do without grepping the design doc:

   ```json
   {
     "level": 40,
     "event": "migrate.drift_missing_files",
     "missing": ["001_smoke.sql"],
     "hint": "applied migrations are missing on disk. If this is the MYT-32→MYT-33 transition, run `pnpm db:reset && pnpm db:migrate`. Otherwise, investigate before continuing."
   }
   ```

   Two-line code change to `runMigrations` in `backend/src/db/migrate.ts`. Tests in `migrate.test.ts` Test 15 (drift coverage from MYT-32) get one extra assertion that `hint` is non-empty.

CI is unaffected: the `postgres:16-alpine` service container starts fresh per run.

## 6. Tests — Schema-Parity Contract

For a transcription job, the test must catch what name-only assertions miss: dropped `NOT NULL`, missing CHECK constraints, FK `ON DELETE` flips, dropped partial-index predicates, type drift. New `backend/src/db/__tests__/migrate-schema.test.ts` runs the three migrations against a clean DB and asserts:

```ts
beforeAll: guardTestDatabase + createPgPool({ max: 1 })
beforeEach: DROP EXTENSION pgcrypto CASCADE + DROP SCHEMA public CASCADE + CREATE SCHEMA public + GRANTs
afterAll: pool.end()

it('applies all three migrations and pins the schema contract', async () => {
  const { logger } = makeSpyLogger()
  const applied = await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger })

  // 1. Three applied versions in order.
  expect(applied.map((m) => m.version)).toEqual([
    '001_initial_schema.sql', '002_indexes.sql', '003_srd_reference_data.sql',
  ])

  // 2. Tables — full set, alphabetized.
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
  )
  expect(tables.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  // EXPECTED_TABLES is a sorted const: ['_migrations', 'campaign_invites',
  // 'campaign_members', 'campaigns', 'character_equipment', 'character_features',
  // 'character_skills', 'character_spells', 'characters', 'credit_ledger',
  // 'entities', 'entity_hierarchy', 'facts', 'moderation_flags', 'pipeline_runs',
  // 'prose_kernels', 'purchases', 'random_table_entries', 'random_tables',
  // 'relationships', 'session_messages', 'session_packs', 'session_participants',
  // 'session_preps', 'session_usage', 'sessions', 'settings', 'srd_conditions',
  // 'srd_monsters', 'srd_spells', 'stat_block_actions', 'stat_blocks',
  // 'stripe_events', 'subscription_tiers', 'user_subscriptions', 'users',
  // 'world_marketplace', 'world_snapshots', 'worlds']
  // 39 entries total: 1 _migrations + 35 application + 3 SRD.

  // 3. Named indexes — full idx_* set, not a sample.
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
       ORDER BY indexname`,
  )
  expect(indexes.rows.map((r) => r.indexname)).toEqual(EXPECTED_IDX_NAMES)
  // EXPECTED_IDX_NAMES is the sorted list of all named indexes from migrations
  // 001 (the new idx_pipeline_runs_unique + idx_credit_ledger_user_type +
  // idx_user_subscriptions_user) and 002 (~22 names). Auto-named PK / UNIQUE
  // indexes (`<table>_pkey`, `<table>_<col>_key`) are excluded by the LIKE.

  // 4. Partial-unique predicate on idx_sessions_one_active.
  const partial = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_sessions_one_active'`,
  )
  expect(partial.rows[0]?.indexdef).toContain(`WHERE (status = 'active'::text)`)

  // 5. CHECK constraints — assert each enum-style constraint is present.
  // Query pg_constraint where contype = 'c'. Expected list pins each
  // load-bearing enum: users.auth_provider IN ('google','discord'),
  // worlds.status IN (...), credit_ledger.credit_type IN (...), etc.
  const checks = await pool.query<{ table_name: string; check_clause: string }>(
    `SELECT t.relname AS table_name, pg_get_constraintdef(c.oid) AS check_clause
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND n.nspname = 'public'
      ORDER BY t.relname, c.conname`,
  )
  expect(checks.rows).toEqual(EXPECTED_CHECK_CONSTRAINTS)
  // Each entry is { table_name, check_clause } where check_clause is the
  // pg_get_constraintdef output (e.g. "CHECK (auth_provider = ANY (ARRAY[
  // 'google'::text, 'discord'::text]))"). Pinning by exact string is brittle
  // against PG version drift in formatting; if that bites, weaken to a
  // toContain() match per row. Start strict; relax if needed.

  // 6. FK ON DELETE rules for cascade-load-bearing relationships.
  const fks = await pool.query<{
    constraint_name: string; table_name: string; column_name: string;
    foreign_table_name: string; delete_rule: string;
  }>(
    `SELECT tc.constraint_name, tc.table_name, kcu.column_name,
            ccu.table_name AS foreign_table_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_name)
       JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
       JOIN information_schema.referential_constraints rc USING (constraint_name)
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.column_name`,
  )
  expect(fks.rows).toEqual(EXPECTED_FK_DELETE_RULES)
  // Pins ON DELETE behavior. The cascades that matter most:
  //   campaigns.world_id → CASCADE
  //   campaign_members.{campaign_id, user_id} → CASCADE
  //   entities.world_id → CASCADE
  //   entities.stat_block_id → SET NULL
  //   facts.entity_id → CASCADE
  //   pipeline_runs.world_id, pipeline_runs.campaign_id → CASCADE
  //   characters.entity_id → SET NULL
  // (Full list in EXPECTED_FK_DELETE_RULES — about 30 rows.)
})
```

The three `EXPECTED_*` constants are the spec contract in TS form. Any transcription typo that changes a name, drops a constraint, or flips a cascade rule fails the test with a clear diff.

We do not pin the auto-named `<table>_pkey` / `<col>_key` indexes (the `LIKE 'idx_%'` filter excludes them) — they're created implicitly by `PRIMARY KEY` / `UNIQUE` and pinning them adds noise without catching meaningful regressions.

## 7. Verification

After the test passes, the implementer also runs:

```bash
pnpm db:reset && pnpm db:migrate
docker compose exec postgres psql -U mythrun -d mythrun -c "\dt"
docker compose exec postgres psql -U mythrun -d mythrun -c "\di"
docker compose exec postgres psql -U mythrun -d mythrun -c "SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'"
pnpm db:migrate  # second run is a no-op
```

`docker compose exec postgres ...` uses the service name (stable across project-name variants) rather than `docker exec mythrun-postgres-1` (which depends on the compose project name and is fragile).

## 8. Definition of Done

- `backend/migrations/001_initial_schema.sql` matches spec §4 verbatim (post §3.1 fix), 35 application tables + the new `idx_pipeline_runs_unique` + `CREATE EXTENSION pgcrypto`.
- `backend/migrations/002_indexes.sql` matches spec §4's index block verbatim.
- `backend/migrations/003_srd_reference_data.sql` matches spec §4's SRD block verbatim, three empty tables.
- `backend/migrations/001_smoke.sql` deleted.
- `backend/src/db/__tests__/migrate-schema.test.ts` covers the six assertions in §6 against the real `backend/migrations/` directory.
- `backend/src/db/migrate.ts` adds the `hint` field to `migrate.drift_missing_files` events; `migrate.test.ts` Test 15 asserts `hint` non-empty.
- Backend Core spec §3 (IF NOT EXISTS scoping) and §4 (pipeline_runs UNIQUE → UNIQUE INDEX) updates land in this commit.
- `pnpm db:reset && pnpm db:migrate` works locally end-to-end; second run is a no-op.
- `pnpm typecheck` + `pnpm lint` + `pnpm test` all green locally and in CI.

## 9. Follow-ups

- SRD content loader (Prep Pipeline milestone). No test or seed should reference `srd_*` rows by ID until this lands; document the constraint in the wiki.
- Repository layer (MYT-34, next Platform issue).
