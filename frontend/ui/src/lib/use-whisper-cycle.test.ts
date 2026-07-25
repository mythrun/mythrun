import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReducedMotionPref, useWhisperCycle } from './use-whisper-cycle.ts'

// useWhisperCycle — the shared loading-surface flavor rotation (myth-i2pdo).
// These tests pin the contract the two long-wait screens hang off: the shuffled
// walk + settled ledger, the no-repeat reshuffle boundary, the capped history,
// the reduced-motion hold (including the RUNTIME toggle — the subscription must
// stay live), count-change re-seeding vs identity-churn stability, and the
// degenerate rosters (0–1 lines). The RNG is injected, so shuffles are driven
// deterministically: with `() => 0.9` Fisher-Yates leaves the listed order in
// place; queued values steer specific reshuffles.

interface FakeMql {
  matches: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  fire: () => void
}

/** Stub `matchMedia` with a controllable reduced-motion MQL: `fire()` invokes
 *  the hook's change listener (the OS-level toggle mid-wait). */
function stubReducedMotion(matches: boolean): FakeMql {
  let listener: (() => void) | undefined
  const mql: FakeMql = {
    matches,
    addEventListener: vi.fn((_type: string, cb: () => void) => {
      listener = cb
    }),
    removeEventListener: vi.fn(),
    fire: () => listener?.(),
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql))
  return mql
}

/** An RNG that plays queued values, then 0 — steers specific shuffles. */
function seqRandom(values: readonly number[]): () => number {
  const queue = [...values]
  return () => queue.shift() ?? 0
}

const IDENTITY_RNG = (): number => 0.9

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useWhisperCycle', () => {
  it('walks the shuffle on the interval, settling each shown line into the ledger newest-first', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWhisperCycle(['a', 'b'], 1000, IDENTITY_RNG))
    expect(result.current.current).toBe('a')
    expect(result.current.history).toEqual([])

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.current).toBe('b')
    expect(result.current.history).toEqual(['a'])

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // The permutation is exhausted: re-shuffled and walking again.
    expect(result.current.current).toBe('a')
    expect(result.current.history).toEqual(['b', 'a'])
  })

  it('never repeats a line back-to-back across the reshuffle boundary (the head swaps away)', () => {
    vi.useFakeTimers()
    // Initial shuffle (0.9) keeps [a, b]; the reshuffle draw (0) would produce
    // [b, a] — a back-to-back 'b' — so the head must swap to the tail.
    const { result } = renderHook(() => useWhisperCycle(['a', 'b'], 1000, seqRandom([0.9, 0])))
    expect(result.current.current).toBe('a')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.current).toBe('b')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.current).toBe('a')
  })

  it('caps the ledger at maxHistory (newest first)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWhisperCycle(['a', 'b', 'c'], 1000, IDENTITY_RNG, 2))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.history).toEqual(['c', 'b'])
  })

  it('holds the opening line under reduced motion (no interval, empty ledger)', () => {
    stubReducedMotion(true)
    vi.useFakeTimers()
    const { result } = renderHook(() => useWhisperCycle(['a', 'b'], 1000, IDENTITY_RNG))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.current).toBe('a')
    expect(result.current.history).toEqual([])
  })

  it('a RUNTIME reduced-motion toggle stops the rotation, and toggling back resumes it', () => {
    const mql = stubReducedMotion(false)
    vi.useFakeTimers()
    const { result } = renderHook(() => useWhisperCycle(['a', 'b'], 1000, IDENTITY_RNG))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.current).toBe('b')

    mql.matches = true
    act(() => {
      mql.fire()
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    // Rotation stopped where it stood — nothing new shown or settled.
    expect(result.current.current).toBe('b')
    expect(result.current.history).toEqual(['a'])

    mql.matches = false
    act(() => {
      mql.fire()
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.history).toEqual(['b', 'a'])
  })

  it('a label COUNT change re-seeds the rotation and clears the ledger', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ labels }: { labels: readonly string[] }) => useWhisperCycle(labels, 1000, IDENTITY_RNG),
      { initialProps: { labels: ['a', 'b'] as readonly string[] } },
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.history).toEqual(['a'])

    rerender({ labels: ['x', 'y', 'z'] })
    expect(result.current.current).toBe('x')
    expect(result.current.history).toEqual([])
  })

  it('identity churn on labels (same count) does NOT reset the rotation', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ labels }: { labels: readonly string[] }) => useWhisperCycle(labels, 1000, IDENTITY_RNG),
      { initialProps: { labels: ['a', 'b'] as readonly string[] } },
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // A parent rebuilding the array every render must not restart the cycle.
    rerender({ labels: ['a', 'b'] })
    expect(result.current.current).toBe('b')
    expect(result.current.history).toEqual(['a'])
  })

  it('empty labels: current is undefined, nothing rotates', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWhisperCycle([], 1000, IDENTITY_RNG))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.current).toBeUndefined()
    expect(result.current.history).toEqual([])
  })

  it('labels shrinking to EMPTY mid-flight renders no phantom ledger rows', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ labels }: { labels: readonly string[] }) => useWhisperCycle(labels, 1000, IDENTITY_RNG),
      { initialProps: { labels: ['a', 'b'] as readonly string[] } },
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.history).toEqual(['a'])

    // The settled index (0) now points into an EMPTY roster (i % 0 is NaN) —
    // the render between the prop change and the re-seed effect must show an
    // empty ledger, never a blank or undefined row.
    rerender({ labels: [] })
    expect(result.current.current).toBeUndefined()
    expect(result.current.history).toEqual([])
  })

  it('a single label holds with no interval (nothing to rotate through)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWhisperCycle(['only'], 1000, IDENTITY_RNG))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.current).toBe('only')
    expect(result.current.history).toEqual([])
  })

  it('an out-of-contract RNG (returns ≥ 1) can never crash the cycle or surface a non-label', () => {
    vi.useFakeTimers()
    // random ≥ 1 drives Fisher-Yates out of range (a sparse, extended
    // permutation) — the indexed-access guards must keep every render a REAL
    // label anyway. 1.5 then 1.0 leaves a hole mid-permutation; the walk
    // crosses it without settling a phantom ledger entry.
    const labels = ['a', 'b', 'c']
    const { result } = renderHook(() => useWhisperCycle(labels, 1000, seqRandom([1.5, 1])))
    for (let tick = 0; tick < 8; tick++) {
      expect(labels).toContain(result.current.current)
      for (const line of result.current.history) expect(labels).toContain(line)
      act(() => {
        vi.advanceTimersByTime(1000)
      })
    }
  })
})

describe('useReducedMotionPref', () => {
  it('defaults to false when there is no matchMedia (jsdom / SSR)', () => {
    const { result } = renderHook(() => useReducedMotionPref())
    expect(result.current).toBe(false)
  })

  it('reads the initial preference and tracks the runtime toggle', () => {
    const mql = stubReducedMotion(true)
    const { result } = renderHook(() => useReducedMotionPref())
    expect(result.current).toBe(true)
    mql.matches = false
    act(() => {
      mql.fire()
    })
    expect(result.current).toBe(false)
  })

  it('unsubscribes from the query on unmount', () => {
    const mql = stubReducedMotion(false)
    const { unmount } = renderHook(() => useReducedMotionPref())
    unmount()
    expect(mql.removeEventListener).toHaveBeenCalledWith(
      'change',
      mql.addEventListener.mock.calls[0]?.[1],
    )
  })
})
