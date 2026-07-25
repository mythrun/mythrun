import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { SessionPreparing } from './SessionPreparing.tsx'

// SessionPreparing (myth-ep74g; MYT-102 timer revamp) — the calm between-sessions hold.
// Load-bearing invariants pinned here: it is `aria-busy` with the atmospheric label as the single
// AT source of truth (a polite live region; the figure is decoration); the figure BREATHES (an
// indeterminate density field) unless motion is reduced; MYT-102 — the figure is an AMBIENT SQUARE
// (a fixed-width box, NOT the old full-width band that read as a progress bar), and the sub-line
// answers "how long / has it broken?" by precedence: coarse countdown → stalled → detail fallback.
// The breathing motion itself is canvas-driven and covered by the BeatFigure pure-math tests.

const LABEL = 'The DM is preparing the next session…'
const DETAIL = 'This can take a moment.'

function renderPreparing(
  overrides: {
    label?: string
    detail?: string
    countdownLabel?: string
    stalledLabel?: string
    whisperLabels?: readonly string[]
    leaveLabel?: string
    reducedMotion?: boolean
  } = {},
) {
  const {
    label = LABEL,
    detail,
    countdownLabel,
    stalledLabel,
    whisperLabels,
    leaveLabel,
    reducedMotion = false,
  } = overrides
  return render(
    <SessionPreparing
      label={label}
      {...(detail !== undefined ? { detail } : {})}
      {...(countdownLabel !== undefined ? { countdownLabel } : {})}
      {...(stalledLabel !== undefined ? { stalledLabel } : {})}
      {...(whisperLabels !== undefined ? { whisperLabels } : {})}
      {...(leaveLabel !== undefined ? { leaveLabel } : {})}
      reducedMotion={reducedMotion}
    />,
  )
}

describe('SessionPreparing', () => {
  it('is aria-busy and carries the atmospheric label as a polite live region (the AT truth)', () => {
    renderPreparing()
    expect(screen.getByTestId('session-preparing')).toHaveAttribute('aria-busy', 'true')
    const live = screen.getByTestId('session-preparing-live')
    expect(live).toHaveAttribute('role', 'status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent(LABEL)
  })

  it('renders the atmospheric label and, as the FALLBACK sub-line, the quiet detail', () => {
    renderPreparing({ detail: DETAIL })
    // The label appears in the visible column too (aria-hidden) alongside the SR copy.
    expect(screen.getAllByText(LABEL).length).toBeGreaterThan(0)
    // Detail shows only when neither a countdown nor a stalled line is present.
    expect(screen.getByTestId('session-preparing-detail')).toHaveTextContent(DETAIL)
  })

  it('renders the figure as an AMBIENT SQUARE box (not the old full-width bar band)', () => {
    // The MYT-102 fix for "bar-shaped but spinner-behavior": the breathing figure
    // is constrained to a fixed square box so it reads as ambient texture, not an
    // unfilled progress bar. The box is a fixed width (not w-full).
    renderPreparing()
    const box = screen.getByTestId('session-preparing-figure').parentElement
    expect(box?.className).toMatch(/w-\[144px\]/)
  })

  it('shows the COARSE countdown (aria-hidden) in place of the detail when an estimate holds', () => {
    renderPreparing({ detail: DETAIL, countdownLabel: '2 min remaining' })
    const countdown = screen.getByTestId('session-preparing-countdown')
    expect(countdown).toHaveTextContent('2 min remaining')
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
    // Coarse — never a ticking `M:SS`.
    expect(countdown.textContent).not.toMatch(/\d:\d\d/)
    // The estimate REPLACES the calm detail fallback (no double line).
    expect(screen.queryByTestId('session-preparing-detail')).toBeNull()
  })

  it('shows the stalled line (meaningful, NOT aria-hidden) once the estimate exhausts — never a stuck bar', () => {
    renderPreparing({ detail: DETAIL, stalledLabel: 'Still working. This is taking longer than usual.' })
    const stalled = screen.getByTestId('session-preparing-stalled')
    expect(stalled).toHaveTextContent('Still working. This is taking longer than usual.')
    expect(stalled).not.toHaveAttribute('aria-hidden')
    expect(screen.queryByTestId('session-preparing-detail')).toBeNull()
    expect(screen.queryByTestId('session-preparing-countdown')).toBeNull()
  })

  it('prefers the countdown over the stalled + detail lines (only one sub-line ever)', () => {
    renderPreparing({
      detail: DETAIL,
      countdownLabel: '2 min remaining',
      stalledLabel: 'Still working.',
    })
    expect(screen.getByTestId('session-preparing-countdown')).toBeInTheDocument()
    expect(screen.queryByTestId('session-preparing-stalled')).toBeNull()
    expect(screen.queryByTestId('session-preparing-detail')).toBeNull()
  })

  it('renders an INDETERMINATE breathing figure (no progress) when motion is allowed', () => {
    renderPreparing({ reducedMotion: false })
    expect(screen.getByTestId('session-preparing-figure')).toHaveAttribute('data-beat-mode', 'breathe')
    expect(screen.getByTestId('session-preparing')).toHaveAttribute('data-reduced-motion', 'false')
  })

  it('reduced motion freezes the figure to a still frame', () => {
    renderPreparing({ reducedMotion: true })
    expect(screen.getByTestId('session-preparing')).toHaveAttribute('data-reduced-motion', 'true')
    // Still the breathing figure (a legible static frame under reduced motion), no progress meter.
    expect(screen.getByTestId('session-preparing-figure')).toHaveAttribute('data-beat-mode', 'breathe')
  })

  it('is square register — no circles', () => {
    const { container } = renderPreparing()
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('renders the rotating whisper column (sub size) when whisper lines are supplied (ux-run2 myth-i2pdo)', () => {
    const whispers = ['The locals take their seats.', 'The map is unrolled.'] as const
    renderPreparing({ whisperLabels: whispers })
    const current = screen.getByTestId('whisper-ledger-current')
    expect(whispers).toContain(current.textContent)
    // Decorative texture — hidden from AT (the live region stays the truth).
    expect(screen.getByTestId('session-preparing-whispers')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders no whisper column when none are supplied (the pre-run-2 anatomy holds)', () => {
    renderPreparing()
    expect(screen.queryByTestId('session-preparing-whispers')).toBeNull()
  })

  it('grants permission to leave as real (non-hidden) closing content (ux-run2 myth-i2pdo)', () => {
    renderPreparing({ leaveLabel: 'Safe to leave. The table will be set when you return.' })
    const leave = screen.getByTestId('session-preparing-leave')
    expect(leave.textContent).toBe('Safe to leave. The table will be set when you return.')
    expect(leave).not.toHaveAttribute('aria-hidden')
  })

  it('wraps a long detail line inside a narrow column (break-words) — no ~375px spill', () => {
    renderPreparing({ detail: 'Weaving-the-threads-of-what-happened-last-time-into-what-comes-next-carefully.' })
    expect(screen.getByText(/Weaving-the-threads/)).toHaveClass('break-words')
    expect(screen.getByTestId('session-preparing').className).toMatch(/min-w-0/)
  })

  it('has no axe violations (detail, countdown, and stalled sub-lines)', async () => {
    const withDetail = renderPreparing({ detail: DETAIL })
    expect(await axe(withDetail.container)).toHaveNoViolations()
    const counting = renderPreparing({ countdownLabel: '2 min remaining' })
    expect(await axe(counting.container)).toHaveNoViolations()
    const stalled = renderPreparing({ stalledLabel: 'Still working. This is taking longer than usual.' })
    expect(await axe(stalled.container)).toHaveNoViolations()
  })
})
