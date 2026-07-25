import { describe, expect, it } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { FADE_BAND_PX, WikiScrollFrame } from './WikiScrollFrame.tsx'

// WikiScrollFrame is the wiki's reading scroll region with an overflow affordance
// (myth-lcvv2): a persistent scrollbar + edge fades that announce a definition
// running past the panel edge. Since ux-run2 (myth-9dcfq) the fade is a CSS MASK
// on the scroll element itself — never a paint overlay. Since ux-run3 (myth-02zhi)
// the band spans one full reading line and the scroll element carries a one-line
// bottom padding floor: a line reads as fully shown or fully hidden, never a
// razor slice, and the last line never sits flush at the fold.

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

  it('spans one full reading line — the fold-cut line dissolves, never slices (ux-run3 override of myth-9dcfq)', () => {
    // The wiki's reading prose is 16px at 1.6 leading → 25.6px lines. Run-3
    // OVERRODE the earlier sub-line clamp (12px): a band shallower than a line
    // can only graze the sliced edge, which the run-3 critics saw as either an
    // invisible cue (the chargen rails' "no fade, hard clip") or a razor slice
    // through descenders (the reveal pane) — verified against the live DOM,
    // where the 12px mask WAS applied yet read as no affordance at all. The
    // band must swallow the whole cut line before the razor edge…
    expect(FADE_BAND_PX).toBeGreaterThanOrEqual(Math.ceil(16 * 1.6))
    // …while staying under the 32px wash that ghosted whole tappable rows
    // (myth-9dcfq's original failure). The padding floor below — not an even
    // deeper band — carries the never-flush duty at end-of-scroll.
    expect(FADE_BAND_PX).toBeLessThan(32)
  })

  it('carries a one-line bottom padding floor so the last line never sits flush at the fold (ux-run3)', () => {
    // At end-of-scroll the bottom fade clears by design — the floor is what
    // keeps the final line a full line-height clear of the border there. It
    // rides inline off the SAME constant as the band (one source of truth; a
    // consumer contentClassName can never defeat it).
    const { getByTestId } = render(<WikiScrollFrame data-testid="scroll">x</WikiScrollFrame>)
    expect(getByTestId('scroll').style.paddingBottom).toBe(`${String(FADE_BAND_PX)}px`)
  })
})
