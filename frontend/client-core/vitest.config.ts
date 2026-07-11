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
      // zustand stores (`src/stores/**`), and the platform-capability layer
      // (`src/platform/**` — the RUNTIME ports like `streaming-fetch.ts`; the
      // types-only interface ports are excluded below). They join the 100% gate
      // here. The dirs are empty today (later tasks fill them); empty globs
      // contribute no files and don't break the gate.
      include: [
        'src/tokens/scales.ts',
        'src/api/**',
        'src/auth/**',
        'src/stores/**',
        'src/platform/**',
        // The realtime transport (MYT-85): the connection primitive + the WS/SSE
        // clients + the ws-ticket endpoint. Production-grade reconnection logic —
        // 100%-gated. The `*.fixtures.ts` test-double (a MockWebSocket + frame
        // builders + a reference reducer) is test infra, not production code, so
        // it is excluded below alongside the `*.test.ts` files.
        'src/realtime/**/*.ts',
        // The world-gen streaming-graph brain (MYT-89 Phase C): the SSE-event →
        // nodes/edges fold (C1 graph-reducers), the d3-force node-identity
        // wrapper (C2 force-sim), and the DOM-free data-layer hook (C5
        // use-worldgen-stream) that opens the status SSE, rehydrates from the
        // world-snapshot, and branches the failure→resume path. 100%-gated.
        'src/worldgen/**/*.ts',
        // MYT-90 character creation: the SRD catalog + subclass-at-level table (B1)
        // and the client-core brain — flatten-to-conceptText, the guided reducer,
        // the create-flow machine, and the sheet/roster view-models (B4). All
        // runtime logic; 100%-gated.
        'src/srd/**/*.ts',
        'src/character/**/*.ts',
        'eslint-rules/**/*.js',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.fixtures.ts',
        // Types-only platform-capability PORTS (R1): `oauth-state-store.ts` and
        // `secure-storage.ts` declare ONLY interfaces (plus a type-only import),
        // so they ERASE to an empty module at compile time (esbuild emits 0 bytes).
        // Nothing at runtime ever loads them — the `src/platform/**` include glob
        // forces the un-executed source into the report, where v8 (having no
        // execution record for a file with no emitted code) shows 0% and fails the
        // gate. No test can ever "run" an empty module. Like the types-only contract
        // barrel (`src/contract/index.ts`) and the build-time palette generator, they
        // carry no runtime logic and are intentionally NOT %-gated. Their web/native
        // IMPLEMENTATIONS (which DO have runtime code) live in @mythrun/web and are
        // gated there.
        'src/platform/oauth-state-store.ts',
        'src/platform/secure-storage.ts',
      ],
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
