import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Wordmark } from './Wordmark.tsx'

describe('Wordmark', () => {
  it('renders a named SVG image (role=img + aria-label)', () => {
    const { getByRole } = render(<Wordmark aria-label="Mythrun" />)
    expect(getByRole('img', { name: 'Mythrun' }).tagName.toLowerCase()).toBe('svg')
  })

  it('paints in currentColor via the text-ink token (no raw color)', () => {
    const { getByRole } = render(<Wordmark aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('class')).toContain('text-ink')
    expect(svg.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('preserves the locked 1618:771 aspect (width derived from the size height)', () => {
    const { getByRole } = render(<Wordmark aria-label="Mythrun" size={771} />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('height')).toBe('771')
    expect(svg.getAttribute('width')).toBe('1618')
    expect(svg.getAttribute('viewBox')).toBe('0 0 1618 771')
  })

  it('defaults to a 48px height with aria-hidden geometry', () => {
    const { getByRole } = render(<Wordmark aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('height')).toBe('48')
    for (const p of svg.querySelectorAll('path')) expect(p).toHaveAttribute('aria-hidden', 'true')
  })

  it('passes through data-testid and forwards its ref', () => {
    const ref = createRef<SVGSVGElement>()
    const { getByTestId } = render(<Wordmark aria-label="Mythrun" data-testid="wm" ref={ref} />)
    expect(getByTestId('wm')).toBeDefined()
    expect(ref.current).toBeInstanceOf(SVGSVGElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(<Wordmark aria-label="Mythrun" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
