import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Dither } from './Dither.tsx'
import { CELL_PX } from './bayer.ts'

// The exact pixels are hard to unit-test (jsdom has no layout), so these assert
// STRUCTURE: the decorative texture layer exists, it is built from the design
// TOKEN colors (CSS vars, never raw hex), it is NOT a smooth CSS gradient (the
// brand forbids those), it honours the cell size + axis, and any children layer
// over it stay in the a11y tree.

describe('Dither', () => {
  it('renders a decorative (aria-hidden) texture layer', () => {
    const { container } = render(<Dither />)
    const texture = container.querySelector('[data-dither-texture]')
    expect(texture).not.toBeNull()
    expect(texture).toHaveAttribute('aria-hidden', 'true')
    // The texture layer is itself the SVG.
    expect(texture?.tagName.toLowerCase()).toBe('svg')
  })

  it('renders the texture as an SVG of Bayer cells, NOT a CSS gradient', () => {
    const { container } = render(<Dither />)
    const texture = container.querySelector('[data-dither-texture]')
    // A faithful Bayer dither is drawn cell-by-cell (SVG rects), not interpolated.
    expect(texture?.querySelectorAll('rect').length).toBeGreaterThan(0)
    // The forbidden smooth fallback: assert no gradient is used anywhere.
    const html = container.innerHTML
    expect(html).not.toMatch(/linear-gradient|radial-gradient|conic-gradient|<linearGradient|<radialGradient/)
  })

  it('paints cells with the design TOKEN colors, never raw hex', () => {
    const { container } = render(<Dither pairing="light-ember" />)
    const html = container.innerHTML
    // Ground = paper-100, accent = ember-600 — referenced as token CSS vars.
    expect(html).toContain('var(--color-paper-100)')
    expect(html).toContain('var(--color-ember-600)')
    // No raw color sigils anywhere in the output.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('uses the locked pairings (light-ink, dark-cream)', () => {
    const ink = render(<Dither pairing="light-ink" />)
    expect(ink.container.innerHTML).toContain('var(--color-paper-100)')
    expect(ink.container.innerHTML).toContain('var(--color-paper-900)')
    ink.unmount()
    const reverse = render(<Dither pairing="dark-cream" />)
    expect(reverse.container.innerHTML).toContain('var(--color-paper-900)')
    expect(reverse.container.innerHTML).toContain('var(--color-paper-100)')
  })

  it('honours the locked cell size: 8px preview (default), 6px hero', () => {
    expect(CELL_PX.preview).toBe(8)
    expect(CELL_PX.hero).toBe(6)
    const preview = render(<Dither scale="preview" />)
    expect(preview.container.querySelector('[data-cell-px="8"]')).not.toBeNull()
    preview.unmount()
    const hero = render(<Dither scale="hero" />)
    expect(hero.container.querySelector('[data-cell-px="6"]')).not.toBeNull()
  })

  it('defaults to the vertical axis and respects direction', () => {
    const vertical = render(<Dither />)
    expect(vertical.container.querySelector('[data-dither-direction="vertical"]')).not.toBeNull()
    vertical.unmount()
    const horizontal = render(<Dither direction="horizontal" />)
    expect(horizontal.container.querySelector('[data-dither-direction="horizontal"]')).not.toBeNull()
  })

  it('renders children OVER the texture, keeping them accessible', () => {
    render(
      <Dither>
        <button type="button">dither.cta</button>
      </Dither>,
    )
    // The content is a real, accessible element (not hidden by the texture).
    expect(screen.getByRole('button', { name: 'dither.cta' })).toBeInTheDocument()
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Dither ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (the texture is decorative; content stays labelled)', async () => {
    const { container } = render(
      <Dither>
        <button type="button">dither.cta</button>
      </Dither>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
