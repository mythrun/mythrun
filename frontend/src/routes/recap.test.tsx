import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { SessionRecap } from '@mythrun/client-core'
import { RecapView } from './recap.tsx'

afterEach(() => {
  cleanup()
})

// RecapView is the PURE presentation seam of the post-play recap (myth-lhp99) —
// no fetch, no router, no i18n runtime: it takes the recap row + resolved labels +
// a back callback. The polling read (RecapData) and the Suspense route wrap it; the
// three states (null / pending / ready) + the secret-free surface are pinned here.
// Plain matchers only (this web package's vitest setup doesn't extend jest-dom).

const LABELS = {
  title: 'The session ends',
  sessionLabel: (n: number) => `Session ${String(n)}`,
  summaryHeading: 'What happened',
  threadsHeading: 'Threads left open',
  cost: 'One session credit spent.',
  pending: 'Writing up the recap…',
  empty: 'No recap yet.',
  back: 'Back to campaign',
}

const READY: SessionRecap = {
  sessionNumber: 3,
  endedAt: '2026-07-24T02:00:00.000Z',
  status: 'ready',
  summary: 'You walked the long road home and slept without fear for the first time in weeks.',
  emergingThreads: ['The count still expects an answer.', 'The dagger mark is unaccounted for.'],
}

describe('RecapView', () => {
  it('ready: renders the session label, summary prose, threads, cost, and back CTA', () => {
    render(<RecapView recap={READY} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByText('Session 3')).toBeTruthy()
    expect(screen.getByTestId('recap-summary').textContent).toContain('You walked the long road home')
    const threads = screen.getByTestId('recap-threads')
    expect(threads.textContent).toContain('The count still expects an answer.')
    expect(threads.textContent).toContain('The dagger mark is unaccounted for.')
    expect(screen.getByTestId('recap-cost').textContent).toBe('One session credit spent.')
    expect(screen.getByTestId('recap-back')).toBeTruthy()
  })

  it('ready with no threads: omits the threads block', () => {
    render(<RecapView recap={{ ...READY, emergingThreads: [] }} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-summary')).toBeTruthy()
    expect(screen.queryByTestId('recap-threads')).toBeNull()
  })

  it('pending: shows the calm writing-up beat, not the summary', () => {
    const pending: SessionRecap = { sessionNumber: 3, endedAt: null, status: 'pending' }
    render(<RecapView recap={pending} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-pending').textContent).toContain('Writing up the recap…')
    expect(screen.queryByTestId('recap-summary')).toBeNull()
    // The cost + back CTA are always present, even while the analysis is pending.
    expect(screen.getByTestId('recap-cost')).toBeTruthy()
    expect(screen.getByTestId('recap-back')).toBeTruthy()
  })

  it('null: renders the calm empty beat with a way back', () => {
    render(<RecapView recap={null} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-empty').textContent).toContain('No recap yet.')
    expect(screen.getByTestId('recap-back')).toBeTruthy()
  })

  it('the back CTA fires onBack', () => {
    const onBack = vi.fn()
    render(<RecapView recap={READY} labels={LABELS} onBack={onBack} />)
    fireEvent.click(screen.getByTestId('recap-back'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
