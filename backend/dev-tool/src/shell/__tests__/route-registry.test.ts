import { describe, it, expect } from 'vitest'
import { BACKEND_ROUTES } from '../../../../src/contract/backend-routes.js'
import { ROUTE_PANELS, EXEMPT_ROUTES } from '../route-registry.js'

describe('route-registry', () => {
  it('every BACKEND_ROUTES entry is either in ROUTE_PANELS or EXEMPT_ROUTES', () => {
    const covered = new Set<string>()
    for (const p of ROUTE_PANELS) {
      covered.add(`${p.method} ${p.path}`)
    }
    for (const r of EXEMPT_ROUTES) {
      covered.add(`${r.method} ${r.path}`)
    }
    const missing = BACKEND_ROUTES.filter((r) => !covered.has(`${r.method} ${r.path}`))
    expect(missing).toEqual([])
  })

  it('every ROUTE_PANELS entry references a real BACKEND_ROUTES route', () => {
    const real = new Set<string>(
      BACKEND_ROUTES.map((r) => `${r.method} ${r.path}`),
    )
    const stale = ROUTE_PANELS.filter((p) => !real.has(`${p.method} ${p.path}`))
    expect(stale).toEqual([])
  })
})
