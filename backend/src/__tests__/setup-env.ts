import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, vi } from 'vitest'

// Resolve relative to this file, not CWD — works whether vitest is invoked
// from `pnpm --filter @mythrun/backend test` (CWD = backend/) or from a
// root-level `pnpm test` (CWD = repo root).
const here = fileURLToPath(import.meta.url)
config({ path: resolve(here, '../../../.env.development') })

// Worktree override: `scripts/worktree-setup.sh` writes a repo-root
// `.env.worktree` so concurrent worktrees can each target their own
// Postgres DB (mythrun_<worktree>) without colliding on TRUNCATE in
// resetData. Main repo has no `.env.worktree` — load is a no-op.
// Loaded AFTER `.env.development` with override:true so DATABASE_URL
// from the worktree file wins.
const worktreeEnv = resolve(here, '../../../../.env.worktree')
if (existsSync(worktreeEnv)) {
  config({ path: worktreeEnv, override: true })
}

// CI fallback: `.env.development` is gitignored and not present in CI runs,
// so dotenv silently no-ops and AUTH_MODE / NODE_ENV stay undefined. Tests
// that exercise loadEnv (and indirectly the auth plugins) need a safe-dev
// baseline. Plain assignment (not vi.stubEnv) so the values survive
// vi.unstubAllEnvs() between tests. Tests that override via vi.stubEnv
// still work; vi.unstubAllEnvs restores TO this baseline, not to undefined.
process.env.AUTH_MODE ??= 'bypass'
process.env.NODE_ENV ??= 'development'
process.env.MYTHRUN_ENV ??= 'development'
process.env.REGION_PREFIX ??= 'use1'
process.env.FRONTEND_BASE_URL ??= 'http://localhost:5173'
process.env.STRIPE_SECRET_KEY ??= 'rk_test_baseline_for_setup_env'
process.env.STRIPE_WEBHOOK_SECRET ??= 'PLACEHOLDER'
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-baseline-for-setup-env'

// Global teardown: any test that uses `vi.stubEnv(...)` to mutate process.env
// gets cleanup automatically so env-mutations don't leak to sibling tests
// across Vitest's parallel workers. The bypass-plugin tests rely on this.
afterEach(() => {
  vi.unstubAllEnvs()
})
