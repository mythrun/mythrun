import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { CoverDither } from './CoverDither.tsx'

// CoverDither — the card-scale dither cover carrying a world's two-colour identity.
// Unlike `Dither` (a fixed-geometry transition STRIP cropped to a 20-cell band framed
// by two solid sections), CoverDither is a FULL-FIELD tiled texture that fills its host
// in BOTH axes (the card-band aspect / the mobile square). jsdom has no layout, so these
// assert STRUCTURE + the one behaviour that genuinely matters here: every `WorldColor`
// resolves to the CORRECT css-var namespace (the 12 avatar pigments → `--color-avatar-{name}`;
// the paper/ember ramp steps → `--color-{name}`), never a raw colour, never the wrong
// namespace (`sienna` is a pigment, so `--color-avatar-sienna`, NOT `--color-sienna`).

describe('CoverDither', () => {
  it('renders a decorative (aria-hidden) full-field texture that fills its host', () => {
    const { container } = render(<CoverDither from="sienna" to="paper-100" />)
    const texture = container.querySelector('[data-cover-texture]')
    expect(texture).not.toBeNull()
    expect(texture).toHaveAttribute('aria-hidden', 'true')
    expect(texture?.tagName.toLowerCase()).toBe('svg')
    // Fills the host in both dimensions (the cover IS the whole field, not a strip).
    expect(texture).toHaveClass('h-full')
    expect(texture).toHaveClass('w-full')
  })

  it('renders the texture as an SVG of Bayer cells, NOT a CSS gradient', () => {
    const { container } = render(<CoverDither from="moss" to="ember-900" />)
    const texture = container.querySelector('[data-cover-texture]')
    expect(texture?.querySelectorAll('rect').length).toBeGreaterThan(0)
    const html = container.innerHTML
    expect(html).not.toMatch(/linear-gradient|radial-gradient|conic-gradient|<linearGradient|<radialGradient/)
  })

  it('TILES square cells (crisp at any size): no viewBox + no preserveAspectRatio stretch', () => {
    const { container } = render(<CoverDither from="lapis" to="paper-100" />)
    const texture = container.querySelector('[data-cover-texture]')
    expect(texture).not.toBeNull()
    expect(texture).not.toHaveAttribute('viewBox')
    expect(texture).not.toHaveAttribute('preserveAspectRatio')
    expect(texture).toHaveAttribute('shape-rendering', 'crispEdges')
    const pattern = container.querySelector('[data-cover-pattern]')
    expect(pattern).toHaveAttribute('patternUnits', 'userSpaceOnUse')
  })

  it('fills the transition axis too: the pattern fill rect spans the host (100% × 100%)', () => {
    // The KEY difference from Dither (which pins its transition axis to a fixed band
    // strip): CoverDither's fill rect fills BOTH axes, so the dither tiles edge-to-edge.
    const { container } = render(<CoverDither from="iris" to="paper-900" />)
    const fill = container.querySelector('[data-cover-fill]')
    expect(fill).not.toBeNull()
    expect(fill).toHaveAttribute('width', '100%')
    expect(fill).toHaveAttribute('height', '100%')
    expect(container.innerHTML).toContain('url(#')
  })

  it('resolves a PIGMENT to the avatar namespace: from="sienna" → var(--color-avatar-sienna)', () => {
    const { container } = render(<CoverDither from="sienna" to="ochre" />)
    const html = container.innerHTML
    expect(html).toContain('var(--color-avatar-sienna)')
    expect(html).toContain('var(--color-avatar-ochre)')
    // The crux of the task: a pigment must NOT collapse to the base ramp namespace.
    expect(html).not.toContain('var(--color-sienna)')
    expect(html).not.toContain('var(--color-ochre)')
  })

  it('resolves a RAMP STEP to the base namespace: from="paper-100" → var(--color-paper-100)', () => {
    const { container } = render(<CoverDither from="paper-100" to="ember-900" />)
    const html = container.innerHTML
    expect(html).toContain('var(--color-paper-100)')
    expect(html).toContain('var(--color-ember-900)')
    // A ramp step is NOT in the avatar namespace.
    expect(html).not.toContain('var(--color-avatar-paper-100)')
    expect(html).not.toContain('var(--color-avatar-ember-900)')
  })

  it('resolves a MIXED pair (pigment + ramp) into the two right namespaces at once', () => {
    const { container } = render(<CoverDither from="sienna" to="paper-100" />)
    const html = container.innerHTML
    expect(html).toContain('var(--color-avatar-sienna)') // pigment → avatar ns
    expect(html).toContain('var(--color-paper-100)') // ramp → base ns
    expect(html).not.toContain('var(--color-sienna)') // and not the wrong ns
  })

  it('names colours ONLY through tokens — never a raw hex / rgb / oklch value', () => {
    const { container } = render(<CoverDither from="umber" to="ember-100" />)
    const html = container.innerHTML
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('carries a distinct intrinsic shape per size: band (wide) vs swatch (square)', () => {
    const band = render(<CoverDither from="pine" to="paper-100" size="band" />)
    const bandRoot = band.container.querySelector('[data-cover-size]')
    expect(bandRoot).toHaveAttribute('data-cover-size', 'band')
    expect(bandRoot).not.toHaveClass('aspect-square')
    band.unmount()

    const swatch = render(<CoverDither from="pine" to="paper-100" size="swatch" />)
    const swatchRoot = swatch.container.querySelector('[data-cover-size]')
    expect(swatchRoot).toHaveAttribute('data-cover-size', 'swatch')
    expect(swatchRoot).toHaveClass('aspect-square')
  })

  it('defaults to the band size when size is omitted', () => {
    const { container } = render(<CoverDither from="rose" to="paper-900" />)
    expect(container.querySelector('[data-cover-size]')).toHaveAttribute('data-cover-size', 'band')
  })

  it('passes through data-testid', () => {
    const { container } = render(<CoverDither from="slate" to="paper-50" data-testid="world-cover" />)
    expect(container.querySelector('[data-testid="world-cover"]')).not.toBeNull()
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CoverDither ref={ref} from="verdigris" to="paper-100" />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (a decorative, aria-hidden leaf)', async () => {
    const band = render(<CoverDither from="sienna" to="paper-100" size="band" />)
    expect(await axe(band.container)).toHaveNoViolations()
    band.unmount()
    const swatch = render(<CoverDither from="heather" to="ember-900" size="swatch" />)
    expect(await axe(swatch.container)).toHaveNoViolations()
  })
})
