# Test/Dev Database Isolation Design

**Bead:** `myth-oehx`
**Date:** 2026-05-19
**Status:** Design — round-1 reviewed (knot-patterns team); revised

## Problem

The Mythrun backend's dev server and integration test suite share one Postgres database (`mythrun`). The test suite uses competing isolation strategies — `resetData` (TRUNCATE all tables) in 20 files, `cleanupTestScope` (scoped prefix-delete) in 24, `withTx` (BEGIN/ROLLBACK) in 12. Separately, ~38 test files do their own `DROP SCHEMA public CASCADE` + `runMigrations` in `beforeAll`. The `resetData` callers wipe the dev DB on every `pnpm test` invocation. The May 19 incident: settings rows seeded by migrations 010 + 016 (cost-cap values) got TRUNCATEd by `resetData` and not re-seeded by `reseedSystemRows`. The world-gen worker then threw on parse, BullMQ retried-then-evicted the job, and dev-tool campaigns hung at `status='generating'` forever.

The proximate fix (re-seed cost-cap rows in `reseedSystemRows`, wrap world-gen cost-cap precheck in try/catch) landed but doesn't address the root cause: an unfinished `cleanupTestScope` migration combined with a default-shared dev DB, AND a per-file schema-bootstrap pattern that's incompatible with parallel test execution.

This spec proposes the fix.

## Goals

1. **Dev DB never wiped by tests.** Tests and dev server use physically distinct databases.
2. **Single test-isolation pattern.** Scoped fixtures (`cleanupTestScope`) is the universal default. `withTx` and `resetData` test helpers are deleted entirely.
3. **Schema bootstrap centralized.** Migrations run once per worker process via Vitest `globalSetup`. Per-file `beforeAll` `DROP SCHEMA` blocks are removed. No file rebuilds the schema.
4. **Global config moves out of the DB-at-runtime path.** Cost-caps and similar global policy values are dependency-injected from boot-time DB reads. Tests construct processors with arbitrary cap values directly — no `UPDATE settings` in test code.
5. **Parallel test execution enabled.** Vitest's `fileParallelism: false` is removed. Tests run concurrently across worker processes, isolated by scoped fixtures plus dep-injection of globals plus the centralized bootstrap.
6. **Worktree isolation by deliberate design, not workaround.** Each worktree gets its own `mythrun_test_<wt>` DB; dev DB is shared across all worktrees.
7. **Lint enforcement of scoping discipline.** Branded types plus ESLint built-in rules make it hard to accidentally write an unscoped test.

## Non-goals

- PGlite / in-process Postgres for the inner loop. (Research showed promise but Alpha status + LISTEN/NOTIFY gaps disqualify it as the merge gate at this time. Revisit later.)
- Testcontainers. (Cold-start cost not worth it for a single-Postgres-version project at this size.)
- Per-test database via `CREATE DATABASE … TEMPLATE …` (pgtestdb / IntegreSQL pattern). Genuine industry state-of-the-art, but adds a clone step (~50ms) per test and needs orchestration in Vitest's lifecycle. Earned upgrade if scoped-fixtures performance falls short under the new parallel regime — re-evaluated in the "Out of scope" check at the end of Phase 5.
- Schema-per-worker (multiple Postgres schemas inside one DB, namespaced by `search_path`). Distinct from the per-test-DB pattern above; this one is rejected outright because Mythrun's migrations assume the `public` schema and the `pg_trgm` / extension story would get complicated.
- Migration of CI from the throwaway-service-container model. (CI is fine as-is; this spec adjusts only the DB name for consistency.)

## Architecture

### 1. Database topology

Three logical Postgres databases on the existing `postgres:16-alpine` container:

| DB name | Owner | Lifetime |
|---|---|---|
| `mythrun_dev` | dev server | Long-lived; accumulates state across days. |
| `mythrun_test` | test suite (main repo) | Schema kept current via `pnpm db:migrate:test`; data wiped intra-suite by scoped fixtures. |
| `mythrun_test_<worktree>` | test suite (per-worktree) | Created at `bd worktree create` time; dropped at `bd worktree remove`. |

