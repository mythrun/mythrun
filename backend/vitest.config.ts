import { defineConfig } from 'vitest/config'

// Coverage philosophy: 100% on production code that the pre-push hook
// gates. Anything excluded below MUST have a one-line justification —
// genuinely-untestable boot/process glue, type-only files, or scripts
// that run outside the request lifecycle. Adding to this list is a
// design decision, not a place to hide untested work.
const COVERAGE_EXCLUDES: readonly string[] = [
  'src/**/__tests__/**',
  'src/**/*.test.ts',
  'src/**/*.d.ts',
  // Process-level entrypoint: actually exits the process; covered by smoke
  // tests, not vitest. The boot orchestration helpers it composes (signal-
  // handlers, env loader, app builder) ARE unit-tested individually.
  'src/server.ts',
  // Same: worker process entrypoint.
  'src/worker.ts',
  // BullMQ producer-queue factories + boot-gate stubs, extracted verbatim from
  // the (also-excluded) server.ts. Each build*Queue constructs a Redis-bound
  // BullMQ Queue at boot — not vitest-unit-testable without a live Redis; the
  // trivial adapter passthroughs are exercised by the route enqueue spies +
  // the MYT-64 E2E smoke. Excluding preserves the pre-extraction posture.
  'src/server-queues.ts',
  // One-shot CLI: runs migrations against a real DB. Migration logic itself
  // is exercised by every integration test's beforeAll runMigrations() call.
  'src/db/migrate.ts',
  // Standalone debug script for unsanitized LLM error inspection during
  // E2E smoke work. Not part of the served surface.
  'src/scripts/**',
  // Re-export barrels — covered transitively when consumers import them.
  'src/repo/index.ts',
  // Pure type / interface files — no executable code to cover. Each one
  // has been verified to contain only `type`, `interface`, `declare`, or
  // const enums imported by tests transitively.
  'src/app-deps.ts',
  'src/auth/types.ts',
  'src/billing/errors.ts',
  'src/billing/webhook-types.ts',
  'src/repo/types.ts',
  // Minimal pg.ClientLike interface — type-only, no runtime code.
  'src/repo/_types.ts',
  // MYT-68 tier-boundary seam — type/interface-only (FtTurnContext, TurnEmitter,
  // LedgerUpdatePayload, the frame payload types). No executable code; consumers
  // import the types transitively.
  'src/session/tiers/types.ts',
  'src/contract/pipeline-jobs.ts',
  // Stripe SDK pricing-data fixture — module-level price tables that are
  // imported wholesale; the contract is "data is present + well-typed,"
  // covered by lookup-keys.test.ts which dereferences it.
]

// myth-oehx P5.6: parallel test execution split into two projects so test
// AND test:coverage both get the benefit in one vitest invocation.
//
//   - 'serial' runs the two schema-mutating migration tests (DROP SCHEMA)
//     in a SINGLE fork. Under parallel forks they'd race with sibling
//     forks reading the same `mythrun_test` DB.
//   - 'parallel' runs everything else with maxForks: 6. Per-fork pool
//     max=4 via createTestPool → peak ~24 concurrent connections, well
//     under the 200 max_connections ceiling in docker-compose.yml.
//
// Projects share globalSetup, setupFiles, env, and coverage config. The
// pool/poolOptions are project-local.
const SERIAL_FILES = [
  'src/db/__tests__/migrate.test.ts',
  'src/db/__tests__/migrate-schema.test.ts',
  // invites.test.ts does `ALTER TABLE campaign_invites DROP CONSTRAINT`
  // mid-test to simulate a dangling FK. ALTER takes ACCESS EXCLUSIVE
  // lock; under parallel forks it deadlocks with sibling readers of
  // campaign_invites. Serializing is cheaper than refactoring the test.
  'src/routes/__tests__/invites.test.ts',
  // cost-cap.test.ts and world-gen-processor.test.ts both INSERT/UPDATE/DELETE
  // the SAME global `settings` rows (world_gen_cost_cap_usd, character_
  // creation_cost_cap_usd) — that key is a singleton config, not scopeable by
  // a per-test uuid, so under parallel forks one file's mutation races the
  // other's read. Serializing them into one fork makes those mutations
  // sequential. (myth- data-layer refactor; reference_parallel_worktree_db_collision.)
  'src/llm/prep/__tests__/cost-cap.test.ts',
  'src/llm/prep/__tests__/world-gen-processor.test.ts',
  // coherence-pass.test.ts seeds + lowers the SAME global settings row
  // (world_gen_cost_cap_usd) for the cap-fire test — serialize with the other
  // settings-mutating files. (data-layer refactor.)
  'src/llm/prep/stages/__tests__/coherence-pass.test.ts',
  // world-snapshot-view.test.ts does a heavy multi-table seed + read; under
  // peak 6-fork DB contention its real work occasionally exceeds the 5s test
  // timeout (passes deterministically in isolation). Serializing removes it
  // from the parallel-storm pool.
  'src/repo/__tests__/world-snapshot-view.test.ts',
  // pipeline-subscriber.test.ts gates Redis pub/sub fan-out on fixed
  // setTimeout windows (e.g. 50ms for SUBSCRIBE to register before publish).
  // Under peak 6-fork load those windows occasionally lapse (passes 19/19 in
  // isolation). Serializing removes it from the parallel-storm pool. (A
  // condition-based rewrite would be the durable fix; out of scope here.)
  'src/sse/__tests__/pipeline-subscriber.test.ts',
]

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    // The mythrun/eslint-rules RuleTester scripts (.test.cjs) are run directly
    // via `node`, not Vitest — they don't expose describe/it. The wiring smoke
    // test (.test.mjs) IS a Vitest test and stays included.
    exclude: ['**/node_modules/**', '**/dist/**', '**/eslint-rules/**/*.test.cjs'],
    // Project-level pool options are limited to `isolate` and `singleFork`;
    // `maxForks` is configured at the root level (see below). singleFork:
    // true makes the serial project run all its tests in one fork process.
    projects: [
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL_FILES,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        extends: true,
        test: {
          name: 'parallel',
          exclude: SERIAL_FILES,
          pool: 'forks',
        },
      },
    ],
    // Root-level pool config — the 'parallel' project inherits this.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 6 } },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['src/**/*.ts'],
      exclude: [...COVERAGE_EXCLUDES],
      // Hard gate: anything less than 100% fails the run. The pre-push
      // hook ships this; CI re-asserts it. Drop below 100% only by adding
      // a documented entry to COVERAGE_EXCLUDES above.
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
})
