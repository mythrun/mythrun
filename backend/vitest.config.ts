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
  'src/contract/pipeline-jobs.ts',
  // Stripe SDK pricing-data fixture — module-level price tables that are
  // imported wholesale; the contract is "data is present + well-typed,"
  // covered by lookup-keys.test.ts which dereferences it.
]

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    fileParallelism: false,
    // The mythrun/eslint-rules RuleTester scripts (.test.cjs) are run directly
    // via `node`, not Vitest — they don't expose describe/it. The wiring smoke
    // test (.test.mjs) IS a Vitest test and stays included.
    exclude: ['**/node_modules/**', '**/dist/**', '**/eslint-rules/**/*.test.cjs'],
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
