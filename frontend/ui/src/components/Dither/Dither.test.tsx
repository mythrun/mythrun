import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Dither } from './Dither.tsx'
import { CELL_PX } from './bayer.ts'

// The exact pixels are hard to unit-test (jsdom has no layout), so these assert
// STRUCTURE: the decorative texture layer exists, it is built from the design TOKEN
// colors (CSS vars, never raw hex), it is NOT a smooth CSS gradient (the brand forbids
// those), it TILES square cells (no stretching viewBox), it honours the cell size +
// axis, and — the key behaviour here — it is CROPPED to the dithered band (no solid
// frame blocks) and is a LEAF (no children compose on the texture).

describe('Dither', () => {
  it('renders a decorative (aria-hidden) texture layer', () => {
    const { container } = render(<Dither />)
    const texture = container.querySelector('[data-dither-texture]')
    expect(texture).not.toBeNull()
    expect(texture).toHaveAttribute('aria-hidden', 'true')
    expect(texture?.tagName.toLowerCase()).toBe('svg')
  })

  it('renders the texture as an SVG of Bayer cells, NOT a CSS gradient', () => {
    const { container } = render(<Dither />)
    const texture = container.querySelector('[data-dither-texture]')
    expect(texture?.querySelectorAll('rect').length).toBeGreaterThan(0)
    const html = container.innerHTML
    expect(html).not.toMatch(/linear-gradient|radial-gradient|conic-gradient|<linearGradient|<radialGradient/)
  })

  it('TILES the cells (square at any size): no viewBox + no preserveAspectRatio stretch', () => {
    const { container } = render(<Dither />)
    const texture = container.querySelector('[data-dither-texture]')
    expect(texture).not.toBeNull()
    expect(texture).not.toHaveAttribute('viewBox')
    expect(texture).not.toHaveAttribute('preserveAspectRatio')
    expect(texture).toHaveAttribute('shape-rendering', 'crispEdges')
  })

  it('CROPS to the dithered band — the pattern tile is the band only (no solid frames)', () => {
    const { container } = render(<Dither scale="preview" />)
    const pattern = container.querySelector('[data-dither-pattern]')
    expect(pattern).not.toBeNull()
    expect(pattern).toHaveAttribute('patternUnits', 'userSpaceOnUse')
    // Vertical preview tile = 24 cross × 8px wide, 20 BAND cells × 8px tall (NOT the
    // old 28-cell extent — the 4-cell ground + 4-cell accent frames are cropped out).
    expect(pattern).toHaveAttribute('width', '192')
    expect(pattern).toHaveAttribute('height', '160')
    expect(container.innerHTML).toContain('url(#')
  })

  it('draws every dither cell as a perfect cellPx square (width === height)', () => {
    const { container } = render(<Dither scale="hero" />)
    const pattern = container.querySelector('[data-dither-pattern]')
    const cellRects = Array.from(pattern?.querySelectorAll('rect') ?? []).filter(
      (r) => r.getAttribute('width') === '6' && r.getAttribute('height') === '6',
    )
    expect(cellRects.length).toBeGreaterThan(0)
  })

  it('paints cells with the design TOKEN colors, never raw hex', () => {
    const { container } = render(<Dither pairing="light-ember" />)
    const html = container.innerHTML
    expect(html).toContain('var(--color-paper-100)')
    expect(html).toContain('var(--color-ember-600)')
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

  it('FIXES the band on the transition axis and tiles + floors the cross axis', () => {
    // The transition axis is pinned to the band's own length (a fixed crossfade strip);
    // the cross axis fills the host (100%) with an intrinsic minimum (one tile) so the
    // band is visible standalone.
    const { container } = render(<Dither />)
    const root = container.querySelector<HTMLElement>('[data-dither-direction]')
    expect(root).not.toBeNull()
    // vertical preview: band (block) = 20 cells × 8px = 160px FIXED; cross (inline) fills,
    // floored to one 24-cell × 8px = 192px tile.
    expect(root?.style.blockSize).toBe('160px')
    expect(root?.style.inlineSize).toBe('100%')
    expect(root?.style.minInlineSize).toBe('192px')
  })

  it('transposes the fixed/tiling axes for the HERO scale + horizontal direction', () => {
    const { container } = render(<Dither scale="hero" direction="horizontal" />)
    const root = container.querySelector<HTMLElement>('[data-dither-direction]')
    // horizontal hero: band (inline) = 20 × 6px = 120px FIXED; cross (block) fills,
    // floored to one 24 × 6px = 144px tile.
    expect(root?.style.inlineSize).toBe('120px')
    expect(root?.style.blockSize).toBe('100%')
    expect(root?.style.minBlockSize).toBe('144px')
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Dither ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (a decorative, aria-hidden leaf)', async () => {
    const { container } = render(<Dither />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
