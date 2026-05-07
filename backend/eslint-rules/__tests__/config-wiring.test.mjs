// Smoke test: confirms the no-stripe-price-mutations rule is wired into
// the project's eslint.config.js. Spawns a child eslint process pointed
// at a banned-pattern fixture; expects non-zero exit.
//
// The fixture file is normally excluded from `pnpm lint` via the
// ignores block in eslint.config.js, so this child invocation is the
// only thing that ever lints it. We pass --no-ignore here so the
// fixture is actually linted by this child process despite the project
// ignore.
//
// Why not RuleTester: RuleTester exercises the rule logic directly,
// not the project wiring. A flat-config refactor that drops the rule
// registration would silently pass all RuleTester tests.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('eslint config wiring (smoke)', () => {
  it('banned fixture fails project lint', () => {
    const backendRoot = resolve(__dirname, '../..')
    const fixture = resolve(
      backendRoot,
      'eslint-rules/__tests__/fixtures/banned.fixture.mjs',
    )
    // Run from backend/ so pnpm exec finds the workspace package context.
    // The flat-config in eslint.config.js (repo root) is auto-discovered
    // by walking up from `cwd`.
    const result = spawnSync(
      'pnpm',
      ['exec', 'eslint', '--no-ignore', fixture],
      { cwd: backendRoot, encoding: 'utf-8' },
    )
    expect(result.status).not.toBe(0)
    const combined = (result.stdout ?? '') + (result.stderr ?? '')
    expect(combined).toMatch(/no-stripe-price-mutations/)
  }, 30_000)
})
