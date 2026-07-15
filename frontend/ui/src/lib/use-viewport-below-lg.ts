import { useEffect, useState } from 'react'

// The `lg`-step narrow regime as a JS boolean (MYT-94). A sibling of
// `useViewportNarrow` (the 640px `sm` regime): some structural responsive
// decisions flip at a DIFFERENT boundary than the `sm` entity-list stack. The
// MYT-94 play sidebar is one — a ~30% desktop RAIL beside the transcript
// collapses into the edge-handle Drawer below the `lg` step, so tablets get the
// full-bleed chat + a summonable sheet instead of a cramped rail.
//
// This MUST be a JS flip (not a CSS `Show`): the mobile branch is the shipped
// `Drawer`, whose content is PORTALED to <body> — a `Show`'s `display:none`
// wrapper can't hide portaled content, and rendering both branches would mount
// two `WorldGenGraph` canvases. One structural mount, chosen here.
//
// The boundary is the same `lg` step the CSS side uses (`--breakpoint-lg`,
// 1024px): the query is `(min-width: 1024px)` and BELOW is its negation, so the
// JS flip and any `lg:`-variant styling can never disagree. Form-factor-driven
// only (never a runtime-state flip).

const WIDE_VIEWPORT_QUERY = '(min-width: 1024px)'

/** The wide-viewport `MediaQueryList`, or `null` in any non-DOM environment
 *  (server render / a runtime with no `window.matchMedia`). The SINGLE guard —
 *  both the initial read and the change subscription route through here
 *  (mirrors `useViewportNarrow`). */
function wideViewportQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(WIDE_VIEWPORT_QUERY)
}

/** Whether the viewport is below the `lg` step (< 1024px — the drawer regime),
 *  initialized from the media query and kept in sync with runtime resizes.
 *  No-`matchMedia` environments report `false` (the wide/desktop layout — the
 *  shipped default). */
export function useViewportBelowLg(): boolean {
  const [below, setBelow] = useState(() => {
    const mql = wideViewportQuery()
    return mql === null ? false : !mql.matches
  })

  useEffect(() => {
    const mql = wideViewportQuery()
    if (mql === null) return
    const onChange = (): void => {
      setBelow(!mql.matches)
    }
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }, [])

  return below
}
