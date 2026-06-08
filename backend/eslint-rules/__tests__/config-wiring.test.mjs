// Smoke test: confirms the `mythrun/no-stripe-price-mutations` rule is WIRED
// into the project's eslint.config.js (registered + active) for a real source
// path — the regression guard against a flat-config refactor silently dropping
// the rule registration.
//
// We resolve the project flat-config via the ESLint API's
// `calculateConfigForFile`, which computes the merged config (rules,
// languageOptions, …) ESLint WOULD apply to the file — WITHOUT linting it. That
// makes this a true project-wiring check (a dropped registration → the rule is
// absent from the resolved config here) while avoiding the type-aware
// `projectService` TS-program build that linting triggers. The previous version
// spawned `pnpm exec eslint` on a fixture, which paid that build (~30-60s and
// growing with the source tree, flaky against its timeout).
//
// Why not RuleTester for THIS test: RuleTester exercises the rule logic directly
// (covered by no-stripe-price-mutations.test.cjs), not the project wiring — a
// refactor that drops the registration would pass all RuleTester tests.

import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RULE = 'mythrun/no-stripe-price-mutations'

describe('eslint config wiring (smoke)', () => {
  it('registers + activates mythrun/no-stripe-price-mutations in the project config', async () => {
    const backendRoot = resolve(__dirname, '../..')
    // A real backend source path (not the ignored fixture): the rule's block
    // targets the source tree, so the resolved config for a src file carries it.
    const probed = resolve(backendRoot, 'src/billing/webhook.ts')
    // ESLint flat-config is auto-discovered by walking up from cwd to the repo
    // root (where eslint.config.js lives). No linting happens — config only.
    const eslint = new ESLint({ cwd: backendRoot })
    const config = await eslint.calculateConfigForFile(probed)

    const severity = config.rules?.[RULE]
    // A dropped registration → undefined. Flat config normalizes a configured
    // rule to an array (e.g. ['error'] / [2]); assert present AND active.
    expect(severity).toBeDefined()
    const level = Array.isArray(severity) ? severity[0] : severity
    expect(level).not.toBe('off')
    expect(level).not.toBe(0)
    // 30s ceiling: loading eslint.config.js + the typescript-eslint plugin is a
    // bounded ~4-10s (config resolution only, NOT the unbounded type-aware lint
    // of the prior version) — comfortably above the default 5s test timeout for
    // CI, with no project-size-dependent creep.
  }, 30_000)
})
