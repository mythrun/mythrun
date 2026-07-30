import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NoticeStrip } from './NoticeStrip.tsx'

// NoticeStrip — the sitewide outage notice (outage-resilience design §4.2).
// The load-bearing pin is the ANNOUNCEMENT MECHANIC, not attribute presence:
// a `role="status"` node inserted into the DOM already populated is unreliably
// announced, so the host must be mounted (and in the accessibility tree)
// BEFORE any message exists, and the ok→degraded transition must land the text
// inside that SAME node. Collapse is content + edge classes dropping — never
// display:none / unmount, which would evict the live region.

// Class-token set for real set-difference assertions (the StickyBar pattern):
// the two states must differ ONLY by the populated edge/inset classes.
function classSet(el: Element): Set<string> {
  return new Set(el.className.split(/\s+/).filter(Boolean))
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => !b.has(token))
}

const MESSAGE = 'frame.outageNotice resolved line'

describe('NoticeStrip', () => {
  it('mounts the role="status" host while collapsed — the live region exists before any message', () => {
    render(<NoticeStrip message={null} />)
    const host = screen.getByRole('status')
    expect(host).toBeInTheDocument()
    expect(host.textContent).toBe('')
  })

  it('ok→degraded: the message lands inside the SAME pre-mounted host node', () => {
    const view = render(<NoticeStrip message={null} />)
    const host = screen.getByRole('status')
    view.rerender(<NoticeStrip message={MESSAGE} />)
    // Node identity is the announcement mechanic: the text arrives INSIDE the
    // long-lived live region; a remounted host would be unreliably announced.
    expect(screen.getByRole('status')).toBe(host)
    expect(host.textContent).toBe(MESSAGE)
  })

  it('degraded→ok: null empties + collapses the strip but the host stays mounted, never display:none', () => {
    const view = render(<NoticeStrip message={MESSAGE} />)
    const host = screen.getByRole('status')
    view.rerender(<NoticeStrip message={null} />)
    expect(screen.getByRole('status')).toBe(host)
    expect(host.textContent).toBe('')
    // No display:none (and no `hidden` attribute) — either would remove the
    // live region from the accessibility tree between outages.
    expect(classSet(host).has('hidden')).toBe(false)
    expect(host.hasAttribute('hidden')).toBe(false)
  })

  it('an empty string collapses like null (no populated edge on a blank line)', () => {
    render(<NoticeStrip message="" />)
    const host = screen.getByRole('status')
    expect(host.textContent).toBe('')
    expect(classSet(host).has('border-t')).toBe(false)
  })

  it('populated register: full-width quiet prose in the chrome type role over the paper surface', () => {
    render(<NoticeStrip message={MESSAGE} />)
    const tokens = classSet(screen.getByRole('status'))
    // chrome type role (the frame's one utility size) — 14px mono, 0.01em tracking.
    expect(tokens.has('font-ui')).toBe(true)
    expect(tokens.has('text-sm')).toBe(true)
    expect(tokens.has('tracking-[0.01em]')).toBe(true)
    // Quiet: the secondary ink facet, never a status/accent color.
    expect(tokens.has('text-ink-secondary')).toBe(true)
    // Full-width strip on the frame's content ground, hairline top edge,
    // gutter-aligned with the sticky bar's --space-6.
    expect(tokens.has('w-full')).toBe(true)
    expect(tokens.has('bg-surface')).toBe(true)
    expect(tokens.has('border-t')).toBe(true)
    expect(tokens.has('border-border')).toBe(true)
    expect(tokens.has('px-[var(--space-6)]')).toBe(true)
  })

  it('collapsed differs from populated ONLY by the edge + inset classes (zero-footprint collapse)', () => {
    render(
      <>
        <NoticeStrip message={null} data-testid="strip-rest" />
        <NoticeStrip message={MESSAGE} data-testid="strip-degraded" />
      </>,
    )
    const rest = classSet(screen.getByTestId('strip-rest'))
    const degraded = classSet(screen.getByTestId('strip-degraded'))
    expect(diff(rest, degraded)).toEqual([])
    expect(diff(degraded, rest)).toEqual([
      'border-t',
      'border-border',
      'px-[var(--space-6)]',
      'py-[var(--space-2)]',
    ])
  })

  it('carries no icons, dots, chips, or dismiss affordance — the state is prose', () => {
    render(<NoticeStrip message={MESSAGE} />)
    const host = screen.getByRole('status')
    expect(host.querySelector('svg')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
  })
})
