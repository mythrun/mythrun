import { useEffect, useState } from 'react'

// The web realization of the "does the user want reduced motion?" capability
// (`prefers-reduced-motion: reduce`). It lives under `src/platform/web/**` — the
// ONE place the web app may touch a browser global (R1) — so screens consume it
// as a plain boolean and `reducedMotion` stays a platform-neutral prop (a native
// impl slots in later, same signature).
//
// WHY a JS read and not the base.css reduced-motion reset: the CSS reset only
// neutralizes CSS animations. It CANNOT stop a JS `requestAnimationFrame` loop —
// WorldGenGraph paints its force-directed Canvas + ambient "ghost bloom" churn on
// a rAF loop that runs for the whole ~10-minute world generation. So the Canvas
// needs the boolean to skip the loop entirely (a bounded settle + static redraw).
// Mirrors @mythrun/ui's Spinner, which reads the same query for the same reason.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The reduced-motion `MediaQueryList`, or `null` in any non-DOM environment
 *  (server render / a runtime with no `window.matchMedia`). The SINGLE SSR guard:
 *  both the initial read and the change subscription route through here, so
 *  there's one place to keep SSR-safe. Exported so the SSR path is directly
 *  unit-testable without a React render. */
export function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(REDUCED_MOTION_QUERY)
}

/** Whether the user prefers reduced motion, initialized from the media query and
 *  kept in sync with runtime toggles (a mid-session preference change updates it).
 *  SSR-safe: returns `false` (motion allowed — the sane default) when there is no
 *  `window` / `matchMedia`. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false)

  useEffect(() => {
    const mql = reducedMotionQuery()
    if (mql === null) return
    const onChange = (): void => {
      setReduced(mql.matches)
    }
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }, [])

  return reduced
}
