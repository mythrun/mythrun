import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { SessionProgressLine } from './SessionProgressLine.tsx'

// SessionProgressLine (myth-atxhx) — the quiet session-position line. The invariants
// pinned here are the register ones, because they are the ones a future change would
// quietly break: it is TEXT (no meter element, no numeral), its only band response is
// ink weight, and it announces politely rather than sitting decorative.

const EARLY = 'Early in the session'
const CLOSE = 'The last stretch'

describe('SessionProgressLine', () => {
  it('renders the resolved word as a polite live region (a band change is worth hearing)', () => {
    render(<SessionProgressLine label={EARLY} band="early" />)
    const line = screen.getByTestId('session-progress-line')
    expect(line).toHaveTextContent(EARLY)
    expect(line).toHaveAttribute('role', 'status')
    expect(line).toHaveAttribute('aria-live', 'polite')
  })

  it('renders NO meter and NO numeral — it is a line, not a progress bar', () => {
    const { container } = render(<SessionProgressLine label={CLOSE} band="close" />)
    // No progressbar/meter semantics anywhere: the cost-derived fraction must never
    // become a gauge over the fiction.
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.querySelector('progress')).toBeNull()
    expect(container.querySelector('meter')).toBeNull()
    // And nothing numeric leaked into the copy the component was handed.
    expect(container.textContent).not.toMatch(/\d/)
  })

  it('lifts its ink as the session closes — typographic weight, never a colour or a chip', () => {
    const { rerender } = render(<SessionProgressLine label={EARLY} band="early" />)
    const early = screen.getByTestId('session-progress-line').className
    expect(early).toContain('text-ink-tertiary')

    rerender(<SessionProgressLine label={EARLY} band="middle" />)
    expect(screen.getByTestId('session-progress-line').className).toContain('text-ink-tertiary')

    rerender(<SessionProgressLine label={EARLY} band="late" />)
    expect(screen.getByTestId('session-progress-line').className).toContain('text-ink-secondary')

    rerender(<SessionProgressLine label={CLOSE} band="close" />)
    const close = screen.getByTestId('session-progress-line').className
    expect(close).toContain('text-ink')
    expect(close).not.toContain('text-ink-tertiary')
    expect(close).not.toContain('text-ink-secondary')
  })

  it('exposes the band as data for the surface to key on, and honours a custom testid', () => {
    render(<SessionProgressLine label={CLOSE} band="close" data-testid="custom-line" />)
    expect(screen.getByTestId('custom-line')).toHaveAttribute('data-band', 'close')
  })

  it('wraps rather than spilling at narrow widths (mweb)', () => {
    render(<SessionProgressLine label={EARLY} band="early" />)
    expect(screen.getByTestId('session-progress-line').className).toContain('break-words')
  })

  it('has no axe violations', async () => {
    const { container } = render(<SessionProgressLine label={CLOSE} band="close" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
