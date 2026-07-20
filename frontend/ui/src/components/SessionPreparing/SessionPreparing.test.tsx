import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { SessionPreparing } from './SessionPreparing.tsx'

// SessionPreparing (myth-ep74g) — the calm between-sessions hold. Load-bearing
// invariants pinned here: it is `aria-busy` with the atmospheric label as the single
// AT source of truth (a polite live region; the figure is decoration); the figure
// BREATHES only when motion is allowed (reducedMotion → still); it is square 1-bit
// register (no circles); and a long line wraps inside a narrow column (~375px).

const LABEL = 'The DM is preparing the next session…'
const DETAIL = 'This can take a moment.'

function renderPreparing(overrides: { label?: string; detail?: string; reducedMotion?: boolean } = {}) {
  const { label = LABEL, detail, reducedMotion = false } = overrides
  return render(<SessionPreparing label={label} {...(detail !== undefined ? { detail } : {})} reducedMotion={reducedMotion} />)
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

  it('renders the atmospheric label and, when given, a quiet detail sub-line', () => {
    renderPreparing({ detail: DETAIL })
    // The label appears in the visible column too (aria-hidden) alongside the SR copy.
    expect(screen.getAllByText(LABEL).length).toBeGreaterThan(0)
    expect(screen.getByText(DETAIL)).toBeInTheDocument()
  })

  it('the figure BREATHES when motion is allowed', () => {
    renderPreparing({ reducedMotion: false })
    expect(screen.getByTestId('session-preparing-figure').className).toMatch(/animate-pulse/)
  })

  it('reduced motion drops the breathing pulse to a still figure', () => {
    renderPreparing({ reducedMotion: true })
    expect(screen.getByTestId('session-preparing')).toHaveAttribute('data-reduced-motion', 'true')
    expect(screen.getByTestId('session-preparing-figure').className).not.toMatch(/animate-pulse/)
  })

  it('is square register — no circles', () => {
    const { container } = renderPreparing()
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('wraps a long detail line inside a narrow column (break-words) — no ~375px spill', () => {
    renderPreparing({ detail: 'Weaving-the-threads-of-what-happened-last-time-into-what-comes-next-carefully.' })
    expect(screen.getByText(/Weaving-the-threads/)).toHaveClass('break-words')
    expect(screen.getByTestId('session-preparing').className).toMatch(/min-w-0/)
  })

  it('has no axe violations', async () => {
    const { container } = renderPreparing({ detail: DETAIL })
    expect(await axe(container)).toHaveNoViolations()
  })
})
