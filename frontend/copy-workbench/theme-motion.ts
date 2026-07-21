// Theme + motion plumbing for the workbench, distilled from
// animation-audit/theme-motion.ts. Two concerns:
//
// 1. MOTION. Exhibits should show the REAL, moving UI regardless of the viewer's
//    OS reduced-motion setting, so we install a matchMedia shim that resolves the
//    reduced-motion query to a fixed `false` (full motion) and delegates every
//    other query to the native impl. (No live toggle — copy work wants the real
//    thing, always in motion.) fold.mjs additionally neutralizes the DS's CSS
//    reduced-motion reset so the CSS channel matches.
//
// 2. THEME. The artifact host stamps `data-theme` on <html> when the viewer flips
//    theme; `prefers-color-scheme` carries the OS default. We resolve + observe
//    both so the workbench chrome follows the viewer's theme.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let nativeMatchMedia: ((q: string) => MediaQueryList) | null = null

interface ShimMql {
  matches: boolean
  media: string
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null
  addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => void
  addListener: (cb: (ev: MediaQueryListEvent) => void) => void
  removeListener: (cb: (ev: MediaQueryListEvent) => void) => void
  dispatchEvent: (ev: Event) => boolean
}

/** A stable reduced-motion MQL that always reports `matches: false` (full motion). */
function makeFullMotionMql(): MediaQueryList {
  const mql: ShimMql = {
    matches: false,
    media: REDUCED_MOTION_QUERY,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }
  return mql as unknown as MediaQueryList
}

/** Replace `window.matchMedia` with one that forces full motion for the
 *  reduced-motion query and delegates everything else to native. Idempotent. */
export function installMatchMediaShim(): void {
  if (nativeMatchMedia !== null) return
  nativeMatchMedia = window.matchMedia.bind(window)
  const shim = (query: string): MediaQueryList => {
    if (query.replace(/\s+/g, '') === REDUCED_MOTION_QUERY.replace(/\s+/g, '')) {
      return makeFullMotionMql()
    }
    return nativeMatchMedia!(query)
  }
  window.matchMedia = shim as typeof window.matchMedia
}

export type ChromeTheme = 'light' | 'dark'

/** Resolve the viewer's current theme: an explicit `:root[data-theme]` wins;
 *  otherwise the OS `prefers-color-scheme`. */
export function resolveHostTheme(): ChromeTheme {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  const mql = (nativeMatchMedia ?? window.matchMedia.bind(window))('(prefers-color-scheme: dark)')
  return mql.matches ? 'dark' : 'light'
}

/** Subscribe to host theme changes (data-theme attribute + OS preference). Calls
 *  `onChange` immediately and on every change. Returns an unsubscribe. */
export function observeHostTheme(onChange: (theme: ChromeTheme) => void): () => void {
  const emit = (): void => onChange(resolveHostTheme())
  const mo = new MutationObserver(emit)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  const colorMql = (nativeMatchMedia ?? window.matchMedia.bind(window))('(prefers-color-scheme: dark)')
  colorMql.addEventListener('change', emit)
  emit()
  return () => {
    mo.disconnect()
    colorMql.removeEventListener('change', emit)
  }
}
