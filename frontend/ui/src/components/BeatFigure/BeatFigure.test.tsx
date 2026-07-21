import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { BeatFigure } from './BeatFigure.tsx'

// BeatFigure's motion is a canvas (inert under jsdom — no 2D context), so these tests cover the
// React SHELL: the decorative aria-hidden wrapper, the mode/level inspection hooks, tone
// classes, and clamping. The fill/breathe MATH is unit-tested in develop.test.ts.

describe('BeatFigure', () => {
  it('renders a decorative (aria-hidden) figure carrying its mode', () => {
    const { getByTestId } = render(<BeatFigure mode="fill" level={0.5} reducedMotion={false} data-testid="fig" />)
    const fig = getByTestId('fig')
    expect(fig).toHaveAttribute('aria-hidden', 'true')
    expect(fig).toHaveAttribute('data-beat-mode', 'fill')
    expect(fig.querySelector('canvas')).not.toBeNull()
  })

  it('exposes the clamped fill level for inspection (fill mode only)', () => {
    const { getByTestId, rerender } = render(<BeatFigure mode="fill" level={0.42} reducedMotion={false} data-testid="fig" />)
    expect(getByTestId('fig')).toHaveAttribute('data-beat-level', '0.42')
    // Out-of-range levels clamp to [0, 1].
    rerender(<BeatFigure mode="fill" level={1.8} reducedMotion={false} data-testid="fig" />)
    expect(getByTestId('fig')).toHaveAttribute('data-beat-level', '1')
    rerender(<BeatFigure mode="fill" level={-3} reducedMotion={false} data-testid="fig" />)
    expect(getByTestId('fig')).toHaveAttribute('data-beat-level', '0')
  })

  it('carries no fill level in breathe mode (indeterminate)', () => {
    const { getByTestId } = render(<BeatFigure mode="breathe" reducedMotion={false} data-testid="fig" />)
    const fig = getByTestId('fig')
    expect(fig).toHaveAttribute('data-beat-mode', 'breathe')
    expect(fig).not.toHaveAttribute('data-beat-level')
  })

  it('paints the theme-flipping token tone by default, the frozen paper relic on request', () => {
    const { getByTestId } = render(<BeatFigure mode="fill" level={0.5} reducedMotion={false} data-testid="fig" />)
    expect(getByTestId('fig').className).toMatch(/border-ink/)
    expect(getByTestId('fig').className).toMatch(/bg-surface/)

    const paper = render(<BeatFigure mode="fill" level={0.5} reducedMotion={false} tone="paper" data-testid="paper" />)
    expect(paper.getByTestId('paper').className).toMatch(/border-paper-900/)
    expect(paper.getByTestId('paper').className).toMatch(/bg-paper-50/)
  })

  it('is square (no rounded corners) — the silhouette stays hard', () => {
    const { getByTestId } = render(<BeatFigure mode="fill" level={0.5} reducedMotion={false} data-testid="fig" />)
    expect(getByTestId('fig').className).not.toMatch(/rounded-(?!none)/)
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<BeatFigure ref={ref} mode="breathe" reducedMotion={false} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (decorative)', async () => {
    const { container } = render(<BeatFigure mode="fill" level={0.5} reducedMotion={false} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
