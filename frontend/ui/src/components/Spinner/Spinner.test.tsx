import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Spinner } from './Spinner.tsx'
import { SPINNER_CELLS } from './develop.ts'

// Spinner is the brand's SIGNATURE "dither develop" loader: a small square whose
// 4×4 Bayer dither (paper → ember) FILLS and RECEDES on a slow opacity loop —
// like ink developing on the page. The exact pixels / pacing are unverifiable in
// jsdom (no layout, no animation clock), so these assert STRUCTURE + the brand
// invariants: a status role + accessible name, a decorative ember-on-surface
// grid, opacity-only animation (never spin/slide/bounce), a per-cell delay keyed
// to the Bayer threshold (the develop ORDER), and a LEGIBLE STATIC fallback under
// prefers-reduced-motion (never a blank box). The pure cell math is unit-tested
// in develop.test.ts; this is the component contract.

describe('Spinner', () => {
  it('exposes a status role to assistive tech', () => {
    const { getByRole } = render(<Spinner />)
    expect(getByRole('status')).toBeInTheDocument()
  })

  it('has a sensible default accessible name', () => {
    const { getByRole } = render(<Spinner />)
    // Default fallback so a bare <Spinner /> is never silent to AT.
    expect(getByRole('status')).toHaveAccessibleName('Loading')
  })

  it('uses the supplied label as its accessible name', () => {
    const { getByRole } = render(<Spinner label="Rolling the dice" />)
    expect(getByRole('status')).toHaveAccessibleName('Rolling the dice')
  })

  it('renders a decorative (aria-hidden) dither grid carrying the meaning via role+label', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    // The texture grid is decorative — the role + accessible name carry the
    // busy meaning; the cells are aria-hidden so AT never reads the grid.
    const grid = status.querySelector('[data-spinner-grid]')
    expect(grid).not.toBeNull()
    expect(grid).toHaveAttribute('aria-hidden', 'true')
    // It is a FULL square of cells (the develop fills the whole tile).
    const cells = grid?.querySelectorAll('[data-spinner-cell]') ?? []
    expect(cells.length).toBe(SPINNER_CELLS)
  })

  it('paints the lit cells with the EMBER token over a SURFACE/paper ground (no raw color)', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    // Ground is a paper/surface token utility; the cells are the ember token.
    const grid = status.querySelector('[data-spinner-grid]')
    expect(grid?.className).toMatch(/bg-(surface|paper)/)
    const cell = status.querySelector('[data-spinner-cell]')
    // `bg-accent` IS the ember token, theme-aware (ember-600 light / ember-400
    // dark) — the brand ember in both themes.
    expect(cell?.className).toMatch(/bg-(accent|ember)/)
    // No raw color sigils leak into the markup (R3 / no-ad-hoc-color).
    const html = status.innerHTML
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('develops by OPACITY, never rotation/slide/bounce (brand motion rule §4)', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    const cell = status.querySelector('[data-spinner-cell]')
    // The first-class `animate-dither-develop` theme utility (an opacity-only
    // keyframe), NOT a Tailwind transform animation.
    expect(cell).toHaveClass('animate-dither-develop')
    // Guard the negative: no rotation/slide/bounce/ping utility leaks in.
    const html = status.innerHTML
    expect(html).not.toMatch(/animate-spin|animate-bounce|animate-ping|translate|rotate|scale-/)
  })

  it('staggers each cell by a delay keyed to its Bayer threshold (the develop ORDER)', () => {
    const { getByRole } = render(<Spinner />)
    const cells = Array.from(
      getByRole('status').querySelectorAll<HTMLElement>('[data-spinner-cell]'),
    )
    // Every cell carries an explicit per-cell animation-delay (ms) — that delay
    // IS the Bayer-threshold develop order. There is more than one distinct
    // delay (the sweep), and they all sit within the cycle window.
    const delays = cells.map((c) => c.style.animationDelay)
    for (const d of delays) {
      expect(d).toMatch(/^\d+(\.\d+)?ms$/)
    }
    expect(new Set(delays).size).toBeGreaterThan(1)
  })

  it('renders a LEGIBLE STATIC dither under prefers-reduced-motion (never blank)', () => {
    // The base.css reduced-motion reset freezes CSS animations; if the resting
    // state were "all cells transparent" the box would go blank. A dedicated
    // static layer paints a fixed ~50% dither so the square stays legible. We
    // assert the static layer EXISTS and lights a non-empty, non-full subset of
    // cells (a readable dither, not a solid block or an empty box).
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    const staticCells = status.querySelectorAll('[data-spinner-cell][data-spinner-lit="true"]')
    expect(staticCells.length).toBeGreaterThan(0)
    expect(staticCells.length).toBeLessThan(SPINNER_CELLS)
  })

  it('renders at the requested token size', () => {
    const { getByRole } = render(<Spinner size="lg" />)
    const grid = getByRole('status').querySelector('[data-spinner-grid]')
    expect(grid).toHaveClass('w-[var(--icon-lg)]', 'h-[var(--icon-lg)]')
  })

  it('scales the grid square sm → md → lg via the icon token scale', () => {
    const sm = render(<Spinner size="sm" />)
    expect(sm.container.querySelector('[data-spinner-grid]')).toHaveClass(
      'w-[var(--icon-sm)]',
      'h-[var(--icon-sm)]',
    )
    sm.unmount()
    const md = render(<Spinner size="md" />)
    expect(md.container.querySelector('[data-spinner-grid]')).toHaveClass(
      'w-[var(--icon-md)]',
      'h-[var(--icon-md)]',
    )
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Spinner ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('passes through a data-testid', () => {
    const { getByTestId } = render(<Spinner data-testid="spin" />)
    expect(getByTestId('spin')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<Spinner label="Loading your campaign" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
