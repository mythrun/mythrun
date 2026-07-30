import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { HorizontalLockup } from './HorizontalLockup.tsx'

describe('HorizontalLockup', () => {
  it('renders a named SVG image (role=img + aria-label)', () => {
    const { getByRole } = render(<HorizontalLockup aria-label="Mythrun" />)
    expect(getByRole('img', { name: 'Mythrun' }).tagName.toLowerCase()).toBe('svg')
  })

  it('paints in currentColor via the text-ink token (no raw color)', () => {
    const { getByRole } = render(<HorizontalLockup aria-label="Mythrun" />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.getAttribute('class')).toContain('text-ink')
    expect(svg.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('inlines the two locked paths (wordmark + mark), each hidden from AT', () => {
    const { getByRole } = render(<HorizontalLockup aria-label="Mythrun" />)
    const paths = getByRole('img', { name: 'Mythrun' }).querySelectorAll('path')
    expect(paths.length).toBe(2)
    for (const p of paths) expect(p).toHaveAttribute('aria-hidden', 'true')
  })

  it('preserves the locked 1284:548 aspect (width derived from the size height)', () => {
    const { getByRole } = render(<HorizontalLockup aria-label="Mythrun" size={548} />)
    const svg = getByRole('img', { name: 'Mythrun' })
    expect(svg.getAttribute('height')).toBe('548')
    expect(svg.getAttribute('width')).toBe('1284')
    expect(svg.getAttribute('viewBox')).toBe('0 0 1284 548')
  })

  it('defaults to a 56px height', () => {
    const { getByRole } = render(<HorizontalLockup aria-label="Mythrun" />)
    expect(getByRole('img', { name: 'Mythrun' }).getAttribute('height')).toBe('56')
  })

  it("size='fluid' renders no fixed dimensions and fills the parent's height", () => {
    render(<HorizontalLockup aria-label="Mythrun" size="fluid" data-testid="lockup" />)
    const svg = screen.getByTestId('lockup')
    expect(svg).not.toHaveAttribute('width')
    expect(svg).not.toHaveAttribute('height')
    expect(svg.getAttribute('class')).toContain('h-full')
    expect(svg.getAttribute('class')).toContain('w-auto')
  })

  it('numeric size keeps the locked aspect (regression)', () => {
    render(<HorizontalLockup aria-label="Mythrun" size={56} data-testid="lockup-n" />)
    const svg = screen.getByTestId('lockup-n')
    expect(svg).toHaveAttribute('height', '56')
    expect(Number(svg.getAttribute('width'))).toBeCloseTo((56 * 1284) / 548, 0)
  })

  it('passes through data-testid and forwards its ref', () => {
    const ref = createRef<SVGSVGElement>()
    const { getByTestId } = render(<HorizontalLockup aria-label="Mythrun" data-testid="hl" ref={ref} />)
    expect(getByTestId('hl')).toBeDefined()
    expect(ref.current).toBeInstanceOf(SVGSVGElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(<HorizontalLockup aria-label="Mythrun" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
