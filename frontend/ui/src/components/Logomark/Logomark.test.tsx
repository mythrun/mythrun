import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Logomark } from './Logomark.tsx'

// jsdom has no layout, so these assert STRUCTURE: the mark is a single named SVG
// image, it is theme/token-driven (currentColor + a `text-*` token, never raw
// color), it scales CRISP (shape-rendering=crispEdges, the pixel-art rule), the
// tone switches the token utility, and the geometry is hidden from AT.

describe('Logomark', () => {
  it('renders a named SVG image (role=img + aria-label)', () => {
    const { getByRole } = render(<Logomark aria-label="Mythrun" />)
    expect(getByRole('img', { name: 'Mythrun' }).tagName.toLowerCase()).toBe('svg')
  })

  it('scales CRISP for the pixel art (shape-rendering=crispEdges) and paints in currentColor', () => {
    const { getByRole } = render(<Logomark aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges')
    expect(svg.getAttribute('fill')).toBe('currentColor')
    // No raw color in the artwork (the export fill is stripped).
    expect(svg.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('defaults to the ink token tone and switches to ember on tone="ember"', () => {
    const ink = render(<Logomark aria-label="Mythrun" />)
    expect(ink.getByRole('img').getAttribute('class')).toContain('text-ink')
    ink.unmount()
    const ember = render(<Logomark aria-label="Mythrun" tone="ember" />)
    const cls = ember.getByRole('img').getAttribute('class') ?? ''
    expect(cls).toContain('text-ember-600')
    expect(cls).not.toContain('text-ink')
  })

  it('is square (1:1): width === height === size', () => {
    const { getByRole } = render(<Logomark aria-label="Mythrun" size={96} />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('width')).toBe('96')
    expect(svg.getAttribute('height')).toBe('96')
    expect(svg.getAttribute('viewBox')).toBe('0 0 512 512')
  })

  it('defaults to a 64px square and hides its geometry from AT', () => {
    const { getByRole } = render(<Logomark aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('height')).toBe('64')
    for (const p of svg.querySelectorAll('path')) expect(p).toHaveAttribute('aria-hidden', 'true')
  })

  it('passes through data-testid and forwards its ref', () => {
    const ref = createRef<SVGSVGElement>()
    const { getByTestId } = render(<Logomark aria-label="Mythrun" data-testid="mark" ref={ref} />)
    expect(getByTestId('mark')).toBeDefined()
    expect(ref.current).toBeInstanceOf(SVGSVGElement)
  })

  it('has no axe violations (a named image)', async () => {
    const { container } = render(<Logomark aria-label="Mythrun" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
