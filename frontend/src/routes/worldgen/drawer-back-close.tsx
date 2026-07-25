import { useEffect, useRef } from 'react'
import { NavigationType, useBlocker } from 'react-router-dom'

// DrawerBackClose (MYT-89 Phase E, E2; page-back layer myth-g7kg6) — the mobile Back
// precedence for the reveal's wiki drawer, in full: PAGE-BACK → CLOSE-DRAWER →
// LEAVE-ROUTE. A browser/hardware Back (a POP navigation) unwinds the reader's
// position one layer at a time — first back out of the wiki page they are on, then
// (at wiki home) shut the sheet, then leave the route. Nothing ever disappears out
// from under a reader who is three pages deep.
//
// It is wired through react-router's OWN history integration (`useBlocker`), not raw
// `window.history` — a manual `pushState` would corrupt the data router's history
// bookkeeping. `useBlocker` intercepts the POP itself: `shouldBlock` returns true
// only for a POP while there is still a layer to unwind, so the router halts that
// navigation and the effect unwinds one layer and cancels the halted nav (`reset`).
// A PUSH (e.g. Continue → the situation route) is never blocked, so it flows
// through untouched.
//
// The page stack reaches here because the reveal LIFTS it out of WorldWiki
// (`WorldWikiProps.navigation`) — E2 shipped without that seam, so `back()` reported
// nothing outward and browser Back could only manage the drawer→route layers. The
// wiki's own in-surface Back button pops the very same stack, so the two
// affordances stay in step by construction. Requires a DATA router (the app's
// `createBrowserRouter`); rendered only inside the mobile drawer branch.

interface DrawerBackCloseProps {
  /** Whether the drawer is currently open — only then is there anything to unwind. */
  open: boolean
  /** Whether the wiki has a page to pop — the layer ABOVE the drawer. */
  canPageBack: boolean
  /** Pop one wiki page (the lifted `useWikiNavigation.back`). */
  onPageBack: () => void
  /** Close the drawer (the reveal's `setDrawerOpen(false)`). */
  onClose: () => void
}

export function DrawerBackClose({ open, canPageBack, onPageBack, onClose }: DrawerBackCloseProps): null {
  const blocker = useBlocker(({ historyAction }) => historyAction === NavigationType.Pop && open)
  // Which layer the next Back unwinds — innermost first. Held in a REF rather
  // than read from the effect's deps: popping a page flips `canPageBack` in the
  // same commit, so a deps-driven re-run would meet the SAME blocked navigation
  // still un-reset and unwind a second layer — one Back taking the page AND the
  // drawer. The effect keys on the blocked navigation alone, so it fires once
  // per Back, and this line keeps the action it fires current.
  const unwind = useRef<() => void>(onClose)
  unwind.current = canPageBack ? onPageBack : onClose
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    unwind.current()
    blocker.reset()
  }, [blocker])
  return null
}
