import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewportNarrow } from './use-viewport-narrow.ts'

// useViewportNarrow — the DS's one narrow-viewport regime as a JS boolean, for
// STRUCTURAL responsive decisions (a different DOM, not a different class). The
// boundary is the same 640px step as Tailwind's `sm:` (the query is
// `(min-width: 640px)` negated, so JS and CSS can never disagree). These tests
// pin the initial read, the no-matchMedia default (wide — the shipped desktop
// layout), the RUNTIME flip (rotating a phone / dragging a window across the
// step), and the unmount unsubscribe.

interface FakeMql {
  matches: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  fire: () => void
}

/** Stub `matchMedia` with a controllable wide-query MQL: `fire()` invokes the
 *  hook's change listener (the browser's mid-session resize signal). */
function stubMql(wideMatches: boolean): FakeMql {
  let listener: (() => void) | undefined
  const mql: FakeMql = {
    matches: wideMatches,
    addEventListener: vi.fn((_type: string, cb: () => void) => {
      listener = cb
    }),
    removeEventListener: vi.fn(),
    fire: () => listener?.(),
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql))
  return mql
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useViewportNarrow', () => {
  it('reads the initial regime from the wide query (narrow = NOT matches)', () => {
    stubMql(false)
    const { result } = renderHook(() => useViewportNarrow())
    expect(result.current).toBe(true)
  })

  it('defaults to wide (false) when there is no matchMedia (jsdom / SSR)', () => {
    const { result } = renderHook(() => useViewportNarrow())
    expect(result.current).toBe(false)
  })

  it('flips at runtime when the media query changes (crossing 640px)', () => {
    const mql = stubMql(true) // wide
    const { result } = renderHook(() => useViewportNarrow())
    expect(result.current).toBe(false)
    mql.matches = false // the viewport crossed below 640px
    act(() => {
      mql.fire()
    })
    expect(result.current).toBe(true)
  })

  it('unsubscribes from the query on unmount', () => {
    const mql = stubMql(true)
    const { unmount } = renderHook(() => useViewportNarrow())
    unmount()
    expect(mql.removeEventListener).toHaveBeenCalledWith(
      'change',
      mql.addEventListener.mock.calls[0]?.[1],
    )
  })
})
