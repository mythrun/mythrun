import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, it, expect } from 'vitest'
import tseslint from 'typescript-eslint'

// ----------------------------------------------------------------------------
// R1 (DOM-free client brain): client-core is the platform-agnostic client
// brain — it must reach every platform capability through a `platform/`
// interface, never a web global. The enforcement is the core ESLint rule
// `no-restricted-globals` (NOT a custom plugin rule), wired into this
// package's `eslint.config.js` on `src/**/*.{ts,tsx}` (test files exempt).
//
// This is an anti-silent-no-op guard (the MYT-79 / MYT-80 lesson): a test that
// PROVES the ban fires on a real `document`/`localStorage`/`EventSource`
// reference and stays SILENT on the deliberately-allowed `fetch` global —
// driving fixtures through the package's REAL flat config (not an isolated
// overrideConfig), so the wiring itself is what's under test.
//
// The fixtures are lint-as-text strings (filePath under `src/`), never written
// to disk; `no-restricted-globals` is a syntactic rule, so the type-aware
// projectService is bypassed via `disableTypeChecked` on the runner.
// ----------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

function packageEslint(): ESLint {
  return new ESLint({
    cwd: packageRoot,
    overrideConfigFile: resolve(packageRoot, 'eslint.config.js'),
    // The fixtures are virtual (lintText): the type-aware projectService can't
    // resolve a path with no real file on disk, and the strictTypeChecked
    // rules then error out. `no-restricted-globals` is purely syntactic, so
    // appending `disableTypeChecked` (turns off type-aware rules + nulls
    // projectService) loses nothing relevant to what's under test.
    overrideConfig: [tseslint.configs.disableTypeChecked],
  })
}

async function ids(code: string, filePath: string): Promise<(string | null)[]> {
  const [res] = await packageEslint().lintText(code, { filePath })
  if (!res) throw new Error('no lint result')
  return res.messages.map((m) => m.ruleId)
}

describe('no-restricted-globals (R1) — fires on web globals, silent on universal ones', () => {
  it('fires on `document` in a src/**/*.ts file', async () => {
    const ruleIds = await ids(
      'export const tap = () => document.title\n',
      resolve(packageRoot, 'src/api/fixture.ts'),
    )
    expect(ruleIds).toContain('no-restricted-globals')
  })

  it('fires on `localStorage` (a second banned global) in a src file', async () => {
    const ruleIds = await ids(
      'export const read = () => localStorage.getItem("x")\n',
      resolve(packageRoot, 'src/stores/fixture.ts'),
    )
    expect(ruleIds).toContain('no-restricted-globals')
  })

  it('fires on `EventSource` (the SSE web global) in a src file', async () => {
    const ruleIds = await ids(
      'export const open = (u: string) => new EventSource(u)\n',
      resolve(packageRoot, 'src/api/sse-fixture.ts'),
    )
    expect(ruleIds).toContain('no-restricted-globals')
  })

  it('stays SILENT on `fetch` (deliberately universal) in a src file', async () => {
    const ruleIds = await ids(
      'export const get = (u: string) => fetch(u)\n',
      resolve(packageRoot, 'src/api/fetch-fixture.ts'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })

  it('stays SILENT on `document` inside a test file (src/**/*.test.ts is exempt)', async () => {
    const ruleIds = await ids(
      'export const tap = () => document.title\n',
      resolve(packageRoot, 'src/api/fixture.test.ts'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })
})
