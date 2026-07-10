import { useEffect } from 'react'
import { NavigationType, useBlocker } from 'react-router-dom'

// DrawerBackClose (MYT-89 Phase E, E2) — the mobile Back precedence for the reveal's
// wiki drawer, the CLOSE-DRAWER → LEAVE-ROUTE layer. While the drawer is OPEN, a
// browser/hardware Back (a POP navigation) closes the drawer and stays on the reveal
// route; a second Back (drawer now closed) leaves as normal — the expected
// Android/iOS "back dismisses the sheet first" behavior.
//
// It is wired through react-router's OWN history integration (`useBlocker`), not raw
// `window.history` — a manual `pushState` would corrupt the data router's history
// bookkeeping. `useBlocker` intercepts the POP itself: `shouldBlock` returns true
// only for a POP while open, so the router halts that navigation, and the effect
// closes the drawer and cancels the halted nav (`reset`). A PUSH (e.g. Continue →
// the situation route) is never blocked, so it flows through untouched.
//
// PAGE-BACK: the wiki's own in-surface Back button pops the wiki PAGE stack
// (WikiPage → useWikiNavigation.back). Wiring browser Back to also pop that stack
// would mean lifting the wiki's encapsulated navigation out of WorldWiki — beyond
// this route's reach — so page-back stays the wiki's in-surface affordance while
// browser Back manages these drawer→route layers. Requires a DATA router (the app's
// `createBrowserRouter`); rendered only inside the mobile drawer branch.

interface DrawerBackCloseProps {
  /** Whether the drawer is currently open — only then does Back close it. */
  open: boolean
  /** Close the drawer (the reveal's `setDrawerOpen(false)`). */
  onClose: () => void
}

export function DrawerBackClose({ open, onClose }: DrawerBackCloseProps): null {
  const blocker = useBlocker(({ historyAction }) => historyAction === NavigationType.Pop && open)
  useEffect(() => {
    if (blocker.state === 'blocked') {
      onClose()
      blocker.reset()
    }
  }, [blocker, onClose])
  return null
}
