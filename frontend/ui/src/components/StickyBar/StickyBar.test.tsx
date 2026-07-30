import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StickyBar } from './StickyBar.tsx'

// Class-token set for an element, for real set-difference assertions (the
// zero-CLS test below compares the two states' full class lists, not samples).
function classSet(el: Element | null): Set<string> {
  return new Set((el?.className ?? '').split(/\s+/).filter(Boolean))
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => !b.has(token))
}

function bar(elevated: boolean) {
  render(
    <StickyBar elevated={elevated} brand={<span data-testid="brand-slot-child" />} data-testid="bar">
      <span>right</span>
    </StickyBar>,
  )
  return screen.getByTestId('bar')
}

describe('StickyBar', () => {
  it('is sticky, layered, and gutter-aligned', () => {
    const el = bar(false)
    expect(el.className).toContain('sticky')
    expect(el.className).toContain('top-0')
    expect(el.className).toContain('px-[var(--space-6)]')
  })

  it('at rest: transparent border present (zero-CLS reservation), no compaction', () => {
    const el = bar(false)
    expect(el.className).toContain('border-b')
    expect(el.className).toContain('border-transparent')
    expect(el.querySelector('[data-brand-slot]')?.className).not.toContain('scale-')
  })

  it('elevated: border colors in, brand slot compacts, box classes unchanged', () => {
    const el = bar(true)
    expect(el.className).toContain('border-border')
    expect(el.className).not.toContain('border-transparent')
    const brand = el.querySelector('[data-brand-slot]')
    expect(brand?.className).toContain('sm:scale-[0.82]')
    expect(brand?.className).toContain('origin-left')
    // The brand slot's HEIGHT class is identical in both states (paint-only rule).
    expect(brand?.className).toContain('h-[clamp(30px,22px+2.12vw,56px)]')
  })

  // The NORMATIVE zero-CLS invariant, pinned as a full set-difference: across
  // rest → elevated the header's classes differ ONLY by the border-color swap
  // and the brand slot's ONLY by the added compaction transform. Any state-
  // conditional layout class (padding, height, gap…) fails this test.
  it('zero-CLS: states differ only by border color (header) and compaction (brand slot)', () => {
    render(
      <>
        <StickyBar elevated={false} brand={<span />} data-testid="bar-rest">
          <span>right</span>
        </StickyBar>
        <StickyBar elevated brand={<span />} data-testid="bar-elevated">
          <span>right</span>
        </StickyBar>
      </>,
    )
    const rest = screen.getByTestId('bar-rest')
    const elevated = screen.getByTestId('bar-elevated')

    const restHeader = classSet(rest)
    const elevatedHeader = classSet(elevated)
    expect(diff(restHeader, elevatedHeader)).toEqual(['border-transparent'])
    expect(diff(elevatedHeader, restHeader)).toEqual(['border-border'])

    const restBrand = classSet(rest.querySelector('[data-brand-slot]'))
    const elevatedBrand = classSet(elevated.querySelector('[data-brand-slot]'))
    expect(diff(restBrand, elevatedBrand)).toEqual([])
    expect(diff(elevatedBrand, restBrand)).toEqual(['sm:scale-[0.82]'])
  })
})
