import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, it, expect } from 'vitest'
import tseslint from 'typescript-eslint'

// ----------------------------------------------------------------------------
// R1 (web side): `@mythrun/web` is the platform-agnostic app shell EXCEPT for
// `src/platform/web/**` — the one place web globals (localStorage, document,
// EventSource, …) may be touched, because that is where the platform-capability
// impls live. The ban is the core `no-restricted-globals` rule wired into web's
// `eslint.config.js` on `src/**/*.{ts,tsx}`, carving out `src/platform/web/**`
// (impls), `src/main.tsx` (the unavoidable `document.getElementById` mount), and
// test files.
//
// This is an anti-silent-no-op guard (the MYT-79 / MYT-80 lesson): it PROVES the
// ban fires on a real `localStorage` reference under a non-carve-out path, stays
// SILENT on that same reference inside `src/platform/web/**`, stays SILENT on the
// `document` mount in `src/main.tsx`, and never touches `fetch` (deliberately
// universal). Fixtures are driven through web's REAL flat config (not an isolated
// overrideConfig), so the wiring itself is what's under test.
//
// Fixtures are lint-as-text strings (filePath under `src/`), never written to
// disk; `no-restricted-globals` is syntactic, so the type-aware projectService
// is bypassed via `disableTypeChecked` on the runner.
// ----------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..', '..')

function packageEslint(): ESLint {
  return new ESLint({
    cwd: packageRoot,
    overrideConfigFile: resolve(packageRoot, 'eslint.config.js'),
    // Fixtures are virtual (lintText): the type-aware projectService can't
    // resolve a path with no real file on disk, and strictTypeChecked rules
    // then error out. `no-restricted-globals` is purely syntactic, so appending
    // `disableTypeChecked` (turns off type-aware rules + nulls projectService)
    // loses nothing relevant to what's under test.
    overrideConfig: [tseslint.configs.disableTypeChecked],
  })
}

async function ids(code: string, filePath: string): Promise<(string | null)[]> {
  const [res] = await packageEslint().lintText(code, { filePath })
  if (!res) throw new Error('no lint result')
  return res.messages.map((m) => m.ruleId)
}

describe('no-restricted-globals (R1, web) — fires outside platform/web, silent inside', () => {
  it('fires on `localStorage` in a src/routes file (non-carve-out path)', async () => {
    const ruleIds = await ids(
      'export const read = () => localStorage.getItem("x")\n',
      resolve(packageRoot, 'src/routes/x.ts'),
    )
    expect(ruleIds).toContain('no-restricted-globals')
  })

  it('stays SILENT on `localStorage` inside src/platform/web/** (impls live here)', async () => {
    const ruleIds = await ids(
      'export const read = () => localStorage.getItem("x")\n',
      resolve(packageRoot, 'src/platform/web/secure-storage.ts'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })

  it('stays SILENT on `document.getElementById` in src/main.tsx (the mount carve-out)', async () => {
    const ruleIds = await ids(
      'export const el = document.getElementById("root")\n',
      resolve(packageRoot, 'src/main.tsx'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })

  it('stays SILENT on `fetch` in a non-carve-out src file (deliberately universal)', async () => {
    const ruleIds = await ids(
      'export const get = (u: string) => fetch(u)\n',
      resolve(packageRoot, 'src/routes/fetch-fixture.ts'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })

  it('stays SILENT on `document` inside a test file (src/**/*.test.ts is exempt)', async () => {
    const ruleIds = await ids(
      'export const tap = () => document.title\n',
      resolve(packageRoot, 'src/routes/fixture.test.ts'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })
})
