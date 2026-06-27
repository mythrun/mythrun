import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Dither } from './Dither.tsx'
import { BAND_CELLS, CELL_PX } from './bayer.ts'

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

  it('defaults to the canonical light→ember palette tokens, never raw hex', () => {
    // Default from/to = paper-100 (ground) → ember-600 (accent), as `var(--color-*)`.
    const { container } = render(<Dither />)
    const html = container.innerHTML
    expect(html).toContain('var(--color-paper-100)')
    expect(html).toContain('var(--color-ember-600)')
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('maps from/to palette token names to var(--color-{name}) refs', () => {
    // Any palette token resolves to its `--color-{name}` var — ink crossfade…
    const ink = render(<Dither from="paper-100" to="paper-900" />)
    expect(ink.container.innerHTML).toContain('var(--color-paper-100)')
    expect(ink.container.innerHTML).toContain('var(--color-paper-900)')
    ink.unmount()
    // …the reverse (dark→cream)…
    const reverse = render(<Dither from="paper-900" to="paper-100" />)
    expect(reverse.container.innerHTML).toContain('var(--color-paper-900)')
    expect(reverse.container.innerHTML).toContain('var(--color-paper-100)')
    reverse.unmount()
    // …and an arbitrary non-preset pick from the palette (the point of from/to).
    const custom = render(<Dither from="paper-100" to="ember-400" />)
    expect(custom.container.innerHTML).toContain('var(--color-paper-100)')
    expect(custom.container.innerHTML).toContain('var(--color-ember-400)')
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

  it('flip REVERSES the transition: every accent cell mirrors to the opposite end of the band', () => {
    // Accent cells are square `cellPx` rects positioned by their row (`y` attr =
    // step × cellPx); the full-tile GROUND backdrop rect is excluded by filtering
    // to the cellPx-square rects. A flipped band mirrors each accent cell's row
    // across the band: a cell at step `i` (y = i × cellPx) moves to step
    // `BAND_CELLS-1-i` (y = (BAND_CELLS-1-i) × cellPx). So mapping every flipped
    // `y` back through that mirror must reproduce the default band's multiset of
    // `y` values exactly (same grain, inverted ramp).
    const cellPx = CELL_PX.preview // default scale
    const span = (BAND_CELLS - 1) * cellPx
    const cellYs = (container: HTMLElement): number[] =>
      Array.from(container.querySelectorAll('[data-dither-pattern] rect'))
        .filter((r) => r.getAttribute('width') === String(cellPx))
        .map((r) => Number(r.getAttribute('y')))

    const base = render(<Dither />)
    const baseYs = cellYs(base.container).sort((a, b) => a - b)
    base.unmount()

    const flipped = render(<Dither flip />)
    const flippedYs = cellYs(flipped.container)
    const flippedMirrored = flippedYs.map((y) => span - y).sort((a, b) => a - b)

    expect(flippedMirrored).toEqual(baseYs)
    // And the orientation actually changed: the TOP row (y === 0) is SPARSE in the
    // default band and DENSE when flipped — the crown now hangs from the top edge.
    const topRow = (ys: number[]): number => ys.filter((y) => y === 0).length
    expect(topRow(flippedYs)).toBeGreaterThan(topRow(baseYs))
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
