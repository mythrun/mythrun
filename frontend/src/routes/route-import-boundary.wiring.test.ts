import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, it, expect } from 'vitest'
import tseslint from 'typescript-eslint'

// ----------------------------------------------------------------------------
// R5 / conformance (W3d): `src/routes/**` are the player-facing SCREENS — the
// thin presentational shell. They reach the backend ONLY through
// `@mythrun/client-core` hooks: never `@tanstack/react-query` (no raw `useQuery`
// in a screen), never the network globals (`fetch`/`XMLHttpRequest`/`WebSocket`),
// and never a deep `@mythrun/client-core/src/*` import (force the package barrel).
// This closes the `defineEndpoint` bypass — a screen physically cannot talk to
// the backend except via a client-core hook, so contract conformance is
// STRUCTURAL, not a review convention.
//
// `fetch` is universal (web + React Native) and so is allowed everywhere ELSE in
// the app — the W3b R1 `src/**` block deliberately does NOT ban it. It is banned
// ONLY inside screens. Likewise the 7 R1 web globals (document, window,
// localStorage, sessionStorage, location, navigator, EventSource) are banned
// app-wide by W3b; this routes-scoped block re-lists them because a flat-config
// object OVERRIDES (not merges) a prior object's setting for the same rule — so
// the routes/ `no-restricted-globals` must carry the full 10-global list or the
// 7 would silently stop firing inside screens.
//
// This is an anti-silent-no-op guard (the MYT-79 / MYT-80 lesson): it PROVES the
// react-query ban fires, a client-core hook import passes, `fetch` fires inside a
// screen, `document` STILL fires inside a screen (override didn't drop the 7),
// and `fetch` stays SILENT outside screens. Fixtures are driven through web's
// REAL flat config, so the wiring itself is what's under test.
//
// Fixtures are lint-as-text strings (filePath under `src/`), never written to
// disk; both rules are syntactic, so the type-aware projectService is bypassed
// via `disableTypeChecked` on the runner.
// ----------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')

function packageEslint(): ESLint {
  return new ESLint({
    cwd: packageRoot,
    overrideConfigFile: resolve(packageRoot, 'eslint.config.js'),
    // Fixtures are virtual (lintText): the type-aware projectService can't
    // resolve a path with no real file on disk, and strictTypeChecked rules
    // then error out. The rules under test (`no-restricted-imports`,
    // `no-restricted-globals`) are purely syntactic, so appending
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

describe('routes/ import boundary (R5/conformance) — screens reach the backend only via client-core', () => {
  it('fires `no-restricted-imports` on `@tanstack/react-query` in a src/routes file', async () => {
    const ruleIds = await ids(
      'import { useQuery } from "@tanstack/react-query"\nexport const q = useQuery\n',
      resolve(packageRoot, 'src/routes/x.tsx'),
    )
    expect(ruleIds).toContain('no-restricted-imports')
  })

  it('stays SILENT when a src/routes file imports a hook from @mythrun/client-core', async () => {
    const ruleIds = await ids(
      'import { useMyCampaigns } from "@mythrun/client-core"\nexport const h = useMyCampaigns\n',
      resolve(packageRoot, 'src/routes/x.tsx'),
    )
    expect(ruleIds).not.toContain('no-restricted-imports')
  })

  it('fires `no-restricted-imports` on a deep `@mythrun/client-core/src/*` import in a src/routes file', async () => {
    const ruleIds = await ids(
      'import { useMyCampaigns } from "@mythrun/client-core/src/api/campaigns.ts"\nexport const h = useMyCampaigns\n',
      resolve(packageRoot, 'src/routes/x.tsx'),
    )
    expect(ruleIds).toContain('no-restricted-imports')
  })

  it('fires `no-restricted-globals` on `fetch(...)` in a src/routes file (banned in screens)', async () => {
    const ruleIds = await ids(
      'export const get = (u: string) => fetch(u)\n',
      resolve(packageRoot, 'src/routes/x.tsx'),
    )
    expect(ruleIds).toContain('no-restricted-globals')
  })

  it('STILL fires `no-restricted-globals` on `document` in a src/routes file (the override kept the 7 R1 globals)', async () => {
    const ruleIds = await ids(
      'export const tap = () => document.title\n',
      resolve(packageRoot, 'src/routes/x.tsx'),
    )
    expect(ruleIds).toContain('no-restricted-globals')
  })

  it('stays SILENT on `fetch(...)` outside routes (src/app — fetch is allowed in non-screen code)', async () => {
    const ruleIds = await ids(
      'export const get = (u: string) => fetch(u)\n',
      resolve(packageRoot, 'src/app/x.ts'),
    )
    expect(ruleIds).not.toContain('no-restricted-globals')
  })
})
