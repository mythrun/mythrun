import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Logic only (tiered coverage). Today that is the custom lint rule;
      // extend with 'src/lib/**', 'src/hooks/**', 'src/api/**',
      // 'src/transport/**' in later issues as those land. Presentational
      // components (*.tsx), routes, and stories are intentionally excluded
      // from the percentage — rendered in tests, not %-gated.
      include: ['eslint-rules/**/*.js'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      // The `test:coverage` script excludes `config-wiring.test.ts` from the
      // RUN (not here — this is the source-report exclude). That integration
      // test loads the rule through ESLint's own config loader (top-level
      // only, never invoking the visitors), which corrupts the v8 coverage
      // map for the rule file and makes the 100% gate non-deterministic. The
      // rule's coverage is measured by its RuleTester unit test; the wiring
      // test still runs (and is gated) under the plain `test` script in CI.
    },
  },
})
