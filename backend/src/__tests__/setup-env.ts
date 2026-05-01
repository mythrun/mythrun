import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, vi } from 'vitest'

// Resolve relative to this file, not CWD — works whether vitest is invoked
// from `pnpm --filter @mythrun/backend test` (CWD = backend/) or from a
// root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })

// CI fallback: `.env.development` is gitignored and not present in CI runs,
// so dotenv silently no-ops and AUTH_MODE / NODE_ENV stay undefined. Tests
// that exercise loadEnv (and indirectly the auth plugins) need a safe-dev
// baseline. Plain assignment (not vi.stubEnv) so the values survive
// vi.unstubAllEnvs() between tests. Tests that override via vi.stubEnv
// still work; vi.unstubAllEnvs restores TO this baseline, not to undefined.
process.env.AUTH_MODE ??= 'bypass'
process.env.NODE_ENV ??= 'development'

// Global teardown: any test that uses `vi.stubEnv(...)` to mutate process.env
// gets cleanup automatically so env-mutations don't leak to sibling tests
// across Vitest's parallel workers. The bypass-plugin tests rely on this.
afterEach(() => {
  vi.unstubAllEnvs()
})
