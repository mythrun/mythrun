import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // RAM guard (each worker ~1-3GB under v8 coverage; an uncapped pool ×
    // concurrent runs OOM-crashed this 16GB machine). See
    // frontend/vitest.config.ts for the full rationale.
    maxWorkers: 3,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // No %-gate yet: the package shell holds only the marker const
      // (`src/index.ts`). When the real schemas + events land in later tasks,
      // the response/event Zod logic joins the tiered coverage gate. The
      // types-only barrels carry no runtime logic and stay un-gated.
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts'],
    },
  },
})
