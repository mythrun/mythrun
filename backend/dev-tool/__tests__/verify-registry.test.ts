// backend/dev-tool/__tests__/verify-registry.test.ts
//
// Build-time invariants for the panel registry (myth-e5mn Component 2):
//   1. Forward coverage — every panel module exporting `mount*` is registered.
//   2. Reverse coverage — every registered key is imported by main.ts.
//   3. Route exhaustion — every BackendRoute is exercised by at least one panel.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { EXEMPT_ROUTES, PANEL_REGISTRY } from '../verify-registry.js'
import { BACKEND_ROUTES, type BackendRoute } from '../../src/contract/backend-routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const COMPONENTS_DIR = resolve(here, '../src/components')
const MAIN_TS = resolve(here, '../src/main.ts')

function panelModulesWithMount(): string[] {
  // Find every .ts file under src/components (excluding __tests__) that
  // exports a `mount*` function. We don't actually parse the AST; we
  // grep for `export function mount` at the start of a line, which
  // matches the established convention.
  const entries = readdirSync(COMPONENTS_DIR, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    const text = readFileSync(resolve(COMPONENTS_DIR, entry.name), 'utf8')
    if (/^export\s+function\s+mount\w+/m.test(text)) {
      // panel-id is the filename minus the -panel.ts / .ts suffix
      const id = entry.name.replace(/\.ts$/, '').replace(/-panel$/, '')
      out.push(id)
    }
  }
  return out
}

function panelIdsImportedByMain(): string[] {
  // Read main.ts; find every panel module referenced via either a
  // `from './components/<id>(-panel)?.js'` form OR a side-effect-only
  // `import './components/<id>(-panel)?.js'` form. The myth-mbdc
  // migration uses side-effect imports during Phase 6 as panels
  // self-register via registerPanelMount; both forms keep the panel
  // in the import graph.
  const text = readFileSync(MAIN_TS, 'utf8')
  const ids: string[] = []
  const re = /(?:from\s+|import\s+)['"]\.\/components\/([\w-]+)(?:-panel)?\.js['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = m[1]?.replace(/-panel$/, '')
    if (id) ids.push(id)
  }
  return ids
}

describe('PANEL_REGISTRY invariants', () => {
  it('forward coverage — every panel module with a mount* export is registered', () => {
    const onDisk = panelModulesWithMount().sort()
    const registered = Object.keys(PANEL_REGISTRY).sort()
    expect(registered).toEqual(onDisk)
  })

  it('reverse coverage — every registered panel is imported by main.ts', () => {
    const registered = Object.keys(PANEL_REGISTRY).sort()
    const imported = panelIdsImportedByMain().sort()
    for (const id of registered) {
      expect(imported).toContain(id)
    }
  })

  it('route exhaustion — every BACKEND_ROUTE is covered by a panel or EXEMPT_ROUTES', () => {
    const covered = new Set<string>()
    for (const reg of Object.values(PANEL_REGISTRY)) {
      for (const r of reg.exercises) {
        covered.add(`${r.method} ${r.path}`)
      }
    }
    for (const r of EXEMPT_ROUTES) {
      covered.add(`${r.method} ${r.path}`)
    }
    const uncovered: BackendRoute[] = []
    for (const route of BACKEND_ROUTES) {
      if (!covered.has(`${route.method} ${route.path}`)) {
        uncovered.push(route)
      }
    }
    expect(
      uncovered,
      `routes not covered by any panel or exempt list: ${JSON.stringify(uncovered)}`,
    ).toEqual([])
  })

  it('EXEMPT_ROUTES entries must be in BACKEND_ROUTES', () => {
    const known = new Set(BACKEND_ROUTES.map((r) => `${r.method} ${r.path}`))
    for (const r of EXEMPT_ROUTES) {
      expect(known.has(`${r.method} ${r.path}`), `${r.method} ${r.path} not in BACKEND_ROUTES`)
        .toBe(true)
    }
  })
})
