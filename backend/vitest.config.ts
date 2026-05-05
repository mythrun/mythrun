import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    fileParallelism: false,
    // The mythrun/eslint-rules RuleTester scripts (.test.cjs) are run directly
    // via `node`, not Vitest — they don't expose describe/it. The wiring smoke
    // test (.test.mjs) IS a Vitest test and stays included.
    exclude: ['**/node_modules/**', '**/dist/**', '**/eslint-rules/**/*.test.cjs'],
  },
})
