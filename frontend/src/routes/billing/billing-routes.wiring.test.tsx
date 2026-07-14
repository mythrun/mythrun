import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { RouteObject } from 'react-router-dom'
import { buildRoutes } from '../../app/router.tsx'
import { AppFrame } from '../../app/app-frame.tsx'

// The two Stripe checkout-return routes ship in the AUTHED, framed branch (under
// <AppFrame>, behind <RequireAuth>) — they are NOT dev-gated. `buildRoutes(false)`
// is a prod-config route tree; walking it to the <AppFrame> layout node and
// reading its children proves the routes are registered exactly where a signed-in
// player is redirected back to after Checkout (spec §4 / Task 12). Mirrors the
// dev-transport registration test's tree-walk precedent.

/** The children of the <AppFrame> layout node, wherever it sits in the tree. */
function appFrameChildren(tree: readonly RouteObject[]): readonly RouteObject[] {
  for (const route of tree) {
    if (isValidElement(route.element) && route.element.type === AppFrame) {
      return route.children ?? []
    }
    if (route.children) {
      const found = appFrameChildren(route.children)
      if (found.length > 0) return found
    }
  }
  return []
}

describe('billing checkout-return route registration', () => {
  it('registers billing/return + billing/cancelled under the AppFrame child in a PROD tree', () => {
    const paths = appFrameChildren(buildRoutes(false)).map((r) => r.path)
    expect(paths).toContain('billing/return')
    expect(paths).toContain('billing/cancelled')
  })
})