The current local `mythrun` is renamed to `mythrun_dev` as a one-time `ALTER DATABASE` operation. CI's service-container DB is renamed from `mythrun` to `mythrun_test` for consistency.

The docker-compose Postgres service gets `command: ["postgres", "-c", "max_connections=200"]` (or equivalent env override) to lift the default 100-connection ceiling. Required by Section 4's parallel pool budget; cheap headroom.

### 2. Connection-string resolution

Production code (`server.ts` and everything it imports) reads `DATABASE_URL`. Tests read `DATABASE_URL_TEST`. This indirection prevents production runtime code from ever accidentally connecting to a test DB.

| Context | `DATABASE_URL` | `DATABASE_URL_TEST` |
|---|---|---|
| Dev server, main repo | `…/mythrun_dev` from `backend/.env.development` | (unread) |
| Tests, main repo | (unread) | `…/mythrun_test` from `backend/.env.development` |
| Tests, worktree | (unread) | `…/mythrun_test_<wt>` from `.env.worktree` |
| CI Deploy workflow | (unread by test step) | `…/mythrun_test` from the workflow's `env:` block |

`backend/src/__tests__/setup-env.ts` reads `DATABASE_URL_TEST`, sets `DATABASE_URL` to that value within the test process, and asserts that `current_database()` matches the pattern `mythrun_test(_.+)?` before any test runs. Mismatch → throw, refuse to run. The existing `backend/src/db/__tests__/guard-db.ts` allowlist regex is updated in lockstep so the two enforcement points share one source of truth.

### 3. Per-test isolation pattern

**One pattern: scoped fixtures.**

Every test that creates rows threads a `TestScope` and cleans up via `cleanupTestScope` at `afterAll` time (not `afterEach` — per-scope cleanup, not per-test, to minimize the per-test DELETE round-trip cost). The `TestScope` produces prefixed identifiers via `scope.userSub(n)`, `scope.username(n)`, `scope.worldName(n)`, `scope.campaignName(n)`. Cleanup is `DELETE WHERE <column> LIKE 'tst-<label>-<rand>%'` for each scope-able table.

Fixture builders in `backend/src/repo/__tests__/_helpers/` are refactored so the `TestScope` parameter is mandatory and identifier arguments use branded types (`ScopedSub`, `ScopedUsername`, etc.). Only `scope.userSub(n)` produces a value of type `ScopedSub`. **Note on scope of the branded-type protection:** the brand protects fixture-builder call sites — `createUser(pool, scope, { sub: 'foo' })` fails to compile because `'foo'` is not `ScopedSub`. It does NOT propagate through `pool.query('INSERT …', [scope.userSub(0), …])` parameter arrays, because `pg.Pool.query` accepts `unknown[]` parameters and the brand widens to `string`. Direct `pool.query` mutations in tests are common and legitimate; the ESLint rule (Section 5) is the primary defense at that surface. The brand is layered defense, not airtight type-fence.

**Schema bootstrap: one place, not many.**

Migrations against `mythrun_test_<wt>` are run by a Vitest `globalSetup` script (`backend/src/__tests__/global-setup.ts`), not by per-file `beforeAll`. The script:
1. Connects to `DATABASE_URL_TEST`.
2. Runs `runMigrations` idempotently.
3. Runs `seedTestDatabase()` (the system user + demo world + dev-users + cost-cap settings rows from existing `reseedSystemRows`) idempotently via `INSERT … ON CONFLICT DO NOTHING`.
4. Returns. Vitest then dispatches test files to workers against a ready DB.

The ~38 test files that currently do their own `DROP SCHEMA public CASCADE` + `runMigrations` in `beforeAll` have those blocks removed during Phase 4. After Phase 4, no test file rebuilds the schema; the global setup runs once at process start and the DB stays migrated for the entire run.

The lint rule (Section 5) errors on `DROP SCHEMA` anywhere under `**/__tests__/**`.

**Global config: dependency injection.**

