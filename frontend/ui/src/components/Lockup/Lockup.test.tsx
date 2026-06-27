import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Lockup } from './Lockup.tsx'

// jsdom has no layout, so these assert STRUCTURE: the lockup is a single SVG image
// with an accessible name (role="img" + aria-label), it is theme-driven (paints in
// `currentColor` tinted by the `text-ink` token — never a raw color), the locked
// 1032:778 aspect is preserved as `size` changes, and the inner geometry is hidden
// from assistive tech.

describe('Lockup', () => {
  it('renders an SVG image with the accessible name from aria-label', () => {
    const { getByRole } = render(<Lockup aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.tagName.toLowerCase()).toBe('svg')
  })

  it('paints in currentColor via the text-ink token (theme-driven, no raw color)', () => {
    const { getByRole } = render(<Lockup aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('class')).toContain('text-ink')
    // No raw color anywhere in the rendered artwork.
    const html = svg.outerHTML
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/)
  })

  it('inlines the two locked paths, each hidden from assistive tech', () => {
    const { getByRole } = render(<Lockup aria-label="Mythrun" />)
    const paths = getByRole('img', { name: 'Mythrun' }).querySelectorAll('path')
    // Mark + wordmark = exactly two paths.
    expect(paths.length).toBe(2)
    for (const p of paths) expect(p).toHaveAttribute('aria-hidden', 'true')
  })

  it('preserves the locked 1032:778 aspect: width is derived from the size height', () => {
    const { getByRole } = render(<Lockup aria-label="Mythrun" size={778} />)
    const svg = getByRole('img', { name: 'Mythrun' })
    // height = size = 778 → width = 778 × 1032/778 = 1032 (the exact aspect).
    expect(svg.getAttribute('height')).toBe('778')
    expect(svg.getAttribute('width')).toBe('1032')
    expect(svg.getAttribute('viewBox')).toBe('0 0 1032 778')
  })

  it('defaults to a 128px height with the aspect-derived width', () => {
    const { getByRole } = render(<Lockup aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('height')).toBe('128')
    expect(Number(svg.getAttribute('width'))).toBeCloseTo((128 * 1032) / 778, 5)
  })

  it('passes through data-testid and forwards its ref', () => {
    const ref = createRef<SVGSVGElement>()
    const { getByTestId } = render(<Lockup aria-label="Mythrun" data-testid="brand-lockup" ref={ref} />)
    expect(getByTestId('brand-lockup')).toBeDefined()
    expect(ref.current).toBeInstanceOf(SVGSVGElement)
  })

  it('has no axe violations (a named image)', async () => {
    const { container } = render(<Lockup aria-label="Mythrun" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
