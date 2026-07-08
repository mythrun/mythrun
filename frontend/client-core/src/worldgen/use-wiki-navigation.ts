import { useCallback, useMemo, useState } from 'react'

// useWikiNavigation (MYT-89 Phase D, D3): the wiki's history stack, as a
// platform-neutral React hook. NOT a router and NOT component-owned view state —
// a self-contained `{ current, back }` reducer the D4 wiki drives (push a
// RELATED link, back-button, home) and the D5 reveal composes. DOM-free (the
// client-core R1 lint): no `window`, no `history`, no scroll reads of its own.
//
// WHY THE STACK OWNS SCROLL. The D5 reveal mounts the wiki inside the D1 Drawer,
// whose children stay MOUNTED across open/close — so the browser retains the
// scrollTop of the CURRENT page for free while the drawer is shut. But visited
// pages BELOW the current one share the same scroll container (the wiki renders
// one page at a time); their scrollTop is gone from the DOM the moment you
// navigate away. This stack keeps a `scroll` per entry so D4 can restore it when
// a page becomes current again — the reader lands where they left off.
//
// SCROLL-UPDATE SURFACE (`setScroll`). The consumer records the current page's
// scroll offset via `setScroll(px)` — read the scroll container and call it
// right before navigating away (or throttled on scroll; the hook does not
// re-render on a no-op update). `push`/`back` deliberately DON'T capture scroll
// implicitly: keeping the write explicit means D4 owns exactly when the DOM read
// happens (post-layout, at nav time), and the hook never touches the DOM. On
// `back()` the entry beneath is restored verbatim — including the `scroll` it
// last recorded — so a navigate-away-and-back round-trips the reader's position.

/** Where the wiki reader currently is. `home` is the search/browse landing (no
 *  scroll to retain); an `entity` page carries the browsed entity plus the last
 *  recorded scroll offset (px) so the stack can restore it on return. */
export type WikiLocation =
  | { readonly type: 'home' }
  | { readonly type: 'entity'; readonly entityId: string; readonly scroll: number }

/** The navigation API D4 codes against. Actions are referentially stable
 *  (`useCallback`) so consumer effects that list them as deps don't re-fire per
 *  render; `current`/`canBack` are the render-driving values. */
export interface WikiNavigation {
  /** The page in view — the top of the stack. */
  readonly current: WikiLocation
  /** Navigate to an entity page (fresh entry at scroll 0). A push of the entity
   *  ALREADY in view is a no-op, so a double-tapped link never stacks a page on
   *  itself. */
  readonly push: (entityId: string) => void
  /** Reset to home, clearing all history (`canBack` is false afterwards). */
  readonly home: () => void
  /** Pop to the previous page, restoring its retained scroll. A no-op at home
   *  (nothing below). */
  readonly back: () => void
  /** Record the current page's scroll offset (px) so it survives navigating
   *  away and back. A no-op while on home (home retains no scroll). */
  readonly setScroll: (scroll: number) => void
  /** Whether there is a previous page to return to. */
  readonly canBack: boolean
}

/** `current` is a distinct field (never an array index) so it is provably
 *  defined under `noUncheckedIndexedAccess`; `back` is the history below it,
 *  most-recent FIRST (so `back()` shifts the head). */
interface NavState {
  readonly current: WikiLocation
  readonly back: readonly WikiLocation[]
}

const HOME: WikiLocation = { type: 'home' }

export function useWikiNavigation(): WikiNavigation {
  const [state, setState] = useState<NavState>({ current: HOME, back: [] })

  const push = useCallback((entityId: string): void => {
    setState((s) => {
      if (s.current.type === 'entity' && s.current.entityId === entityId) return s
      return { current: { type: 'entity', entityId, scroll: 0 }, back: [s.current, ...s.back] }
    })
  }, [])

  const home = useCallback((): void => {
    setState({ current: HOME, back: [] })
  }, [])

  const back = useCallback((): void => {
    setState((s) => {
      const [previous, ...rest] = s.back
      if (previous === undefined) return s // at home — nothing below
      return { current: previous, back: rest }
    })
  }, [])

  const setScroll = useCallback((scroll: number): void => {
    setState((s) => {
      if (s.current.type !== 'entity') return s // home carries no scroll
      return { ...s, current: { ...s.current, scroll } }
    })
  }, [])

  const { current, back: history } = state
  const canBack = history.length > 0

  return useMemo(
    () => ({ current, push, home, back, setScroll, canBack }),
    [current, push, home, back, setScroll, canBack],
  )
}