`readCostCap` / `readCharacterCreationCostCap` move from per-job DB reads to one-shot boot-time reads in `server.ts`. The result is injected as `costCapUsd: number` into `WorldGenDeps` and `CharacterCreationDeps`. Tests construct processors with whatever cap value the test needs — no `settings`-table mutation.

The same pattern applies to any future "global policy read from DB" — these are surfaced as injected dependencies, not direct DB reads inside workers.

**The `withTx` test helper and `resetData` are deleted entirely.**

`backend/src/repo/__tests__/_helpers/with-tx.ts` is removed. All 12 of its current test-file callers migrate to scoped fixtures. The lint rule flags any future re-import (banned via `no-restricted-imports`).

`backend/src/repo/__tests__/_helpers/reset-data.ts` is also removed. Its sole legitimate user (`migrate-schema.test.ts`) already uses `DROP SCHEMA public CASCADE` + `runMigrations` rather than `resetData`'s TRUNCATE — verified in the repo before this revision. So `resetData` has zero remaining callers post-Phase-4 and is just deleted. No renamed "nuclearReset" exemption, no `_helpers/dangerous/` directory.

Production-code transaction mechanics (`pool.connect()` + `BEGIN`/`COMMIT` in handlers and repos) are unaffected — they're business-logic atomicity, not test isolation.

### 4. Parallel execution

`backend/vitest.config.ts` changes:

