import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { Spinner } from './Spinner.tsx'

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

  it('animates by OPACITY PULSE, never rotation (brand motion rule §4)', () => {
    const { getByRole } = render(<Spinner />)
    const status = getByRole('status')
    const dot = status.querySelector('span[aria-hidden]')
    expect(dot).not.toBeNull()
    // The opacity-pulse keyframe (Tailwind `animate-pulse`: 0%/100% opacity 1,
    // 50% opacity .5). Nothing spins/slides/bounces.
    expect(dot).toHaveClass('animate-pulse')
    // Guard the negative: no rotation/slide/bounce utility leaks in.
    const html = status.innerHTML
    expect(html).not.toMatch(/animate-spin|animate-bounce|animate-ping/)
  })

  it('keeps the dots VISIBLE at rest (so reduced-motion never hides them)', () => {
    // Under prefers-reduced-motion the global reset settles the animation; the
    // dots must have NO opacity-0 resting class, so they stay visible.
    const { getByRole } = render(<Spinner />)
    const dots = getByRole('status').querySelectorAll('span[aria-hidden]')
    expect(dots.length).toBeGreaterThan(0)
    for (const dot of dots) {
      expect(dot).not.toHaveClass('opacity-0')
    }
  })

  it('renders at the requested token size', () => {
    const { getByRole } = render(<Spinner size="lg" />)
    const dot = getByRole('status').querySelector('span[aria-hidden]')
    expect(dot).toHaveClass('w-[var(--icon-sm)]', 'h-[var(--icon-sm)]')
  })

  it('forwards its ref to the underlying element', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Spinner ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(<Spinner label="Loading your campaign" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
