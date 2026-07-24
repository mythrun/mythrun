import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { HttpError, NetworkError } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { RouteErrorBoundary } from './error-boundary.tsx'
import { readRetryAttempts } from '../platform/web/retry-tracker.ts'

// The route error boundary's retryable arm (myth-t1ccl). A persistent failure used
// to loop "try again" forever with no counter, no escalation, no diagnostics. These
// tests drive a real route that throws into the boundary (the errorElement seam) and
// assert: the first failure is the plain retry; once retries have re-failed (a
// pre-seeded burst) the copy escalates + offers the harder reset + a support
// reference; the underlying error is always mirrored to the console; and pressing
// retry records the attempt.
//
// console.error is mocked so (a) react-router's own render-error logging doesn't
// spam the run and (b) the boundary's diagnostic call is assertable.

const BURST_KEY = 'mythrun_retry_burst'

function seedBurst(count: number): void {
  sessionStorage.setItem(BURST_KEY, JSON.stringify({ count, at: Date.now() }))
}

function renderWithError(error: unknown): void {
  function Throw(): React.JSX.Element {
    throw error
  }
  const router = createMemoryRouter(
    [{ path: '/', element: <Throw />, errorElement: <RouteErrorBoundary /> }],
    { initialEntries: ['/'] },
  )
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('RouteErrorBoundary — retryable arm', () => {
  it('shows the plain retry on a fresh failure (no reference)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderWithError(new NetworkError('offline'))
    expect(screen.getByTestId('error-retryable')).toBeDefined()
    expect(screen.getByRole('heading').textContent).toBe(i18n.t('error.title'))
    expect(screen.getByTestId('error-retry').textContent).toBe(i18n.t('error.retry'))
    // Not escalated → no support reference line.
    expect(screen.queryByTestId('error-reference')).toBeNull()
  })

  it('escalates copy + a harder reset + a reference once retries have re-failed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    seedBurst(2)
    renderWithError(new HttpError(503, 'HTTP 503', 'service_unavailable'))
    expect(screen.getByRole('heading').textContent).toBe(i18n.t('error.persistentTitle'))
    expect(screen.getByTestId('error-retry').textContent).toBe(i18n.t('error.reload'))
    // The support reference carries the server code when present.
    expect(screen.getByTestId('error-reference').textContent).toContain('service_unavailable')
  })

  it('falls back to the HTTP status in the reference when the error has no code', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    seedBurst(2)
    renderWithError(new HttpError(500, 'HTTP 500'))
    expect(screen.getByTestId('error-reference').textContent).toContain('500')
  })

  it('mirrors the underlying error to the console for diagnosability', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = new NetworkError('offline')
    renderWithError(err)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[mythrun] route error'), err)
  })

  it('records the attempt when retry is pressed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderWithError(new NetworkError('offline'))
    expect(readRetryAttempts()).toBe(0)
    fireEvent.click(screen.getByTestId('error-retry'))
    expect(readRetryAttempts()).toBe(1)
  })
})