- Remove `fileParallelism: false`.
- Explicit `pool: 'forks'` (Vitest's default since v2 PR #5047 in Jan 2024, but pinning the choice in config documents intent and shields us from a future default change).
- `poolOptions.forks.maxForks: 6` (or `cpus().length - 1`, whichever is smaller). Tunable; the 6 ceiling is from the connection-budget table below, not a CPU-bound estimate.

Each fork builds its own `pg.Pool` to `mythrun_test_<wt>`. The pool config is uniform across tests via a shared helper (`createTestPool(url)` in `_helpers/test-pool.ts`) that hard-codes `max: 4` per pool. Why uniform: most test files today set their own `max` ad hoc (1, 2, 4, default-10) and the budget arithmetic depends on a known ceiling.

**Connection budget under parallel:**

| Component | Per fork | Forks | Total |
|---|---|---|---|
| Test file pools (1 active pool per file at a time inside one fork) | 4 | 6 | 24 |
| Boot-time globalSetup pool (single shared, closed before forks start) | n/a | n/a | 0 (runtime) |
| Headroom for `pg`'s `pg_replication_slots` + maintenance | — | — | ~10 |
| **Peak concurrent connections** | — | — | **~34** |

Comfortably under the 200-connection ceiling (Section 1). If `maxForks` is bumped to 12 on a high-core machine, peak hits ~58 — still safe.

**Pool lifecycle:** each test file's `afterAll` calls `pool.end()`. Without this, forks accumulate sockets across files and the budget breaks. The lint rule errors on `createTestPool(...)` calls in test files that don't have a matching `afterAll(() => pool.end())`. (Implementable as a `no-restricted-syntax` selector pair.)

**Expected speedup:** today 1404 tests / 209s serial → roughly 60–90s parallel on a modern machine. Real-world gain dominated by Postgres I/O serialization, but ~2–3× wall-clock. Confirmed at Phase 5 verification (acceptance: ≥1.5× speedup over serial baseline; we keep current config if it falls short).

### 5. Lint enforcement

Three layers:

1. **Type-level.** Branded `ScopedSub` / `ScopedUsername` / etc. types on fixture builders make missing-scope a compile error at fixture-builder call sites. Caveat per Section 3: brand does NOT propagate through `pool.query` parameter arrays.

2. **ESLint built-in rules** in `eslint.config.js` (no custom rule needed):

   - `no-restricted-imports` on `**/__tests__/**` blocking `./_helpers/with-tx` (deleted) and `./_helpers/reset-data` (deleted). Pattern guards against re-introduction.
   - `no-restricted-syntax` on `**/__tests__/**` flagging `Literal` and `TemplateLiteral` nodes whose value contains `'DROP SCHEMA'` — this catches the per-file `DROP SCHEMA public CASCADE` pattern we removed in Phase 4. Errors out, with a message pointing to `globalSetup`.
   - `no-restricted-syntax` on `**/__tests__/**` flagging test files that call `pool.query` mutation methods (INSERT/UPDATE/DELETE) WITHOUT importing `makeTestScope` or `cleanupTestScope`. The trigger (mutation + no scope import) is rare among legitimate tests, so false-positive rate is low; the previous "always warn on INSERT/UPDATE/DELETE" framing was over-broad and is rejected.

3. **Custom ESLint rule** at `backend/eslint-rules/test-isolation.cjs` for the one detector that built-ins can't handle: the brand-stripping pattern (`as ScopedSub` cast on a non-scope value). Optional — implement only if Phase 5 review shows the type-only enforcement is being routinely bypassed.

   File extension `.cjs` and config-wiring smoke (`config-wiring.test.mjs`) follow the precedent set by `backend/eslint-rules/no-stripe-price-mutations.cjs`. Phase 5 deliverables include a RuleTester unit suite (`__tests__/test-isolation.test.cjs`) IF the custom rule is built.

4. **Conventions doc** at `backend/src/__tests__/CONVENTIONS.md` — single source of truth for the patterns, the branded types, the dep-injection rule. Written in Phase 3 (alongside the fixture refactor), not Phase 5, so contributors have the doc through the rest of the migration. Linked from `CLAUDE.md`.

### 6. Worktree mechanics

`bd worktree create .worktrees/<name>` → `cd .worktrees/<name>` → `../../scripts/worktree-setup.sh`. The setup script's new behavior:

1. Symlink `.worktreeinclude` entries (unchanged).
2. `CREATE DATABASE mythrun_test_<name>` via `docker compose exec postgres psql`.
3. Write `.env.worktree` at repo root: `DATABASE_URL_TEST=…/mythrun_test_<name>`. **Does NOT override `DATABASE_URL`** — dev DB stays shared.
4. `pnpm install`.
5. `pnpm db:migrate:test` — migrations applied to the new worktree test DB.

`scripts/worktree-remove.sh` (or current equivalent) runs `DROP DATABASE mythrun_test_<name>` as a final step.

**Migration path for existing worktrees:** the Phase 1 commit lands a one-line `scripts/worktree-migrate.sh` that converts an existing worktree's `.env.worktree` from the old `DATABASE_URL=…/mythrun_<wt>` shape to the new `DATABASE_URL_TEST=…/mythrun_test_<wt>` shape, and runs the missing `CREATE DATABASE mythrun_test_<wt>` + initial migration. Existing worktrees run this once after pulling main; documented in the Phase 1 release note that lands on `main`.

### 7. CI behavior

Single change in `.github/workflows/deploy.yml`:

```yaml
services:
  postgres:
    env:
      POSTGRES_DB: mythrun_test    # was: mythrun
…
- run: pnpm --filter @mythrun/backend test
  env:
    DATABASE_URL_TEST: postgresql://mythrun:mythrun_dev@127.0.0.1:5432/mythrun_test
    REDIS_REALTIME_URL: redis://127.0.0.1:6379
```

No other workflow changes. `_db-migrate-job.yml` (which migrates the real staging RDS) doesn't touch `DATABASE_URL_TEST`.

## Phased execution plan

Five phases. Each independently committable. Each ends with `pnpm typecheck && pnpm lint && pnpm test` clean.

### Phase 1 — Database topology + safety fence (~half day)

End state: tests run against `mythrun_test`; dev DB is never touched by `pnpm test`.

1. `ALTER DATABASE mythrun RENAME TO mythrun_dev` (local).
2. `CREATE DATABASE mythrun_test` (local).
3. `pnpm db:migrate:test` script added (`backend/package.json`).
4. `backend/.env.development` updated: `DATABASE_URL` → `mythrun_dev`.
5. `setup-env.ts` reads `DATABASE_URL_TEST`, sets `DATABASE_URL` in-process, asserts the connected DB name matches `mythrun_test(_.+)?`.
6. `backend/src/db/__tests__/guard-db.ts` regex updated to the same pattern (one source of truth).
7. `docker-compose.yml` Postgres service: bump `max_connections=200`.
8. `.github/workflows/deploy.yml` updated per Section 7.
9. Initial migration of `mythrun_test`.
10. `scripts/worktree-migrate.sh` shipped for existing worktrees; release note in commit message.

**Verification:** create a campaign via dev tool against `mythrun_dev`, run `pnpm test`, confirm campaign survives.

### Phase 2 — Dependency-inject global config (~half day)

End state: no test mutates `settings` to influence worker behavior.

1. `WorldGenDeps` + `CharacterCreationDeps` gain `costCapUsd: number`.
2. Processors use `deps.costCapUsd` instead of `readCostCap` / `readCharacterCreationCostCap`.
3. `server.ts` reads cost-caps from DB at boot, injects into both processors.
4. `cost-cap.test.ts`, `world-gen-processor.test.ts`, `character-creation-processor.test.ts` updated to pass `costCapUsd` directly.
5. Audit other "global read from DB" patterns in workers; refactor any to dep-injection.
6. Remove the try/catch precheck in world-gen-processor and the mirror in character-creation-processor (today's symptom-fix becomes unnecessary).

**Verification:** all settings-related tests pass without touching the `settings` table.

### Phase 3 — Infra: globalSetup, branded TestScope, CONVENTIONS.md (~1 day)

End state: schema bootstrap centralized; fixture builders require `TestScope`; identifier arguments use branded types; contributors have a written guide before file-by-file migration starts.

1. Write `backend/src/__tests__/global-setup.ts`: opens one pool, runs `runMigrations`, runs `seedTestDatabase()` (idempotent), closes pool, returns. Hooked into `vitest.config.ts` via `globalSetup: ['./src/__tests__/global-setup.ts']`.
2. Move `reseedSystemRows` contents (system user + demo world + dev-users + cost-cap settings rows) into `seedTestDatabase()`.
3. Add `createTestPool(url)` helper at `backend/src/repo/__tests__/_helpers/test-pool.ts` — uniform `max: 4` pool config used by all test files.
4. Define `ScopedSub`, `ScopedUsername`, `ScopedWorldName`, `ScopedCampaignName` as branded types in `_helpers/test-scope.ts`.
5. Update `makeTestScope` return type accordingly.
6. Refactor all fixture builders in `_helpers/` to require `TestScope` + branded-type arguments.
7. Migrate the 24 currently-scoped test files' call sites to the new fixture-builder signatures + `createTestPool` + `afterAll(() => pool.end())`.
8. Write `backend/src/__tests__/CONVENTIONS.md` covering: the scoping pattern, branded types, dep-injection rule, globalSetup architecture, the absence of `withTx` and `resetData`, the `createTestPool` + `afterAll` pool-end requirement. Link from `CLAUDE.md`.

**Verification:** `pnpm typecheck` passes; the 24 already-scoped tests still pass (now using `globalSetup` for migrations).

### Phase 4 — Migrate the 32 remaining test files (~2 days)

End state: every test file uses scoped fixtures; no test file does its own `DROP SCHEMA` + `runMigrations`.

Source of truth for the file list (regenerated before this phase starts):

```bash
grep -rl "from.*reset-data" backend/src --include='*.test.ts'  # 20
grep -rl "from.*with-tx"     backend/src --include='*.test.ts'  # 12
```

The implementer dispatching Phase 4 runs these greps fresh and groups the union (~32 distinct files) into waves. The wave list below is a SUGGESTED grouping; the actual list comes from the live grep.

**Per-file migration recipe** (applied identically across all 32 files):

1. Remove `from '../../repo/__tests__/_helpers/reset-data.js'` and any `from '../../repo/__tests__/_helpers/with-tx.js'` imports.
2. Remove any `beforeAll(async () => { await pool.query('DROP SCHEMA public CASCADE …'); await runMigrations(…) })` block. `globalSetup` (Phase 3) handles this once per process.
3. Replace per-test `resetData(pool)` or `withTx(...)` with `cleanupTestScope(pool, scope)` in `afterAll`, plus `const scope = makeTestScope('<label>')` at the top of the suite.
4. Update fixture-builder call sites to thread `scope` and use branded identifier helpers.
5. Add `afterAll(async () => { await pool.end() })`.
6. Run `pnpm vitest run <this-file>` (not `pnpm test`) — single-file iteration ~5s.

**Waves (suggested grouping; regenerate from live grep before dispatching):**

- **Wave 4a — billing/webhook files** (~6): smallest surface, no FK chains beyond users + stripe_events.
- **Wave 4b — repo unit tests** (~10): mechanical conversion, well-isolated.
- **Wave 4c — LLM stage tests** (~6): custom seeders need `scope` threaded.
- **Wave 4d — bypass-auth integration tests** (~3): thread `x-mythrun-dev-sub: scope.userSub(1)` through.
- **Wave 4e — remaining repo + worlds.test.ts** (~7): `worlds.test.ts` last because of the seeded demo-world assertions.

Verification per wave: `pnpm vitest run <wave-files-glob>` (single-digit seconds). Full `pnpm test` ONLY as the final gate at end of the wave, before moving to the next wave. Iteration-vs-gate distinction matters: full-suite verification on every file edit during a wave would burn ~3.5 minutes per cycle.

### Phase 5 — Parallelism + lint + decommission (~half day)

End state: parallelism on; lint enforcing scope; old machinery deleted.

1. Delete `backend/src/repo/__tests__/_helpers/with-tx.ts`.
2. Delete `backend/src/repo/__tests__/_helpers/reset-data.ts` (zero callers remain — verified by grep before deletion).
3. Add ESLint config entries to `eslint.config.js`:
   - `no-restricted-imports` for the two deleted helper paths.
   - `no-restricted-syntax` for `DROP SCHEMA` Literal/TemplateLiteral in `**/__tests__/**`.
   - `no-restricted-syntax` for the "mutates but doesn't import scope" pattern.
4. (Optional) Build the custom rule `backend/eslint-rules/test-isolation.cjs` + RuleTester suite + config-wiring smoke. Skip if Phase 4 evidence shows built-in rules sufficient.
5. Update `scripts/worktree-setup.sh` and `scripts/worktree-remove.sh` per Section 6.
6. Remove `fileParallelism: false` from `vitest.config.ts`. Set `pool: 'forks'`, `poolOptions.forks.maxForks: 6`.
7. Run parallel `pnpm test`. Confirm wall-clock speedup ≥1.5× over baseline. If not, tune `maxForks` down or up and re-measure.

**Verification:**

- `pnpm test` clean against `mythrun_test`.
- Fresh worktree creation → migrations → `pnpm test` clean against `mythrun_test_<wt>`.
- `mythrun_dev` survives a `pnpm test` run (acceptance test: pre-create a sentinel row, run tests, sentinel still there).
- Parallel speedup ≥1.5× over serial baseline. If not, defer the `pool` change and file a follow-up bead for the template-DB pattern.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Some test silently relies on the TRUNCATE side-effect (assumes empty table at start). | Wave-by-wave migration with `pnpm vitest run <wave-files-glob>` after each wave surfaces these one at a time. |
| Postgres `max_connections` limit hit under parallel + many workers. | Section 1's bump to 200 + Section 4's uniform `max: 4` per pool + `maxForks: 6` keeps peak at ~34 connections. Headroom is large. |
| `worlds.test.ts` demo-world reliance breaks during migration. | Last in Wave 4e (deliberate). Seeded rows stay outside any scope; asserts read them as before. |
| ESLint rule has false positives that paper-cut contributors. | Built-in rules (`no-restricted-imports`, `no-restricted-syntax`) are well-scoped; the "mutates without scope import" trigger is rare among legitimate tests. Custom rule is opt-in. |
| Branded-type refactor breaks compilation across many call sites simultaneously. | Phase 3 dedicated to the refactor; the 24 already-scoped files migrate in the same phase. Phase 4 then runs against the new signatures. |
| CI test step picks up wrong env var. | The safety fence in `setup-env.ts` + `guard-db.ts` allowlist catches mismatched DB names. |
| `cleanupTestScope` LIKE-pattern DELETEs scan unindexed columns. | Add a migration (`backend/migrations/NNN_test_scope_indexes.sql`) creating `text_pattern_ops` btree indexes on `users.cognito_sub`, `worlds.name`, `campaigns.name`. Optional optimization; revisit if Phase 5 wall-clock falls short. |
| Existing worktree's `.env.worktree` has the old `DATABASE_URL=…/mythrun_<wt>` shape after Phase 1 lands. | `scripts/worktree-migrate.sh` (Phase 1) handles the conversion. Release note in the Phase 1 commit message tells affected devs to run it. |
| Parallel speedup falls short of 1.5×. | Phase 5 acceptance gate: if speedup < 1.5×, defer the parallelism change and open a follow-up bead to evaluate per-test-DB template cloning (pgtestdb / IntegreSQL pattern). Don't ship slower-than-serial parallel. |

## Out of scope (future work)

- **Template-database per-test (pgtestdb / IntegreSQL pattern).** Genuine state-of-the-art for Postgres test isolation. Eliminates seed-row maintenance as a separate source of truth. Earned upgrade if Phase 5 speedup misses the 1.5× gate, or if a future feature surfaces a global table that can't be scope-prefixed.
- **PGlite for inner-loop dev tests.** Once mature, could be a separate suite (`pnpm test:fast`) for repository-shaped tests. Revisit in 2026 H2.
- **Testcontainers in CI.** Could replace the service-container approach if multi-Postgres-version testing becomes a requirement.
- **Production transaction helper consolidation.** `pool.connect()` + manual `BEGIN`/`COMMIT` is scattered across handlers; a `withTransaction` helper at the production layer is a separate refactor.
- **`cleanupTestScope` index optimization.** Added in the Risks table; ship only if the Phase 5 wall-clock measurement says it's needed.

## Source — files touched

Backend:

- `backend/.env.development` (Phase 1)
- `backend/vitest.config.ts` (Phase 3 — globalSetup; Phase 5 — parallelism)
- `backend/package.json` (Phase 1 — `db:migrate:test` script)
- `backend/src/__tests__/setup-env.ts` (Phase 1)
- `backend/src/__tests__/global-setup.ts` (Phase 3 — new file)
- `backend/src/__tests__/CONVENTIONS.md` (Phase 3 — new file)
- `backend/src/db/__tests__/guard-db.ts` (Phase 1 — regex update)
- `backend/src/repo/__tests__/_helpers/test-scope.ts` (Phase 3 — branded types)
- `backend/src/repo/__tests__/_helpers/test-pool.ts` (Phase 3 — new file)
- `backend/src/repo/__tests__/_helpers/with-tx.ts` (Phase 5 — deleted)
- `backend/src/repo/__tests__/_helpers/reset-data.ts` (Phase 5 — deleted)
- `backend/src/repo/__tests__/_helpers/*.ts` (Phase 3 — fixture builders refactored)
- `backend/src/llm/prep/world-gen-processor.ts` (Phase 2)
- `backend/src/llm/prep/character-creation-processor.ts` (Phase 2)
- `backend/src/server.ts` (Phase 2 — cost-cap dep injection)
- The 32 test files migrated in Phase 4 (regenerated from live grep)

Infra/tooling:

- `docker-compose.yml` (Phase 1 — `max_connections=200`)
- `.github/workflows/deploy.yml` (Phase 1)
- `scripts/worktree-setup.sh` (Phase 1 + Phase 5)
- `scripts/worktree-remove.sh` (Phase 5)
- `scripts/worktree-migrate.sh` (Phase 1 — new file)
- `eslint.config.js` (Phase 5)
- `backend/eslint-rules/test-isolation.cjs` (Phase 5 — optional)
- `backend/eslint-rules/__tests__/test-isolation.test.cjs` (Phase 5 — only if custom rule built)

Docs:

- `CLAUDE.md` (Phase 3 — link to CONVENTIONS.md)
