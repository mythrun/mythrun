import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // RAM guard (each worker ~1-3GB under jsdom + v8 coverage; an uncapped
    // 8-wide pool × concurrent runs OOM-crashed this 16GB machine). See
    // frontend/vitest.config.ts for the full rationale.
    maxWorkers: 3,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Logic only (tiered coverage), mirroring frontend/vitest.config.ts.
      // Today the library logic is `src/lib/**` (cn() and friends) plus the
      // a11y/DOM-purity lint rules under `eslint-rules/**` (those land in a
      // later MYT-82 bead). Presentational components (`src/components/**/*.tsx`)
      // are BEHAVIOR-tested with RTL + axe but intentionally NOT %-gated —
      // rendered in tests, not counted toward the coverage threshold. Stories
      // and the foundation specimen are likewise excluded.
      include: ['src/lib/**', 'eslint-rules/**/*.js'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.stories.tsx', 'src/components/**/*.tsx'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      // When the lint-rule wiring tests arrive (per the vitest-v8 double-load
      // gotcha — an integration test that loads a rule through ESLint's own
      // config loader corrupts the v8 coverage map for that file), the
      // `test:coverage` script must RUN-exclude them
      // (`--exclude '**/config-wiring.test.ts'` / `'**/*.wiring.test.ts'`),
      // exactly as @mythrun/web does. The rule's coverage is then measured by
      // its RuleTester unit test; the wiring test still runs (and is gated)
      // under the plain `test` script in CI.
    },
  },
})
