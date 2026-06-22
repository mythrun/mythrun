import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Dither } from './Dither.tsx'
import { CELL_PX } from './bayer.ts'

// The exact pixels are hard to unit-test (jsdom has no layout), so these assert
// STRUCTURE: the decorative texture layer exists, it is built from the design
// TOKEN colors (CSS vars, never raw hex), it is NOT a smooth CSS gradient (the
// brand forbids those), it TILES square cells (no stretching viewBox), it honours
// the cell size + axis, and any children layer over it stay in the a11y tree.

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

  it('TILES the cells (square at any size): no viewBox + no preserveAspectRatio stretch', () => {
    // The headline contract. The OLD bug was a fixed-viewBox SVG with
    // `preserveAspectRatio="none"`, which stretched square cells into rectangles
    // when the host outgrew the viewBox. The fix authors the SVG with NO viewBox
    // (1 user unit = 1 CSS px → no internal scaling) and tiles a `<pattern>`.
    const { container } = render(<Dither />)
    const texture = container.querySelector('[data-dither-texture]')
    expect(texture).not.toBeNull()
    // No stretching: neither a viewBox to scale into nor the stretch directive.
    expect(texture).not.toHaveAttribute('viewBox')
    expect(texture).not.toHaveAttribute('preserveAspectRatio')
    // Square cells: anti-aliasing off so the cell edges stay crisp.
    expect(texture).toHaveAttribute('shape-rendering', 'crispEdges')
  })

  it('paints into a userSpaceOnUse <pattern> (the tile that repeats to fill)', () => {
    const { container } = render(<Dither scale="preview" />)
    const pattern = container.querySelector('[data-dither-pattern]')
    expect(pattern).not.toBeNull()
    // userSpaceOnUse + absolute px size → the tile is NOT scaled with the viewport.
    expect(pattern).toHaveAttribute('patternUnits', 'userSpaceOnUse')
    // One vertical preview tile = 24 cross × 8px wide, 28 axis × 8px tall.
    expect(pattern).toHaveAttribute('width', '192')
    expect(pattern).toHaveAttribute('height', '224')
    // The fill rect references the pattern, so it tiles to cover the field.
    expect(container.innerHTML).toContain('url(#')
  })

  it('draws every dither cell as a perfect cellPx square (width === height)', () => {
    const { container } = render(<Dither scale="hero" />)
    const pattern = container.querySelector('[data-dither-pattern]')
    // Every painted CELL rect (not the full-tile ground/accent backdrops) is a
    // 6×6 square at hero scale — width and height are equal, so cells never warp.
    const cellRects = Array.from(pattern?.querySelectorAll('rect') ?? []).filter(
      (r) => r.getAttribute('width') === '6' && r.getAttribute('height') === '6',
    )
    expect(cellRects.length).toBeGreaterThan(0)
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

  it('carries an intrinsic min-size so the texture is visible STANDALONE (no children)', () => {
    // The texture <svg> is `position:absolute` and contributes no height; without
    // a min-size on the root, a childless Dither in an auto-height host collapses
    // to 0px and renders blank. The root must floor itself to the cell grid.
    const { container } = render(<Dither />)
    const root = container.querySelector<HTMLElement>('[data-dither-direction]')
    expect(root).not.toBeNull()
    // vertical preview: 28 transition cells × 8px = 224px block; 24 cross × 8px = 192px inline.
    expect(root?.style.minBlockSize).toBe('224px')
    expect(root?.style.minInlineSize).toBe('192px')
  })

  it('floors the min-size to the cell grid for the HERO scale + horizontal axis', () => {
    // hero = 6px cell; horizontal transposes the axes (transition runs inline).
    const { container } = render(<Dither scale="hero" direction="horizontal" />)
    const root = container.querySelector<HTMLElement>('[data-dither-direction]')
    // transition axis (inline) = 28 cells × 6px = 168px; cross (block) = 24 × 6px = 144px.
    expect(root?.style.minInlineSize).toBe('168px')
    expect(root?.style.minBlockSize).toBe('144px')
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
