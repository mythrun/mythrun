import { useEffect, useState } from 'react'

// The DS's ONE narrow-viewport regime, as a JS boolean (MYT-89 audit v2 — the
// mobile full-bleed fix). Some responsive decisions are STRUCTURAL — a different
// DOM, not a different class (WorldGenGraph moves its status card from an
// in-canvas overlay to a page footer; FullBleedStage swaps a plain block for a
// measured full-screen stage) — so CSS variants (`sm:`, or the Show switch)
// can't express them: rendering both branches would double-run canvas sims.
//
// The boundary is the SAME 640px step the CSS side uses (`--breakpoint-sm`; the
// reveal's entity list stacks below it): the query is `(min-width: 640px)` — the
// exact complement of Tailwind's `sm:` variant — and NARROW is its negation, so
// the JS flip and any `sm:`-variant styling can never disagree. Form-factor-
// driven only: layout must never flip on runtime state like the world-gen
// camera engaging (a geometric, mid-generation event).

const WIDE_VIEWPORT_QUERY = '(min-width: 640px)'

/** The wide-viewport `MediaQueryList`, or `null` in any non-DOM environment
 *  (server render / a runtime with no `window.matchMedia`). The SINGLE guard —
 *  both the initial read and the change subscription route through here
 *  (mirrors the app's `reducedMotionQuery`). */
function wideViewportQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(WIDE_VIEWPORT_QUERY)
}

/** Whether the viewport is in the narrow (phone-class, < 640px) regime,
 *  initialized from the media query and kept in sync with runtime resizes
 *  (rotating a phone, dragging a window across the step). No-`matchMedia`
 *  environments report `false` (the wide/desktop layout — the shipped
 *  default). */
export function useViewportNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    const mql = wideViewportQuery()
    return mql === null ? false : !mql.matches
  })

  useEffect(() => {
    const mql = wideViewportQuery()
    if (mql === null) return
    const onChange = (): void => {
      setNarrow(!mql.matches)
    }
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }, [])

  return narrow
}
