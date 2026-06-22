import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Icon } from './Icon.tsx'

describe('Icon', () => {
  it('renders an inline svg glyph tinted by currentColor', () => {
    const { container } = render(<Icon name="close" decorative />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // `fill="currentColor"` is how the glyph inherits the text color token —
    // tint comes from `text-*`, never a raw color (R3).
    expect(svg).toHaveAttribute('fill', 'currentColor')
  })

  it('hides a decorative icon from the accessibility tree', () => {
    const { container, queryByRole } = render(<Icon name="check" decorative />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    // No role → not an `img` in the a11y tree.
    expect(svg).not.toHaveAttribute('role')
    expect(queryByRole('img')).toBeNull()
  })

  it('defaults to decorative when neither label nor decorative is given', () => {
    const { container } = render(<Icon name="menu" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
  })

  it('exposes a labelled icon to assistive tech with its accessible name', () => {
    const { getByRole } = render(<Icon name="search" label="Search" />)
    const el = getByRole('img', { name: 'Search' })
    expect(el.tagName.toLowerCase()).toBe('svg')
    // A meaningful icon is NOT hidden.
    expect(el).not.toHaveAttribute('aria-hidden')
  })

  it('renders at the default md token size', () => {
    const { container } = render(<Icon name="plus" decorative />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('w-[var(--icon-md)]', 'h-[var(--icon-md)]')
  })

  it('renders at the requested token size', () => {
    const { container } = render(<Icon name="plus" size="lg" decorative />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('w-[var(--icon-lg)]', 'h-[var(--icon-lg)]')
  })

  it('forwards its ref to the underlying svg', () => {
    const ref = createRef<SVGSVGElement>()
    render(<Icon ref={ref} name="close" decorative />)
    expect(ref.current).toBeInstanceOf(SVGSVGElement)
  })

  it('has no axe violations (decorative)', async () => {
    const { container } = render(<Icon name="close" decorative />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (labelled)', async () => {
    const { container } = render(<Icon name="external-link" label="Open in a new tab" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
