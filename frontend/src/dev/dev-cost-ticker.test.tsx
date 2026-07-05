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
// its hidden state.
let currentTotal = 0
let respond404 = false

function renderTicker(): void {
  render(
    <ApiClientProvider value={ctx}>
      <DevCostTicker />
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
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(respond404 ? fakeRes(404, { code: 'nf' }) : fakeRes(200, { totalUsd: currentTotal })),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DevCostTicker', () => {
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

  it('renders null when the endpoint 404s (production / route absent)', async () => {
    respond404 = true
    renderTicker()
    await flush(0)
    expect(screen.queryByTestId('dev-cost-ticker')).toBeNull()
  })
})
