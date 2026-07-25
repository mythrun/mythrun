import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { SessionRecap } from '@mythrun/client-core'
import { RecapView } from './recap.tsx'

afterEach(() => {
  cleanup()
})

// RecapView is the PURE presentation seam of the post-play recap (myth-lhp99) —
// no fetch, no router, no i18n runtime: it takes the recap row + the campaign
// identity + resolved labels + the back/copy callbacks. The polling read
// (RecapData) and the Suspense route wrap it; the three states (null / pending /
// ready) + the secret-free surface are pinned here. ux-run2 reshaped the page
// into a durable document (myth-r6b2p page identity + wait contract,
// myth-3lgh5 paragraphs/threads/exits, myth-8x3uh receipt-as-footnote).
// Plain matchers only (this web package's vitest setup doesn't extend jest-dom).

const LABELS = {
  title: 'The session ends',
  sessionLabel: (n: number) => `Session ${String(n)}`,
  formatDate: (iso: string) => `formatted(${iso})`,
  summaryHeading: 'What happened',
  threadsHeading: 'Threads left open',
  threadsKeep: 'The threads will keep until next session.',
  cost: 'This session used one credit.',
  pending: 'Writing up the recap…',
  waitContract: "It will be waiting on the campaign page when it's ready. You don't have to stay.",
  copyLink: 'Copy link',
  copied: 'Link copied',
  empty: 'No recap yet.',
  back: 'Back to campaign',
}

const IDENTITY = {
  campaignName: 'The Drowned Cartography',
  party: ['Sable', 'Wren'],
}

const READY: SessionRecap = {
  sessionNumber: 3,
  endedAt: '2026-07-24T02:00:00.000Z',
  status: 'ready',
  summary: 'You walked the long road home and slept without fear for the first time in weeks.',
  emergingThreads: ['The count still expects an answer.', 'The dagger mark is unaccounted for.'],
}

describe('RecapView', () => {
  it('ready: renders the document header — campaign eyebrow, display title, date + party record line', () => {
    render(<RecapView recap={READY} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    // The eyebrow carries the campaign name + session number (the page says what it IS).
    expect(screen.getByTestId('recap-eyebrow').textContent).toBe(
      'The Drowned Cartography · Session 3',
    )
    expect(screen.getByText('The session ends')).toBeTruthy()
    // One muted record line: date played + who was at the table.
    expect(screen.getByTestId('recap-record').textContent).toBe(
      'formatted(2026-07-24T02:00:00.000Z) · Sable, Wren',
    )
  })

  it('ready without identity: eyebrow degrades to the session label, record shows the date only', () => {
    render(<RecapView recap={READY} identity={null} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-eyebrow').textContent).toBe('Session 3')
    expect(screen.getByTestId('recap-record').textContent).toBe(
      'formatted(2026-07-24T02:00:00.000Z)',
    )
  })

  it('ready: splits a blank-line summary into separate paragraphs', () => {
    const multi = {
      ...READY,
      summary: 'The party crossed the causeway.\n\nInside, Halix named her price.\n\nThey retreated.',
    }
    render(<RecapView recap={multi} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    const summary = screen.getByTestId('recap-summary')
    const paragraphs = summary.querySelectorAll('p')
    expect(paragraphs.length).toBe(3)
    expect(paragraphs[0]?.textContent).toBe('The party crossed the causeway.')
    expect(paragraphs[2]?.textContent).toBe('They retreated.')
  })

  it('ready: a single-paragraph summary renders one paragraph', () => {
    render(<RecapView recap={READY} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-summary').querySelectorAll('p').length).toBe(1)
  })

  it('ready: threads render as an index — mono markers 01..N with the thread text', () => {
    const five = {
      ...READY,
      emergingThreads: ['t one', 't two', 't three', 't four', 't five'],
    }
    render(<RecapView recap={five} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    const threads = screen.getByTestId('recap-threads')
    expect(screen.getByTestId('recap-thread-marker-1').textContent).toBe('01')
    expect(screen.getByTestId('recap-thread-marker-5').textContent).toBe('05')
    expect(threads.textContent).toContain('t three')
  })

  it('ready with no threads: omits the threads block and the threads-keep line', () => {
    render(
      <RecapView
        recap={{ ...READY, emergingThreads: [] }}
        identity={IDENTITY}
        labels={LABELS}
        onBack={vi.fn()}
      />,
    )
    expect(screen.getByTestId('recap-summary')).toBeTruthy()
    expect(screen.queryByTestId('recap-threads')).toBeNull()
    expect(screen.queryByTestId('recap-threads-keep')).toBeNull()
  })

  it('ready: the threads-keep resume line sits with the exit block', () => {
    render(<RecapView recap={READY} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-threads-keep').textContent).toBe(
      'The threads will keep until next session.',
    )
  })

  it('the credit receipt is a footnote BELOW the back button (the document does not end on billing)', () => {
    render(<RecapView recap={READY} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    const back = screen.getByTestId('recap-back')
    const cost = screen.getByTestId('recap-cost')
    expect(cost.textContent).toBe('This session used one credit.')
    expect((back.compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
      true,
    )
  })

  it('copy link: fires the injected port and flips to the copied acknowledgement', async () => {
    const onCopyLink = vi.fn().mockResolvedValue(undefined)
    render(
      <RecapView
        recap={READY}
        identity={IDENTITY}
        labels={LABELS}
        onBack={vi.fn()}
        onCopyLink={onCopyLink}
      />,
    )
    const copy = screen.getByTestId('recap-copy-link')
    expect(copy.textContent).toBe('Copy link')
    fireEvent.click(copy)
    expect(onCopyLink).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByTestId('recap-copy-link').textContent).toBe('Link copied')
    })
  })

  it('no copy affordance without an injected port', () => {
    render(<RecapView recap={READY} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.queryByTestId('recap-copy-link')).toBeNull()
  })

  it('pending: shows the writing-up beat + the wait contract, not the summary', () => {
    const pending: SessionRecap = { sessionNumber: 3, endedAt: null, status: 'pending' }
    render(<RecapView recap={pending} identity={IDENTITY} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-pending').textContent).toContain('Writing up the recap…')
    // The contract line: waiting is a choice, leaving is safe.
    expect(screen.getByTestId('recap-wait-contract').textContent).toBe(
      "It will be waiting on the campaign page when it's ready. You don't have to stay.",
    )
    expect(screen.queryByTestId('recap-summary')).toBeNull()
    // The identity header still names the page; endedAt is null so the record is the party.
    expect(screen.getByTestId('recap-eyebrow').textContent).toBe(
      'The Drowned Cartography · Session 3',
    )
    expect(screen.getByTestId('recap-record').textContent).toBe('Sable, Wren')
    // The exit + receipt footnote are present while pending.
    expect(screen.getByTestId('recap-cost')).toBeTruthy()
    expect(screen.getByTestId('recap-back')).toBeTruthy()
  })

  it('null: renders the calm empty beat with a way back and no receipt', () => {
    render(<RecapView recap={null} identity={null} labels={LABELS} onBack={vi.fn()} />)
    expect(screen.getByTestId('recap-empty').textContent).toContain('No recap yet.')
    expect(screen.getByTestId('recap-back')).toBeTruthy()
    expect(screen.queryByTestId('recap-cost')).toBeNull()
  })

  it('the back CTA fires onBack', () => {
    const onBack = vi.fn()
    render(<RecapView recap={READY} identity={IDENTITY} labels={LABELS} onBack={onBack} />)
    fireEvent.click(screen.getByTestId('recap-back'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
