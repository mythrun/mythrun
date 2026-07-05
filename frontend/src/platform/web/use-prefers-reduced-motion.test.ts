import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { reducedMotionQuery, usePrefersReducedMotion } from './use-prefers-reduced-motion.ts'

// usePrefersReducedMotion (MYT-89 Phase C wrap-up): the web read of
// `prefers-reduced-motion: reduce` that GeneratingView hands WorldGenGraph so its
// Canvas rAF loop is suppressed for reduced-motion users. jsdom has no matchMedia,
// so each test installs a controllable one; the SSR branch is exercised by a
// direct call with `window` stubbed away (renderHook needs a DOM).

// One shared listener set + one shared `matches` cell across every mql the code
// requests, so flipping the preference and firing `change` reaches the listener
// the effect actually registered (each matchMedia() call returns a fresh object).
function installMatchMedia(initial: boolean): { setReduced: (v: boolean) => void; listenerCount: () => number } {
  const listeners = new Set<() => void>()
  const state = { matches: initial }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const isReducedMotion = query.includes('reduced-motion')
      return {
        get matches() {
          return isReducedMotion ? state.matches : false
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }
    },
  })
  return {
    setReduced: (v: boolean) => {
      state.matches = v
      listeners.forEach((cb) => {
        cb()
      })
    },
    listenerCount: () => listeners.size,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('usePrefersReducedMotion', () => {
  it('reports false when the preference is not set (motion allowed)', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
  })

  it('reports true when the OS/browser prefers reduced motion', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(true)
  })

  it('reacts to a runtime toggle of the preference (subscribes to change)', () => {
    const mm = installMatchMedia(false)
    const { result } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
    act(() => {
      mm.setReduced(true)
    })
    expect(result.current).toBe(true)
    act(() => {
      mm.setReduced(false)
    })
    expect(result.current).toBe(false)
  })

  it('unsubscribes on unmount (no leaked listener)', () => {
    const mm = installMatchMedia(true)
    const { unmount } = renderHook(() => usePrefersReducedMotion())
    expect(mm.listenerCount()).toBe(1)
    unmount()
    expect(mm.listenerCount()).toBe(0)
  })

  it('is a no-op false when matchMedia is unavailable (never throws)', () => {
    // window exists but matchMedia does not — the effect's null guard returns.
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    const { result } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
  })
})

describe('reducedMotionQuery (SSR-safe read)', () => {
  it('returns null when there is no window (server render)', () => {
    vi.stubGlobal('window', undefined)
    expect(reducedMotionQuery()).toBeNull()
  })

  it('returns null when matchMedia is not a function', () => {
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    expect(reducedMotionQuery()).toBeNull()
  })

  it('returns the live MediaQueryList when matchMedia exists', () => {
    installMatchMedia(true)
    expect(reducedMotionQuery()?.matches).toBe(true)
  })
})
