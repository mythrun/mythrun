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

  it('paints the frame content ground (bg-surface), never the body bg', () => {
    // The bar must be opaque (content slides beneath it) but INVISIBLE at rest:
    // it paints the same --surface the frame's content Box paints, so only the
    // elevated hairline ever marks it. bg-bg (the body ground, one paper step
    // darker) rendered the bar as a permanent tonal band.
    const el = bar(false)
    expect(el.className).toContain('bg-surface')
    expect(classSet(el).has('bg-bg')).toBe(false)
  })

  it('blankets its children with min-w-0 (the Stack rule) so a truncating child can shrink', () => {
    const el = bar(false)
    // The Show arrangement wrappers are the header's flex children; without the
    // blanket, a truncate Button's nowrap label floors them at min-width:auto
    // and the row overflows the viewport instead of ellipsizing (660px band).
    expect(el.className).toContain('[&>*]:min-w-0')
    // The brand slot stays exempt from shrinking via its own shrink-0.
    expect(el.querySelector('[data-brand-slot]')?.className).toContain('shrink-0')
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
