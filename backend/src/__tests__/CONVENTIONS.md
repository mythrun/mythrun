# Test Conventions

Single source of truth for how the Mythrun backend test suite is structured. If a test file deviates from these conventions, it should explain why in a header comment.

## Database lifecycle

Tests target `mythrun_test` (or `mythrun_test_<worktree>` inside a worktree). The dev server uses `mythrun_dev`. Never the twain shall meet — `setup-env.ts` and `guard-db.ts` both refuse to run if the connected DB name doesn't match `^mythrun_test(_.+)?$`.

`backend/src/__tests__/global-setup.ts` runs once per worker process at startup. It:
- Applies pending migrations idempotently.
- Inserts the system user, demo world, dev-users (`dev-user-1` … `dev-user-5`), and the cost-cap settings rows. All `ON CONFLICT DO NOTHING` so re-runs are safe.

No test file should do its own `DROP SCHEMA` + `runMigrations`. The Phase 5 ESLint rule errors on `DROP SCHEMA` literals in `**/__tests__/**`.

## One isolation pattern: scoped fixtures

Every test that creates rows threads a `TestScope`:

```ts
import { afterAll, describe, it } from 'vitest'
import { makeTestScope, cleanupTestScope } from '../_helpers/test-scope.js'
import { createTestPool } from '../_helpers/test-pool.js'

describe('something', () => {
  const pool = createTestPool(process.env.DATABASE_URL ?? '')
  const scope = makeTestScope('my-feature')

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  it('does the thing', async () => {
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username, free_trial_used)
       VALUES (uuid_generate_v7(), $1, 'Test User', $2, false)`,
      [scope.userSub(0), scope.username(0)],
    )
    // ...
  })
})
```

`scope.userSub(n)` returns a `ScopedSub` (branded `string`) that only the scope can produce. Fixture builders that take `sub: ScopedSub` reject raw strings at the type level.

**Caveat:** the brand widens to `string` when passed to `pg.Pool.query`'s `unknown[]` params array. Tests that build SQL directly are on the honor system at that surface — the Phase 5 ESLint rule (`no-restricted-syntax` matching un-scoped mutations) is the primary defense there.

## Pool lifecycle

Every test file uses `createTestPool(url)` to build its pool, and calls `pool.end()` in `afterAll`. Otherwise the worker fork accumulates sockets across files and the parallel-execution connection budget breaks.

Budget reference (Section 4 of the spec):
- `max: 4` per pool, `maxForks: 6` Vitest forks → peak ~24 active connections under parallel.
- The postgres docker service is configured with `max_connections=200`. Plenty of headroom.

## Global config

Cost-caps (and similar global policy values) are dependency-injected into the worker deps. Tests construct processors with arbitrary `costCapUsd` values directly — never `UPDATE settings`. The processor stays stateless re. global config; an operator changing the settings rows requires a worker restart for the change to take effect.

## What about transactions?

Production code can use `pool.connect()` + `BEGIN`/`COMMIT` freely; that's business-logic atomicity, not test isolation. There's no `withTx` test helper any more — Phase 5 deleted it. Tests that genuinely need transactional behavior of the code-under-test should pass the production-grade client through, not use a test-only transaction helper.

## What about `resetData`?

Deleted (Phase 5). The schema bootstrap is `globalSetup`'s job; data isolation is scoped fixtures' job. There's no nuclear-reset escape hatch in normal test files. The migration-schema test (`src/db/__tests__/migrate-schema.test.ts`) does its own `DROP SCHEMA public CASCADE` + `runMigrations` because it's testing the migration runner itself — that's the single legitimate exemption, and the ESLint rule's allowlist points at it specifically.

## Lint enforcement

`eslint.config.js` (Phase 5):
- `no-restricted-imports` blocks importing the deleted `with-tx` and `reset-data` helpers.
- `no-restricted-syntax` errors on `DROP SCHEMA` SQL literals in tests.
- `no-restricted-syntax` warns on test files that mutate the DB (INSERT/UPDATE/DELETE in `pool.query`) without importing `makeTestScope` or `cleanupTestScope`.

Don't suppress these rules without a header comment explaining why.

## Worktrees

`bd worktree create` provisions a per-worktree `mythrun_test_<wt>` database. Dev DB is shared across worktrees (one `mythrun_dev` for everyone). Concurrent worktrees can run `pnpm test` in parallel without colliding on global tables.

Existing worktrees from before the myth-oehx change: run `scripts/worktree-migrate.sh` once to convert the old `.env.worktree` shape.

## When to break the rules

If a test legitimately needs to behave differently (e.g., the `migrate-schema.test.ts` exemption), add a header comment explaining why. Reviewers will check.
