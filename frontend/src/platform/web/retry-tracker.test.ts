import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRetryAttempts, readRetryAttempts, recordRetryAttempt } from './retry-tracker.ts'

// The route-error retry burst counter (myth-t1ccl). A pure sessionStorage-backed
// counter with an explicit `now` seam (no fake timers): it proves a fresh error
// reads 0, retries accumulate within the burst window, and a gap past the window
// resets the count — the "reset on recovery" the error boundary can't hook.

const BURST_WINDOW_MS = 60_000

afterEach(() => {
  sessionStorage.clear()
})

describe('retry-tracker', () => {
  it('reads 0 on a fresh error (nothing stored)', () => {
    expect(readRetryAttempts(1_000)).toBe(0)
  })

  it('accumulates retries within the burst window', () => {
    const t0 = 1_000
    expect(recordRetryAttempt(t0)).toBe(1)
    expect(recordRetryAttempt(t0 + 5_000)).toBe(2)
    expect(recordRetryAttempt(t0 + 10_000)).toBe(3)
    expect(readRetryAttempts(t0 + 10_000)).toBe(3)
  })

  it('resets to a fresh count once a retry gap exceeds the burst window', () => {
    const t0 = 1_000
    expect(recordRetryAttempt(t0)).toBe(1)
    const lastActivity = t0 + 1_000
    expect(recordRetryAttempt(lastActivity)).toBe(2)
    // Staleness is measured from the LAST retry — a long pause after it → new burst.
    const later = lastActivity + BURST_WINDOW_MS + 1
    expect(readRetryAttempts(later)).toBe(0)
    expect(recordRetryAttempt(later)).toBe(1)
  })

  it('recovers to 0 on a corrupt stored value', () => {
    sessionStorage.setItem('mythrun_retry_burst', '{ not json')
    expect(readRetryAttempts(1_000)).toBe(0)
  })

  it('recovers to 0 on a wrong-shaped stored value (valid JSON, missing fields)', () => {
    sessionStorage.setItem('mythrun_retry_burst', JSON.stringify({ count: 'three' }))
    expect(readRetryAttempts(1_000)).toBe(0)
  })

  it('clears the burst outright', () => {
    recordRetryAttempt(1_000)
    recordRetryAttempt(2_000)
    clearRetryAttempts()
    expect(readRetryAttempts(2_000)).toBe(0)
  })

  // The degrade contract: a disabled store (private mode / quota) must never
  // throw out of the tracker — the boundary keeps retrying, just uncounted.
  it('degrades without throwing when the store is disabled', () => {
    // The custom jsdom env splits realms: the test scope's `Storage` is not the
    // constructor behind `sessionStorage` — spy on the ACTUAL prototype.
    const proto = Object.getPrototypeOf(sessionStorage) as Storage
    const setSpy = vi.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const removeSpy = vi.spyOn(proto, 'removeItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => recordRetryAttempt(1_000)).not.toThrow()
    expect(() => {
      clearRetryAttempts()
    }).not.toThrow()
    setSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
