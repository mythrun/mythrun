// backend/dev-tool/__tests__/verify-registry.test.ts
//
// myth-0smu: build-time invariants for the workflow-page registry
// (rewritten from the panel-keyed registry shipped by myth-e5mn). The
// dev-tool's natural unit is now the workflow page, which composes
// multiple panel mount functions inline.
//
// Invariants enforced:
//   1. Forward coverage — every panel module exporting `mount*` is
//      composed by at least one page (or listed in EXEMPT_PANELS).
//   2. Workflow coverage — PAGE_REGISTRY keys match the WorkflowId
//      union in workflow-registry.ts (no missing pages, no extras).
//   3. Reverse coverage — every page composer file in src/pages/ is
//      imported by main.ts.
//   4. Route exhaustion — union(PANEL_EXERCISES for every panel
//      composed across every page) ∪ EXEMPT_ROUTES ⊇ BACKEND_ROUTES.
//   5. EXEMPT_ROUTES must reference real backend routes.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import {
  EXEMPT_ROUTES,
  EXEMPT_PANELS,
  PAGE_REGISTRY,
  PANEL_EXERCISES,
} from '../verify-registry.js'
import { WORKFLOWS } from '../src/shell/workflow-registry.js'
import { BACKEND_ROUTES, type BackendRoute } from '../../src/contract/backend-routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const COMPONENTS_DIR = resolve(here, '../src/components')
const PAGES_DIR = resolve(here, '../src/pages')
const MAIN_TS = resolve(here, '../src/main.ts')

function panelModulesWithMount(): string[] {
  // Find every .ts file under src/components (excluding __tests__ +
  // _shared) that exports a `mount*` function. We don't parse the
  // AST; we grep for `export function mount` at the start of a line,
  // which matches the established convention. The panel id is the
  // filename minus the -panel.ts / .ts suffix.
  const entries = readdirSync(COMPONENTS_DIR, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    const text = readFileSync(resolve(COMPONENTS_DIR, entry.name), 'utf8')
    if (/^export\s+function\s+mount\w+/m.test(text)) {
      const id = entry.name.replace(/\.ts$/, '').replace(/-panel$/, '')
      out.push(id)
    }
  }
  return out
}

function panelIdsComposedAcrossPages(): Set<string> {
  const composed = new Set<string>()
  for (const reg of Object.values(PAGE_REGISTRY)) {
    for (const id of reg.panels) {
      composed.add(id)
    }
  }
  return composed
}

function pageFilesUnderPagesDir(): string[] {
  // Returns relative filename (without .ts) for every page composer.
  if (!existsSync(PAGES_DIR)) return []
  const entries = readdirSync(PAGES_DIR, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    out.push(entry.name.replace(/\.ts$/, ''))
  }
  return out
}

function pageIdsImportedByMain(): string[] {
  // main.ts imports each page via `import './pages/<id>.js'`.
  const text = readFileSync(MAIN_TS, 'utf8')
  const ids: string[] = []
  const re = /(?:from\s+|import\s+)['"]\.\/pages\/([\w-]+)\.js['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = m[1]
    if (id !== undefined) ids.push(id)
  }
  return ids
}

describe('PAGE_REGISTRY invariants', () => {
  it('forward coverage — every panel module is composed by a page or listed in EXEMPT_PANELS', () => {
    const onDisk = panelModulesWithMount()
    const composed = panelIdsComposedAcrossPages()
    const exempt = new Set(EXEMPT_PANELS)
    const orphans = onDisk.filter((id) => !composed.has(id) && !exempt.has(id))
    expect(orphans, `panels with mount* not composed by any page: ${orphans.join(', ')}`).toEqual([])
  })

  it('workflow coverage — PAGE_REGISTRY keys equal the WorkflowId union', () => {
    const pageKeys = Object.keys(PAGE_REGISTRY).sort()
    const workflowIds = WORKFLOWS.map((w) => w.id).sort()
    expect(pageKeys).toEqual(workflowIds)
  })

  it('reverse coverage — every page composer file is imported by main.ts', () => {
    const onDisk = pageFilesUnderPagesDir().filter((n) => n.endsWith('-page'))
    const imported = pageIdsImportedByMain()
    for (const id of onDisk) {
      expect(imported, `${id} not imported by main.ts`).toContain(id)
    }
  })

  it('every panel referenced in PAGE_REGISTRY.panels has a PANEL_EXERCISES entry', () => {
    const composed = panelIdsComposedAcrossPages()
    const missing: string[] = []
    for (const id of composed) {
      if (!(id in PANEL_EXERCISES)) {
        missing.push(id)
      }
    }
    expect(missing, `panels composed by a page but missing from PANEL_EXERCISES: ${missing.join(', ')}`).toEqual([])
  })

  it('route exhaustion — every BACKEND_ROUTE is covered by a composed panel or EXEMPT_ROUTES', () => {
    const covered = new Set<string>()
    for (const reg of Object.values(PAGE_REGISTRY)) {
      for (const panelId of reg.panels) {
        const exercises = PANEL_EXERCISES[panelId] ?? []
        for (const r of exercises) {
          covered.add(`${r.method} ${r.path}`)
        }
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
      `routes not covered by any panel-via-page or exempt list: ${JSON.stringify(uncovered)}`,
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
