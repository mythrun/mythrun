import { describe, expect, it } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { FADE_BAND_PX, WikiScrollFrame } from './WikiScrollFrame.tsx'

// WikiScrollFrame is the wiki's reading scroll region with an overflow affordance
// (myth-lcvv2): a persistent scrollbar + shallow edge fades that announce a
// definition running past the panel edge. Since ux-run2 (myth-9dcfq) the fade is
// a CSS MASK on the scroll element itself — never a paint overlay — clamped to a
// band shallower than one text line.

/** Stub the scroll metrics jsdom doesn't lay out, then fire a scroll so the
 *  edge hook recomputes against them. */
function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    value: metrics.scrollTop,
    writable: true,
  })
  fireEvent.scroll(el)
}

describe('WikiScrollFrame', () => {
  it('renders its children inside the scroll region', () => {
    const { getByText } = render(
      <WikiScrollFrame data-testid="scroll">
        <p>a long lore definition</p>
      </WikiScrollFrame>,
    )
    expect(getByText('a long lore definition')).toBeInTheDocument()
  })

  it('renders as a <div> by default and an <article> on request', () => {
    const { getByTestId, rerender } = render(
      <WikiScrollFrame data-testid="scroll">x</WikiScrollFrame>,
    )
    expect(getByTestId('scroll').tagName).toBe('DIV')
    rerender(
      <WikiScrollFrame as="article" data-testid="scroll">
        x
      </WikiScrollFrame>,
    )
    expect(getByTestId('scroll').tagName).toBe('ARTICLE')
  })

  it('forwards the scroll element to the caller ref (the shell scroll-memory handle)', () => {
    const ref = createRef<HTMLElement>()
    render(
      <WikiScrollFrame scrollRef={ref} data-testid="scroll">
        x
      </WikiScrollFrame>,
    )
    expect(ref.current).not.toBeNull()
    expect(ref.current?.getAttribute('data-testid')).toBe('scroll')
  })

  it('paints NO overlay over its content — the fade is a mask, not a wash (ux-run2 myth-9dcfq)', () => {
    // The old paper-gradient overlays washed --bg over content — wrong tone on a
    // --surface-grounded panel (the char-fork "gray smudge") and a full glossary
    // row at intermediate alpha (reads as DISABLED). A mask on the scroll element
    // reveals the TRUE ground behind, whatever it is.
    const { container } = render(<WikiScrollFrame>x</WikiScrollFrame>)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)
  })

  it('carries no edge mask while the content fits (nothing to announce)', () => {
    const { getByTestId } = render(<WikiScrollFrame data-testid="scroll">x</WikiScrollFrame>)
    expect(getByTestId('scroll').getAttribute('data-scroll-edges')).toBeNull()
  })

  it('masks only the overflowed edge, and clears once the reader reaches it', () => {
    const { getByTestId } = render(<WikiScrollFrame data-testid="scroll">x</WikiScrollFrame>)
    const el = getByTestId('scroll')
    // Unscrolled with content below the fold → bottom edge only.
    setScrollMetrics(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 500 })
    expect(el.getAttribute('data-scroll-edges')).toBe('bottom')
    // Mid-scroll → both edges announce.
    setScrollMetrics(el, { scrollTop: 200, clientHeight: 100, scrollHeight: 500 })
    expect(el.getAttribute('data-scroll-edges')).toBe('top bottom')
    // Scrolled to the end → the bottom fade clears; only the top remains.
    setScrollMetrics(el, { scrollTop: 400, clientHeight: 100, scrollHeight: 500 })
    expect(el.getAttribute('data-scroll-edges')).toBe('top')
  })

  it('keeps the fade band shallower than one text line — a full row can never ghost (ux-run2 myth-9dcfq)', () => {
    // The wiki's tightest row type is the glossary term at text-sm (14px) with
    // its default ~1.43 leading → ~20px lines. The band must stay strictly under
    // that: it may graze the SLICED edge of the line the fold cuts, never span a
    // whole line (the old 32px band digested entire tappable rows).
    expect(FADE_BAND_PX).toBeLessThan(20)
  })
})
