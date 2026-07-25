import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { CoverCard } from './CoverCard.tsx'

// jsdom does not compute Tailwind styles, so the token CLASSES + the DOM
// structure the impl applies are the observable contract.

describe('CoverCard', () => {
  it('renders the cover, the body children, and the foot slot', () => {
    const { getByTestId } = render(
      <CoverCard
        data-testid="cc"
        cover={<span data-testid="cover">C</span>}
        foot={<span data-testid="foot">F</span>}
      >
        <span data-testid="body">B</span>
      </CoverCard>,
    )
    expect(getByTestId('cc').tagName).toBe('DIV')
    expect(getByTestId('cover')).toBeDefined()
    expect(getByTestId('body')).toBeDefined()
    expect(getByTestId('foot')).toBeDefined()
  })

  it('is a flat 3:2 portrait card — square, strong edge, paper surface, clipped, flex column', () => {
    const { getByTestId } = render(
      <CoverCard data-testid="cc" cover={<span />}>
        b
      </CoverCard>,
    )
    const el = getByTestId('cc')
    expect(el.classList.contains('aspect-[2/3]')).toBe(true)
    expect(el.classList.contains('border-border-strong')).toBe(true)
    expect(el.classList.contains('bg-surface')).toBe(true)
    expect(el.classList.contains('rounded-none')).toBe(true)
    expect(el.classList.contains('overflow-hidden')).toBe(true)
    expect(el.classList.contains('flex')).toBe(true)
    expect(el.classList.contains('flex-col')).toBe(true)
  })

  it('separates the cover from the body with an ink seam (paper-900)', () => {
    const { getByRole } = render(<CoverCard cover={<span />}>b</CoverCard>)
    expect(getByRole('separator').classList.contains('bg-paper-900')).toBe(true)
  })

  it('lays out cover → ink seam → body region in source order', () => {
    const { getByTestId } = render(
      <CoverCard data-testid="cc" cover={<span />}>
        b
      </CoverCard>,
    )
    const el = getByTestId('cc')
    expect(el.children).toHaveLength(3)
    expect(el.children[1]?.getAttribute('role')).toBe('separator')
  })

  it('takes a fixed pixel width when given, and fills the container otherwise', () => {
    const { getByTestId, rerender } = render(
      <CoverCard data-testid="cc" width={230} cover={<span />}>
        b
      </CoverCard>,
    )
    expect(getByTestId('cc').style.width).toBe('230px')
    expect(getByTestId('cc').classList.contains('w-full')).toBe(false)
    rerender(
      <CoverCard data-testid="cc" cover={<span />}>
        b
      </CoverCard>,
    )
    expect(getByTestId('cc').style.width).toBe('')
    expect(getByTestId('cc').classList.contains('w-full')).toBe(true)
  })

  it('pins a foot region below the body content when a foot is given, and omits it otherwise', () => {
    const withFoot = render(
      <CoverCard data-testid="withfoot" cover={<span />} foot={<span data-testid="foot" />}>
        <span />
      </CoverCard>,
    )
    // body region (cover, seam, body) → [top content, foot]
    expect(withFoot.getByTestId('withfoot').children[2]?.children).toHaveLength(2)

    const noFoot = render(
      <CoverCard data-testid="nofoot" cover={<span />}>
        <span />
      </CoverCard>,
    )
    // body region → just the top content, no foot wrapper
    expect(noFoot.getByTestId('nofoot').children[2]?.children).toHaveLength(1)
  })

  it('anchors the foot to the card BASE — the narrative block absorbs the slack (myth-rhvkt)', () => {
    // Run 2: with the body top-aligned, equal-height cards ended at different
    // text heights ("bottoms don't share a baseline") over dead bottom air. The
    // children wrapper GROWS so the imprint (foot + cta) sits on the card's
    // base like a paperback colophon; the air lives between narrative and
    // imprint as breathing room.
    const { getByTestId } = render(
      <CoverCard data-testid="cc" cover={<span />} foot={<span />}>
        <span />
      </CoverCard>,
    )
    const body = getByTestId('cc').children[2]
    expect(body?.children[0]?.classList.contains('grow')).toBe(true)
  })

  it('renders an optional cta line as the LAST body line, in the accent action register', () => {
    const { getByTestId } = render(
      <CoverCard data-testid="cc" cover={<span />} foot={<span data-testid="foot" />} cta="Continue session →">
        <span />
      </CoverCard>,
    )
    const cta = getByTestId('cover-card-cta')
    expect(cta.textContent).toBe('Continue session →')
    // The accent action register — mono caption, accent ink (the DS action-label
    // treatment, cf. PartyRoster/InvitePanel panel labels).
    expect(cta.classList.contains('text-accent-fg')).toBe(true)
    expect(cta.classList.contains('font-ui')).toBe(true)
    expect(cta.classList.contains('uppercase')).toBe(true)
    // It sits BELOW the foot — the last line of the body region.
    const body = getByTestId('cc').children[2]
    expect(body?.lastElementChild).toBe(cta)
  })

  it('omits the cta line when none is given', () => {
    const { queryByTestId } = render(
      <CoverCard cover={<span />}>
        b
      </CoverCard>,
    )
    expect(queryByTestId('cover-card-cta')).toBeNull()
  })

  it('forwards its ref to the underlying div', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <CoverCard ref={ref} cover={<span />}>
        b
      </CoverCard>,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <CoverCard cover={<span />} foot={<span>foot</span>}>
        body
      </CoverCard>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
