import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { ApiClientProvider, type ApiContext } from '@mythrun/client-core'
import { DevCostTicker } from './dev-cost-ticker.tsx'

// The widget polls GET /api/dev/api-cost via client-core's `getDevApiCost`,
// which fetches. We stub `fetch` with a controllable response and drive the
// 2s poll interval with fake timers. A minimal Response-shaped object is
// enough for `defineEndpoint` (it reads status / ok / json()).

const ctx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

function fakeRes(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// Mutable server total the stubbed fetch returns; 404 flag flips the widget to
// its hidden state; error flag simulates a transient network failure (fetch
// rejects — NOT an HTTP error — so the widget mutes and keeps polling); pending
// flag hands out a deferred the test settles manually (for unmount-mid-flight).
let currentTotal = 0
let respond404 = false
let respondError = false
let respondPending = false
let deferred: { resolve: (r: Response) => void; reject: (e: unknown) => void } | undefined

function renderTicker(props: { dev?: boolean } = {}): void {
  render(
    <ApiClientProvider value={ctx}>
      <DevCostTicker {...props} />
    </ApiClientProvider>,
  )
}

/** Advance fake timers + flush the fetch promise chain inside act(). */
async function flush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  currentTotal = 0
  respond404 = false
  respondError = false
  vi.useFakeTimers()
  deferred = undefined
  respondPending = false
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      if (respondPending) {
        return new Promise<Response>((resolve, reject) => {
          deferred = { resolve, reject }
        })
      }
      if (respondError) return Promise.reject(new TypeError('network down'))
      return Promise.resolve(
        respond404 ? fakeRes(404, { code: 'nf' }) : fakeRes(200, { totalUsd: currentTotal }),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DevCostTicker', () => {
  // The build-gate contract (MYT-102). The widget previously mounted
  // unconditionally and relied on the endpoint 404ing to hide — but staging's
  // backend answered 200 (its route was env-gated, not bypass-gated), so the
  // ticker rendered on staging and polled indefinitely. The primary gate is now
  // the frontend build flag: in a non-dev build the component renders null and
  // NEVER starts the poll loop. The 404-hide below remains as defense in depth.
  it('dev=false (prod/staging build): renders nothing and never polls', async () => {
    currentTotal = 1.2345
    renderTicker({ dev: false })
    await flush(0)
    // A few poll windows: not just invisible — the loop must never start.
    await flush(3 * 2000)
    expect(screen.queryByTestId('dev-cost-ticker')).toBeNull()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('defaults the gate to import.meta.env.DEV (true under vitest → dev path)', () => {
    // Pins the default-prop wiring the other tests rely on: under vitest the
    // Vite dev flag is true, so a propless <DevCostTicker /> exercises the
    // dev=true path — and a prod build (DEV statically false) gets the null
    // branch above. Mirrors the guard in routes/dev-transport.test.tsx.
    expect(import.meta.env.DEV).toBe(true)
  })

  it('captures the first reading as a baseline (delta $0.0000) then ticks up', async () => {
    currentTotal = 1.2345
    renderTicker()
    await flush(0) // resolve the initial poll

    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API $0.0000')

    // Spend accrues → next poll shows the delta above the captured baseline.
    currentTotal = 1.5
    await flush(2000)
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API $0.2655')
  })

  it('Reset re-baselines to the current total (delta back to $0.0000)', async () => {
    currentTotal = 1.0
    renderTicker()
    await flush(0)
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API $0.0000')

    currentTotal = 1.5
    await flush(2000)
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API $0.5000')

    await act(() => {
      fireEvent.click(screen.getByTestId('dev-cost-ticker-reset'))
      return Promise.resolve()
    })
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API $0.0000')
  })

  it('non-404 failure: shows a muted — , keeps polling, recovers on success', async () => {
    respondError = true
    renderTicker()
    await flush(0)
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API —')

    // Reset before any successful reading is a no-op (no baseline to capture).
    await act(() => {
      fireEvent.click(screen.getByTestId('dev-cost-ticker-reset'))
      return Promise.resolve()
    })
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API —')

    // Backend comes back: the loop was still polling, so the next tick captures
    // the baseline and the display recovers to a live $0.0000.
    respondError = false
    currentTotal = 2.0
    await flush(2000)
    expect(screen.getByTestId('dev-cost-ticker-value').textContent).toBe('API $0.0000')
  })

  it('renders null when the endpoint 404s (route absent — defense in depth)', async () => {
    respond404 = true
    renderTicker()
    await flush(0)
    expect(screen.queryByTestId('dev-cost-ticker')).toBeNull()
  })

  // The two `if (cancelled) return` guards in the poll are the leak protection:
  // an unmount while a fetch is in flight must neither set state on the
  // unmounted component nor reschedule the timer (which would poll forever).
  // The pending-mode stub hands the test a deferred: flush lets the poll reach
  // the in-flight fetch, cleanup() unmounts (cancelled = true), THEN the test
  // settles the fetch — and no further poll may ever fire.
  it('unmount mid-flight (success path): no reschedule after cleanup', async () => {
    respondPending = true
    renderTicker()
    await flush(0) // auth headers resolve → fetch #1 goes out, still pending
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    cleanup()
    deferred?.resolve(fakeRes(200, { totalUsd: 1.0 }))
    await flush(5 * 2000) // settle → cancelled guard; prove no reschedule
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('unmount mid-flight (failure path): no reschedule after cleanup', async () => {
    respondPending = true
    renderTicker()
    await flush(0)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    cleanup()
    deferred?.reject(new TypeError('network down'))
    await flush(5 * 2000) // settle → catch-side cancelled guard; no reschedule
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})
