import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // RAM guard: cap the worker pool. Vitest pools ~1 worker per core (8 here)
    // and each worker is ~1-3GB under jsdom + v8 coverage; an uncapped pool ×
    // concurrent runs OOM-crashed this 16GB machine. 3 keeps a full coverage
    // run comfortably under RAM. Kept in lockstep across the 3 frontend configs.
    maxWorkers: 3,
    environment: 'jsdom',
    // @mythrun/web is the root frontend package; `client-core/` and `ui/` are
    // NESTED workspace packages that each own their own vitest config + run.
    // Without these excludes, web's default `frontend/**` discovery would pick
    // up their *.test.* files and run them here too — out of their own package
    // context (wrong setup/coverage config) and double-counted in CI. Each
    // nested package runs under its own `pnpm --filter` test script.
    exclude: [...configDefaults.exclude, 'client-core/**', 'ui/**'],
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
