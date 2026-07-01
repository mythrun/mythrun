import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { CoverDither } from './CoverDither.tsx'

// CoverDither — the card-scale dither cover carrying a world's two-colour identity.
// Unlike `Dither` (a fixed-geometry transition STRIP cropped to a 20-cell band framed
// by two solid sections), CoverDither is a FULL-FIELD Bayer gradient that fills its
// host in BOTH axes (a top→bottom sweep). jsdom has no layout, so these assert
// STRUCTURE + the behaviour that matters: the two ends are ordered by ladder STEP
// (lower = ground, higher = accent), each `WorldColor` resolves to its uniform
// `var(--color-{ramp}-{step})` token (never a double-wrapped `var(var(...))`, never a
// raw colour), and dark mode re-inks the SAME pattern via `reInkPair`.

/** The serialized inline `style` of the root (custom properties live here). */
function styleOf(container: HTMLElement): string {
  return container.querySelector('[data-cover-size]')?.getAttribute('style') ?? ''
}

/** Tolerant matcher for a `--var: var(--color-token)` custom-property declaration. */
function hasVar(style: string, name: string, token: string): boolean {
  return new RegExp(`--cover-${name}:\\s*var\\(--color-${token}\\)`).test(style)
}

describe('CoverDither', () => {
  it('renders a decorative (aria-hidden) full-field SVG that fills its host', () => {
    const { container } = render(<CoverDither from="verdigris-200" to="moss-800" />)
    const texture = container.querySelector('[data-cover-texture]')
    expect(texture).not.toBeNull()
    expect(texture).toHaveAttribute('aria-hidden', 'true')
    expect(texture?.tagName.toLowerCase()).toBe('svg')
    // Fills the host in both dimensions (the cover IS the whole field, not a strip).
    expect(texture).toHaveClass('h-full')
    expect(texture).toHaveClass('w-full')
  })

  it('renders a FULL FIELD of Bayer <rect> cells (not a strip, not a CSS gradient)', () => {
    const { container } = render(<CoverDither from="lapis-100" to="lapis-900" />)
    const texture = container.querySelector('[data-cover-texture]')
    // The band grid is 45×27 — hundreds of cells, an order of magnitude past a strip.
    expect(texture?.querySelectorAll('rect').length ?? 0).toBeGreaterThan(100)
    const html = container.innerHTML
    expect(html).not.toMatch(/linear-gradient|radial-gradient|conic-gradient|<linearGradient|<radialGradient/)
  })

  it('stretches a fixed grid to fill: viewBox + preserveAspectRatio="none" + crispEdges', () => {
    const { container } = render(<CoverDither from="iris-200" to="iris-900" />)
    const texture = container.querySelector('[data-cover-texture]')
    // The full-field gradient must span exactly top→bottom, so the grid STRETCHES
    // (it cannot tile). The band field is 45 cols × 27 rows.
    expect(texture).toHaveAttribute('viewBox', '0 0 45 27')
    expect(texture).toHaveAttribute('preserveAspectRatio', 'none')
    expect(texture).toHaveAttribute('shape-rendering', 'crispEdges')
    // A single ground rect spans the whole field; the accent cells are 1×1 over it.
    const ground = container.querySelector('[data-cover-ground]')
    expect(ground).toHaveAttribute('width', '45')
    expect(ground).toHaveAttribute('height', '27')
  })

  it('orders the ends by STEP: the lower step is the ground, the higher the accent', () => {
    const { container } = render(<CoverDither from="verdigris-200" to="moss-800" />)
    const style = styleOf(container)
    // verdigris-200 (step 200) is the ground; moss-800 (step 800) the accent.
    expect(hasVar(style, 'ground-lt', 'verdigris-200')).toBe(true)
    expect(hasVar(style, 'accent-lt', 'moss-800')).toBe(true)
  })

  it('is independent of argument order — the lower step is ALWAYS the ground', () => {
    const { container } = render(<CoverDither from="moss-800" to="verdigris-200" />)
    const style = styleOf(container)
    // Reversed args, same result: verdigris-200 (lower step) is still the ground.
    expect(hasVar(style, 'ground-lt', 'verdigris-200')).toBe(true)
    expect(hasVar(style, 'accent-lt', 'moss-800')).toBe(true)
  })

  it('resolves a WorldColor to its UNIFORM token — from="verdigris-200" → var(--color-verdigris-200)', () => {
    const { container } = render(<CoverDither from="verdigris-200" to="moss-800" />)
    const html = container.innerHTML
    expect(html).toContain('var(--color-verdigris-200)')
    expect(html).toContain('var(--color-moss-800)')
    // The old bug: a double-wrapped var. Never again.
    expect(html).not.toContain('var(var(')
  })

  it('re-inks the SAME pattern for dark mode via reInkPair: ground→-400, accent→-900', () => {
    const { container } = render(<CoverDither from="verdigris-200" to="moss-800" />)
    const style = styleOf(container)
    // reInkPair({verdigris-200, moss-800}) → {verdigris-400, moss-900}, hues kept.
    expect(hasVar(style, 'ground-dk', 'verdigris-400')).toBe(true)
    expect(hasVar(style, 'accent-dk', 'moss-900')).toBe(true)
  })

  it('flips the pair under the .dark scope with no re-render (a dark-scoped class remaps the vars)', () => {
    const { container } = render(<CoverDither from="verdigris-200" to="moss-800" />)
    const root = container.querySelector('[data-cover-size]')
    const cls = root?.getAttribute('class') ?? ''
    // Light pair by default; the `.dark` scope points the same vars at the dark pair.
    expect(cls).toContain('[--cover-ground:var(--cover-ground-lt)]')
    expect(cls).toContain('dark:[--cover-ground:var(--cover-ground-dk)]')
    expect(cls).toContain('dark:[--cover-accent:var(--cover-accent-dk)]')
  })

  it('renders a muted paper GHOST when the colour pair is absent (a still-generating world)', () => {
    const { container } = render(<CoverDither />)
    const root = container.querySelector('[data-cover-size]')
    expect(root).toHaveAttribute('data-cover-ghost', 'true')
    const style = styleOf(container)
    // The ghost is paper-100 ground → paper-200 accent, re-inked paper-400 / paper-900.
    expect(hasVar(style, 'ground-lt', 'paper-100')).toBe(true)
    expect(hasVar(style, 'accent-lt', 'paper-200')).toBe(true)
    expect(hasVar(style, 'ground-dk', 'paper-400')).toBe(true)
    expect(hasVar(style, 'accent-dk', 'paper-900')).toBe(true)
  })

  it('is NOT a ghost when a real pair is given', () => {
    const { container } = render(<CoverDither from="sienna-200" to="verdigris-800" />)
    expect(container.querySelector('[data-cover-size]')).not.toHaveAttribute('data-cover-ghost')
  })

  it('names colours ONLY through tokens — never a raw hex / rgb / oklch value', () => {
    const { container } = render(<CoverDither from="umber-200" to="ember-800" />)
    const html = container.innerHTML
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('carries a distinct intrinsic shape per size: band (wide) vs swatch (square)', () => {
    const band = render(<CoverDither from="pine-200" to="pine-900" size="band" />)
    const bandRoot = band.container.querySelector('[data-cover-size]')
    expect(bandRoot).toHaveAttribute('data-cover-size', 'band')
    expect(bandRoot).not.toHaveClass('aspect-square')
    band.unmount()

    const swatch = render(<CoverDither from="pine-200" to="pine-900" size="swatch" />)
    const swatchRoot = swatch.container.querySelector('[data-cover-size]')
    expect(swatchRoot).toHaveAttribute('data-cover-size', 'swatch')
    expect(swatchRoot).toHaveClass('aspect-square')
    // Its coarser 12×12 grid keeps the grain visible on the small square.
    expect(swatch.container.querySelector('[data-cover-texture]')).toHaveAttribute('viewBox', '0 0 12 12')
  })

  it('sizes band to fill host width, but swatch as a fixed self-sized square thumbnail', () => {
    const band = render(<CoverDither from="pine-200" to="pine-900" size="band" />)
    const bandRoot = band.container.querySelector('[data-cover-size]')
    expect(bandRoot).toHaveClass('w-full')
    expect(bandRoot).not.toHaveClass('shrink-0')
    band.unmount()

    const swatch = render(<CoverDither from="pine-200" to="pine-900" size="swatch" />)
    const swatchRoot = swatch.container.querySelector('[data-cover-size]')
    expect(swatchRoot).toHaveClass('w-[var(--space-8)]')
    expect(swatchRoot).toHaveClass('shrink-0')
    expect(swatchRoot).not.toHaveClass('w-full')
  })

  it('defaults to the band size when size is omitted', () => {
    const { container } = render(<CoverDither from="rose-100" to="rose-800" />)
    expect(container.querySelector('[data-cover-size]')).toHaveAttribute('data-cover-size', 'band')
  })

  it('passes through data-testid', () => {
    const { container } = render(<CoverDither from="slate-200" to="slate-900" data-testid="world-cover" />)
    expect(container.querySelector('[data-testid="world-cover"]')).not.toBeNull()
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<CoverDither ref={ref} from="verdigris-200" to="verdigris-800" />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (a decorative, aria-hidden leaf)', async () => {
    const band = render(<CoverDither from="sienna-200" to="verdigris-800" size="band" />)
    expect(await axe(band.container)).toHaveNoViolations()
    band.unmount()
    const swatch = render(<CoverDither from="heather-200" to="ember-800" size="swatch" />)
    expect(await axe(swatch.container)).toHaveNoViolations()
    swatch.unmount()
    const ghost = render(<CoverDither />)
    expect(await axe(ghost.container)).toHaveNoViolations()
  })
})
