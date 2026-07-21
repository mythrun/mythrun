// Theme + motion plumbing for the gallery. Two concerns:
//
// 1. MOTION. The real components read reduced-motion two ways: a `reducedMotion`
//    prop (WorldGenGraph / fog), and an INTERNAL `matchMedia('(prefers-reduced-
//    motion: reduce)')` read (Spinner, and the app's usePrefersReducedMotion).
//    The audit must force full OR reduced regardless of the viewer's OS, so we
//    install a controllable matchMedia shim: the reduced-motion query resolves to
//    a value WE own and can toggle live (firing `change` so subscribed components
//    re-read); every other query delegates to the native implementation. The prop
//    channel is driven separately by reading `getForcedReducedMotion()`.
//
// 2. THEME. The artifact host stamps `data-theme` on <html> when the viewer flips
//    theme, and `prefers-color-scheme` carries the OS default. We observe both and
//    mirror the resolved theme onto the gallery root as `data-audit-theme`, which
//    the neutral chrome CSS keys off. Exhibits render both themes side-by-side, so
//    this only tints the chrome — never the DS token surfaces.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let forcedReduced = false
const reducedListeners = new Set<() => void>()
let nativeMatchMedia: ((q: string) => MediaQueryList) | null = null

/** Whether the audit is currently forcing reduced motion (the prop channel reads this). */
export function getForcedReducedMotion(): boolean {
  return forcedReduced
}

/** Toggle forced reduced motion. Updates the shim's `.matches` and fires `change`
 *  on every live reduced-motion query so internal-reading components (Spinner,
 *  usePrefersReducedMotion) re-read. The prop channel is handled by the caller
 *  re-rendering with `getForcedReducedMotion()`. */
export function setForcedReducedMotion(next: boolean): void {
  if (next === forcedReduced) return
  forcedReduced = next
  for (const fn of reducedListeners) fn()
}

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

function makeReducedMql(): MediaQueryList {
  const subscribers = new Set<(ev: MediaQueryListEvent) => void>()
  const notify = (): void => {
    const ev = {
      matches: forcedReduced,
      media: REDUCED_MOTION_QUERY,
    } as MediaQueryListEvent
    if (typeof mql.onchange === 'function') mql.onchange.call(mql as unknown as MediaQueryList, ev)
    for (const cb of subscribers) cb(ev)
  }
  reducedListeners.add(notify)
  const mql: ShimMql = {
    get matches() {
      return forcedReduced
    },
    media: REDUCED_MOTION_QUERY,
    onchange: null,
    addEventListener: (type, cb) => {
      if (type === 'change') subscribers.add(cb as (ev: MediaQueryListEvent) => void)
    },
    removeEventListener: (type, cb) => {
      if (type === 'change') subscribers.delete(cb as (ev: MediaQueryListEvent) => void)
    },
    addListener: (cb) => subscribers.add(cb),
    removeListener: (cb) => subscribers.delete(cb),
    dispatchEvent: () => true,
  }
  return mql as unknown as MediaQueryList
}

/** Replace `window.matchMedia` with one that owns the reduced-motion query and
 *  delegates everything else (pointer, width, color-scheme, …) to the native impl.
 *  Idempotent; call once before React mounts. */
export function installMatchMediaShim(): void {
  if (nativeMatchMedia !== null) return
  nativeMatchMedia = window.matchMedia.bind(window)
  const shim = (query: string): MediaQueryList => {
    if (query.replace(/\s+/g, '') === REDUCED_MOTION_QUERY.replace(/\s+/g, '')) {
      return makeReducedMql()
    }
    return nativeMatchMedia!(query)
  }
  window.matchMedia = shim as typeof window.matchMedia
}

export type AuditTheme = 'light' | 'dark'

/** Resolve the viewer's current theme from the host: an explicit
 *  `:root[data-theme]` wins; otherwise the OS `prefers-color-scheme`. */
export function resolveHostTheme(): AuditTheme {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  const mql = (nativeMatchMedia ?? window.matchMedia.bind(window))('(prefers-color-scheme: dark)')
  return mql.matches ? 'dark' : 'light'
}

/** Subscribe to host theme changes (data-theme attribute + OS preference). Calls
 *  `onChange` with the resolved theme immediately and on every change. Returns an
 *  unsubscribe. */
export function observeHostTheme(onChange: (theme: AuditTheme) => void): () => void {
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
