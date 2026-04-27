import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Resolve relative to this file, not CWD — works whether vitest is invoked
// from `pnpm --filter @mythrun/backend test` (CWD = backend/) or from a
// root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })
