import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'

// A resilient header chrome slot (MYT-99). The persistent app frame reads two
// suspense queries in its ALWAYS-present header — the live credit balance
// (`useBalance`) and the signed-in display name (`useMe`). Each is wrapped here so
// a slow or failed fetch degrades ONLY its own slot, never the whole authed shell:
//
//   • Suspense — owns the loading state. `pending` paints while the query first
//     loads (a small spinner for credits; nothing for the name, which just appears
//     when ready). The frame itself never suspends — only the slot waits.
//   • a LOCAL error boundary — owns the failure. On a fetch error (a 5xx / network
//     blip) the slot renders `errorFallback` (nothing by default) instead of
//     throwing up to the router error boundary and tearing down the route. In
//     production the QueryClient + ApiContext are always supplied by AppProviders,
//     so this only ever catches a genuine fetch failure — but it ALSO keeps the
//     frame renderable in tests/harnesses that omit the ApiClientProvider (the
//     `useApiContext` throw is caught here, same as the shipped credits slot).
//
// Extracted from the original HeaderCredits boundary so identity + credits share
// one implementation rather than duplicating the class.

interface SlotState {
  readonly failed: boolean
}

// React error boundaries have no hook form — a class is the only way to catch a
// child render/query error. Module-private; renders `fallback` on failure.
class SlotErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, SlotState> {
  override state: SlotState = { failed: false }

  static getDerivedStateFromError(): SlotState {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * Wrap a header slot's suspense-query content so it loads + fails in isolation.
 * `pending` is the Suspense fallback (default: nothing); `errorFallback` is what
 * renders on a fetch failure (default: nothing). The boundary + Suspense add no
 * DOM wrapper, so the slot's own element stays a direct flex child of the header
 * row (its truncation / shrink behaviour is unaffected).
 */
export function HeaderSlot({
  children,
  pending = null,
  errorFallback = null,
}: {
  readonly children: ReactNode
  readonly pending?: ReactNode
  readonly errorFallback?: ReactNode
}): React.JSX.Element {
  return (
    <SlotErrorBoundary fallback={errorFallback}>
      <Suspense fallback={pending}>{children}</Suspense>
    </SlotErrorBoundary>
  )
}
