import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  // Mirror of vite.config.ts's dedupe (this config does not extend it). Keeps
  // the test runtime on a single react / react-dom / react-query copy too, so
  // the provider stack renders against the same instances the app ships.
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  test: {
    // RAM guard: cap the worker pool. Vitest pools ~1 worker per core (8 here)
    // and each worker is ~1-3GB under jsdom + v8 coverage; an uncapped pool ×
    // concurrent runs OOM-crashed this 16GB machine. 3 keeps a full coverage
    // run comfortably under RAM. Kept in lockstep across the 3 frontend configs.
    maxWorkers: 3,
    // A jsdom env that keeps Node's NATIVE Fetch-API stack (fetch/Request/
    // AbortController/AbortSignal/…) instead of jsdom's. Node 24's undici v7
    // brand-checks `Request`'s abort signal against its own `AbortSignal`, and
    // jsdom's copies fail that check — which breaks React-Router v7's data
    // router under jsdom (every navigation builds a `Request`), exactly what
    // the app-shell router tests drive. A strict superset of jsdom (it only
    // re-applies natives), safe for the whole suite. See the env module's
    // header + vitest-dev/vitest#8374 (fixed upstream in vitest 4 / PR #8390).
    environment: './test/jsdom-native-fetch.ts',
    // Global stubs for web APIs jsdom lacks (IntersectionObserver). Loaded for
    // every suite: AppFrame mounts the scroll-elevation observer on nearly
    // every route, so any route test would crash without it.
    setupFiles: ['./test/setup.ts'],
    // @mythrun/web is the root frontend package; `client-core/`, `ui/`, and
    // `contract/` are NESTED workspace packages that each own their own vitest
    // config + run. Without these excludes, web's default `frontend/**` discovery
    // would pick up their *.test.* files and run them here too — out of their own
    // package context (wrong setup/coverage config) and double-counted in CI. Each
    // nested package runs under its own `pnpm --filter` test script.
    exclude: [...configDefaults.exclude, 'client-core/**', 'ui/**', 'contract/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Logic only (tiered coverage): the custom lint rule + the `platform/web`
      // impls (MYT-83 — the web side of client-core's platform interfaces, e.g.
      // the SecureStorage localStorage impl). Extend with 'src/api/**' etc. in
      // later issues as those land. Presentational components (*.tsx), routes,
      // and stories are intentionally excluded — rendered in tests, not %-gated.
      // The `*.wiring.test.ts` files are excluded from the `test:coverage` RUN
      // (in the package.json script, alongside `config-wiring.test.ts`): they
      // load `eslint.config.js` top-level, which corrupts the v8 coverage map
      // for the rule files (the documented double-load deflation). They still
      // run + gate under the plain `test` script.
      include: ['eslint-rules/**/*.js', 'src/platform/web/**'],
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
