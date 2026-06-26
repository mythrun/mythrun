import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // jsdom: the data layer (React Query hooks, zustand stores, @testing-library
    // render harnesses) lands in Wave 1 and needs a DOM for component tests.
    // The R1 lint keeps client-core's PRODUCTION source DOM-free; jsdom here is
    // strictly for the TEST environment.
    environment: 'jsdom',
    // RAM guard (each worker ~1-3GB under v8 coverage; an uncapped pool ×
    // concurrent runs OOM-crashed this 16GB machine). See
    // frontend/vitest.config.ts for the full rationale.
    maxWorkers: 3,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Logic only (tiered coverage), mirroring frontend/vitest.config.ts and
      // @mythrun/ui. Today the package logic is the token scale math
      // (`src/tokens/scales.ts`) plus the portability lint rules under
      // `eslint-rules/**` (api-purity, R2). The types-only contract barrel
      // (`src/contract/index.ts`) and the build-time palette generator
      // (`src/tokens/generate-palette.mjs`) carry no runtime logic and are
      // intentionally NOT %-gated.
      //
      // Wave 1 (MYT-83) adds the data layer: the typed API client (`src/api/**`),
      // zustand stores (`src/stores/**`), and the platform-capability interfaces
      // (`src/platform/**`). They join the 100% gate here. The dirs are empty
      // today (later tasks fill them); empty globs contribute no files and don't
      // break the gate.
      include: [
        'src/tokens/scales.ts',
        'src/api/**',
        'src/auth/**',
        'src/stores/**',
        'src/platform/**',
        'eslint-rules/**/*.js',
      ],
      exclude: ['**/*.test.ts'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
      // The `test:coverage` script RUN-excludes `*.wiring.test.ts` (the
      // vitest-v8 double-load gotcha: an integration test that loads a rule
      // through ESLint's own config loader corrupts the v8 coverage map for
      // that rule file, making the 100% gate non-deterministic). The rule's
      // coverage is measured by its RuleTester unit test (`api-purity.test.ts`);
      // the wiring test still runs (and is gated) under the plain `test` script.
    },
  },
})
