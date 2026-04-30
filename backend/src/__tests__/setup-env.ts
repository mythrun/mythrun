import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, vi } from 'vitest'

// Resolve relative to this file, not CWD — works whether vitest is invoked
// from `pnpm --filter @mythrun/backend test` (CWD = backend/) or from a
// root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })

// Global teardown: any test that uses `vi.stubEnv(...)` to mutate process.env
// gets cleanup automatically so env-mutations don't leak to sibling tests
// across Vitest's parallel workers. The bypass-plugin tests rely on this.
afterEach(() => {
  vi.unstubAllEnvs()
})
