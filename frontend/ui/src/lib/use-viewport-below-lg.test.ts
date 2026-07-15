import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewportBelowLg } from './use-viewport-below-lg.ts'

// useViewportBelowLg — the DS's `lg`-step structural regime (a JS boolean), sibling
// of useViewportNarrow (the 640px sm regime). The boundary is the same lg step the
// CSS side uses (the query is `(min-width: 1024px)` negated). These tests pin the
// initial read, the no-matchMedia default (wide — the shipped desktop layout), the
// runtime flip (dragging a window across the step), and the unmount unsubscribe.

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

describe('useViewportBelowLg', () => {
  it('reads the initial regime from the wide query (below = NOT matches)', () => {
    stubMql(false)
    const { result } = renderHook(() => useViewportBelowLg())
    expect(result.current).toBe(true)
  })

  it('defaults to wide (false) when there is no matchMedia (jsdom / SSR)', () => {
    const { result } = renderHook(() => useViewportBelowLg())
    expect(result.current).toBe(false)
  })

  it('flips at runtime when the media query changes (crossing 1024px)', () => {
    const mql = stubMql(true) // wide
    const { result } = renderHook(() => useViewportBelowLg())
    expect(result.current).toBe(false)
    mql.matches = false // the viewport crossed below 1024px
    act(() => {
      mql.fire()
    })
    expect(result.current).toBe(true)
  })

  it('unsubscribes from the query on unmount', () => {
    const mql = stubMql(true)
    const { unmount } = renderHook(() => useViewportBelowLg())
    unmount()
    expect(mql.removeEventListener).toHaveBeenCalledWith(
      'change',
      mql.addEventListener.mock.calls[0]?.[1],
    )
  })
})
