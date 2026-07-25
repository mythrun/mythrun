import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Divider } from './Divider.tsx'

describe('Divider', () => {
  it('renders a separator', () => {
    const { getByRole } = render(<Divider data-testid="divider" />)
    const el = getByRole('separator')
    expect(el.tagName).toBe('DIV')
  })

  it('is horizontal by default with aria-orientation=horizontal', () => {
    const { getByRole } = render(<Divider />)
    const el = getByRole('separator')
    expect(el.getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('sets aria-orientation=vertical when orientation=vertical', () => {
    const { getByRole } = render(<Divider orientation="vertical" />)
    expect(getByRole('separator').getAttribute('aria-orientation')).toBe('vertical')
  })

  it('is a 1px horizontal rule by default', () => {
    const { getByRole } = render(<Divider />)
    const el = getByRole('separator')
    expect(el.classList.contains('h-px')).toBe(true)
    expect(el.classList.contains('w-full')).toBe(true)
  })

  it('is a 1px vertical rule when orientation=vertical', () => {
    const { getByRole } = render(<Divider orientation="vertical" />)
    const el = getByRole('separator')
    expect(el.classList.contains('w-px')).toBe(true)
    expect(el.classList.contains('h-full')).toBe(true)
  })

  it('uses the decorative --border token by default (not --border-strong)', () => {
    const { getByRole } = render(<Divider />)
    const el = getByRole('separator')
    expect(el.classList.contains('bg-border')).toBe(true)
    expect(el.classList.contains('bg-border-strong')).toBe(false)
  })

  it('uses the interactive-grade border token for tone="strong" (the mid step)', () => {
    const { getByRole } = render(<Divider tone="strong" />)
    const el = getByRole('separator')
    // Between the decorative hairline and the full ink seam: a segment that must
    // read as PRESENT (a stepper's pending tick — ux-run2 myth-tf60g) without
    // claiming the completed-ink weight.
    expect(el.classList.contains('bg-border-strong')).toBe(true)
    expect(el.classList.contains('bg-border')).toBe(false)
    expect(el.classList.contains('bg-paper-900')).toBe(false)
  })

  it('uses the ink pigment (paper-900) for tone="ink", not the decorative border', () => {
    const { getByRole } = render(<Divider tone="ink" />)
    const el = getByRole('separator')
    // The ink seam is the non-inverting dark ramp token, so it stays a dark line
    // in dark mode too (unlike the adaptive --ink text token).
    expect(el.classList.contains('bg-paper-900')).toBe(true)
    expect(el.classList.contains('bg-border')).toBe(false)
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Divider ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (horizontal)', async () => {
    const { container } = render(<Divider />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (vertical)', async () => {
    const { container } = render(<Divider orientation="vertical" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
