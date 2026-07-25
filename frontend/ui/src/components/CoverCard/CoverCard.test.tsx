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
    // body region (cover, seam, body) → [top content, foot, reserved cta line]
    expect(withFoot.getByTestId('withfoot').children[2]?.children).toHaveLength(3)

    const noFoot = render(
      <CoverCard data-testid="nofoot" cover={<span />}>
        <span />
      </CoverCard>,
    )
    // body region → the top content + the reserved cta line, no foot wrapper
    expect(noFoot.getByTestId('nofoot').children[2]?.children).toHaveLength(2)
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

  it('reserves an empty cta line when none is given — the 4-zone fixed footer (myth-7jc1h)', () => {
    // Run 3: cards with and without a cta ended at different foot offsets, so
    // member seals sat at three heights across one grid. The cta ZONE is now
    // always the body's last line — an aria-hidden non-breaking space when the
    // card has no action — so zones 3 and 4 hold one fixed offset on every card.
    const { queryByTestId, getByTestId } = render(
      <CoverCard data-testid="cc" cover={<span />}>
        b
      </CoverCard>,
    )
    expect(queryByTestId('cover-card-cta')).toBeNull()
    const reserve = getByTestId('cc').children[2]?.lastElementChild
    expect(reserve?.textContent).toBe('\u00A0')
    expect(reserve?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders the cta tone tiers as weight — loud/quiet/whisper, never an opacity dim (myth-7jc1h)', () => {
    const { getByTestId, rerender } = render(
      <CoverCard data-testid="cc" cover={<span />} cta="Continue session →" ctaTone="loud">
        b
      </CoverCard>,
    )
    expect(getByTestId('cover-card-cta').classList.contains('font-semibold')).toBe(true)
    rerender(
      <CoverCard data-testid="cc" cover={<span />} cta="Resume →">
        b
      </CoverCard>,
    )
    // Default tier is quiet — the ordinary medium-weight action line.
    expect(getByTestId('cover-card-cta').classList.contains('font-medium')).toBe(true)
    rerender(
      <CoverCard data-testid="cc" cover={<span />} cta="Author your character →" ctaTone="whisper">
        b
      </CoverCard>,
    )
    const whisper = getByTestId('cover-card-cta')
    expect(whisper.classList.contains('font-normal')).toBe(true)
    // Still the accent register — the tier is weight, not a sub-AA dim.
    expect(whisper.classList.contains('text-accent-fg')).toBe(true)
    expect(whisper.className).not.toContain('opacity')
  })

  it('promotes the premier object: 2px edge + a thin accent rule above the cta (myth-7jc1h)', () => {
    const { getByTestId } = render(
      <CoverCard data-testid="cc" cover={<span />} cta="Continue session →" ctaTone="loud" promoted>
        b
      </CoverCard>,
    )
    const el = getByTestId('cc')
    expect(el.classList.contains('border-2')).toBe(true)
    const rule = getByTestId('cover-card-promoted-rule')
    expect(rule.classList.contains('bg-accent')).toBe(true)
    // The rule sits directly above the cta line — the promoted imprint.
    expect(rule.nextElementSibling).toBe(getByTestId('cover-card-cta'))
  })

  it('renders no accent rule when not promoted', () => {
    const { queryByTestId } = render(
      <CoverCard cover={<span />} cta="Resume →">
        b
      </CoverCard>,
    )
    expect(queryByTestId('cover-card-promoted-rule')).toBeNull()
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
