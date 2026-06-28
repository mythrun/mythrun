import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createConnection, useConnectionState } from './connection.ts'

// The shared connection primitive: ONE backoff/ceiling state machine, but each
// `createConnection()` mints its OWN zustand/vanilla store (per-instance state,
// never a module-level singleton). These tests pin each spec requirement:
// per-instance isolation, the backoff schedule + jitter bound, attempt-reset on a
// successful open, the ceiling → failed{exhausted}, and the React read seam.

afterEach(cleanup)

describe('createConnection — per-instance state (a)', () => {
  it('mints independent state per instance: mutating one leaves the other pristine', () => {
    const a = createConnection({ ceiling: 10 })
    const b = createConnection({ ceiling: 10 })

    a.recordDrop()

    expect(a.store.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 })
    // A second instance is unaffected — no shared singleton.
    expect(b.store.getState()).toMatchObject({ status: 'connecting', attempt: 0 })
  })

  it('starts in `connecting` with attempt 0 and no failure reason', () => {
    const conn = createConnection({ ceiling: 10 })
    expect(conn.store.getState()).toEqual({ status: 'connecting', attempt: 0 })
  })
})

describe('backoff schedule + jitter (b)', () => {
  it('follows 1s,2s,4s,8s,30s,30s… with each sample inside ±10%', () => {
    const conn = createConnection({ ceiling: 50 })
    const bases = [1000, 2000, 4000, 8000, 30000, 30000] as const

    for (const base of bases) {
      conn.recordDrop() // advance to the next reconnecting attempt
      const lo = Math.floor(base * 0.9)
      const hi = Math.ceil(base * 1.1)
      for (let sample = 0; sample < 40; sample++) {
        const delay = conn.nextDelayMs()
        expect(delay).toBeGreaterThanOrEqual(lo)
        expect(delay).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('actually jitters (successive samples are not all identical)', () => {
    const conn = createConnection({ ceiling: 10 })
    conn.recordDrop()
    const samples = new Set(Array.from({ length: 30 }, () => conn.nextDelayMs()))
    expect(samples.size).toBeGreaterThan(1)
  })

  it('honours an injected deterministic backoff (the jitter-free test seam)', () => {
    const conn = createConnection({ ceiling: 10, backoff: (attempt) => attempt * 100 })
    conn.recordDrop() // attempt 1
    expect(conn.nextDelayMs()).toBe(100)
    conn.recordDrop() // attempt 2
    expect(conn.nextDelayMs()).toBe(200)
  })
})

describe('attempt counter resets on onOpenSuccess (c)', () => {
  it('a successful open zeroes the climbing attempt counter', () => {
    const conn = createConnection({ ceiling: 10 })
    conn.recordDrop()
    conn.recordDrop()
    conn.recordDrop()
    expect(conn.store.getState().attempt).toBe(3)

    conn.onOpenSuccess()

    expect(conn.store.getState()).toEqual({ status: 'connected', attempt: 0 })
  })
})

describe('ceiling → failed{exhausted} (d)', () => {
  it('allows `ceiling` reconnect attempts, then exhausts on the next drop', () => {
    const conn = createConnection({ ceiling: 3 })

    expect(conn.recordDrop()).toBe(true) // attempt 1
    expect(conn.recordDrop()).toBe(true) // attempt 2
    expect(conn.recordDrop()).toBe(true) // attempt 3 (== ceiling)
    expect(conn.store.getState()).toMatchObject({ status: 'reconnecting', attempt: 3 })

    expect(conn.recordDrop()).toBe(false) // ceiling reached → no more retries
    expect(conn.store.getState()).toEqual({
      status: 'failed',
      attempt: 3,
      failedReason: 'exhausted',
    })
  })

  it('re-arms cleanly: reset() after exhaustion returns to connecting and clears the reason', () => {
    const conn = createConnection({ ceiling: 1 })
    conn.recordDrop() // attempt 1 (== ceiling)
    conn.recordDrop() // exhausted
    expect(conn.store.getState().failedReason).toBe('exhausted')

    conn.reset()

    expect(conn.store.getState()).toEqual({ status: 'connecting', attempt: 0 })
  })
})

describe('terminal + teardown transitions', () => {
  it('fail("denied") routes a ticket 403/404 to a terminal failed{denied}', () => {
    const conn = createConnection({ ceiling: 10 })
    conn.fail('denied')
    expect(conn.store.getState()).toEqual({
      status: 'failed',
      attempt: 0,
      failedReason: 'denied',
    })
  })

  it('markClosed() is a clean teardown (closed, attempt reset, no failure reason)', () => {
    const conn = createConnection({ ceiling: 10 })
    conn.recordDrop()
    conn.markClosed()
    expect(conn.store.getState()).toEqual({ status: 'closed', attempt: 0 })
  })
})

describe('single-flight generation token', () => {
  it('mints a monotonically increasing token, readable without advancing', () => {
    const conn = createConnection({ ceiling: 10 })
    expect(conn.generation()).toBe(0)
    expect(conn.nextGeneration()).toBe(1)
    expect(conn.nextGeneration()).toBe(2)
    expect(conn.generation()).toBe(2)
  })

  it('is per-instance (a superseded socket on one client cannot affect another)', () => {
    const a = createConnection({ ceiling: 10 })
    const b = createConnection({ ceiling: 10 })
    a.nextGeneration()
    a.nextGeneration()
    expect(a.generation()).toBe(2)
    expect(b.generation()).toBe(0)
  })
})

describe('useConnectionState — React read seam (e)', () => {
  it('re-renders a consumer when the per-instance store transitions', () => {
    const conn = createConnection({ ceiling: 10 })
    const client = { connectionState: conn.store }

    const { result } = renderHook(() => useConnectionState(client))
    expect(result.current.status).toBe('connecting')

    act(() => {
      conn.onOpenSuccess()
    })
    expect(result.current).toMatchObject({ status: 'connected', attempt: 0 })

    act(() => {
      conn.recordDrop()
    })
    expect(result.current).toMatchObject({ status: 'reconnecting', attempt: 1 })
  })
})
