import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useForegroundRefetch } from './use-foreground-refetch.ts'

// useForegroundRefetch (MYT-91): the web liveness fallback behind the party-staging
// roster — a `window` focus → immediate reload, plus a slow poll that runs ONLY
// while the tab is visible (paused on visibilitychange to hidden). These drive the
// real browser signals: dispatch `focus`, advance fake timers, and flip
// `document.hidden` + fire `visibilitychange`, asserting the reload cadence.

/** Shadow `document.hidden` (a prototype getter) with an own accessor so a test can
 *  drive the visibility the hook reads. Cleared in afterEach. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

const fireVisibility = (): void => {
  document.dispatchEvent(new Event('visibilitychange'))
}
const fireFocus = (): void => {
  window.dispatchEvent(new Event('focus'))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (typeof document !== 'undefined') Reflect.deleteProperty(document, 'hidden')
})

describe('useForegroundRefetch', () => {
  it('reloads immediately on a window focus', () => {
    setHidden(false)
    const reload = vi.fn()
    renderHook(() => {
      useForegroundRefetch(reload, 5000)
    })

    act(() => {
      fireFocus()
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('runs a slow poll while the tab is visible', () => {
    vi.useFakeTimers()
    setHidden(false)
    const reload = vi.fn()
    renderHook(() => {
      useForegroundRefetch(reload, 5000)
    })

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(reload).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('pauses the poll when the tab goes hidden and resumes when visible again', () => {
    vi.useFakeTimers()
    setHidden(false)
    const reload = vi.fn()
    renderHook(() => {
      useForegroundRefetch(reload, 5000)
    })

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(reload).toHaveBeenCalledTimes(1)

    // Hidden → the interval stops; further time passes with no reload.
    setHidden(true)
    act(() => {
      fireVisibility()
    })
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(reload).toHaveBeenCalledTimes(1)

    // Visible again → the interval restarts.
    setHidden(false)
    act(() => {
      fireVisibility()
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not double the interval when visibilitychange fires while still visible', () => {
    vi.useFakeTimers()
    setHidden(false)
    const reload = vi.fn()
    renderHook(() => {
      useForegroundRefetch(reload, 5000)
    })

    // A visible→visible visibilitychange must not spin up a second interval.
    act(() => {
      fireVisibility()
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never starts a poll when mounted hidden, and cleans up its listeners on unmount', () => {
    vi.useFakeTimers()
    setHidden(true)
    const reload = vi.fn()
    const { unmount } = renderHook(() => {
      useForegroundRefetch(reload, 5000)
    })

    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(reload).not.toHaveBeenCalled()

    unmount()
    act(() => {
      fireFocus()
    })
    expect(reload).not.toHaveBeenCalled()
  })

  it('defaults the poll cadence to 15s when none is given', () => {
    vi.useFakeTimers()
    setHidden(false)
    const reload = vi.fn()
    renderHook(() => {
      useForegroundRefetch(reload)
    })

    act(() => {
      vi.advanceTimersByTime(14_999)
    })
    expect(reload).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
