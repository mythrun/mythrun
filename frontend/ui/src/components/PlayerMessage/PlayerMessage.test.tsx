import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { PlayerMessage } from './PlayerMessage.tsx'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Behavior-tested with RTL. jsdom does not compute Tailwind styles, so the token
// CLASS the impl applies is the observable contract (mirrors Text.test.tsx). The
// register split IS the product: the humans at the table render in the mono
// (--font-ui) role — the mechanical counterpart to the DM's narrative serif.

const BASE = {
  displayName: 'Miklos',
  characterName: 'Kessa Vurm',
  text: 'I push the door open and step through.',
  pending: false,
}

describe('PlayerMessage', () => {
  it('renders the message text', () => {
    const { getByText } = render(<PlayerMessage {...BASE} />)
    expect(getByText(BASE.text)).toBeInTheDocument()
  })

  it('renders both the character name and the display name', () => {
    const { getByText } = render(<PlayerMessage {...BASE} />)
    expect(getByText('Kessa Vurm')).toBeInTheDocument()
    expect(getByText('Miklos')).toBeInTheDocument()
  })

  it('renders the message text in the mono data role', () => {
    const { getByText } = render(<PlayerMessage {...BASE} />)
    expect(getByText(BASE.text)).toHaveClass(...TYPE_ROLE_CLASS.data.split(' '))
  })

  it('renders the names in the mono register (ui-caption / meta roles)', () => {
    const { getByText } = render(<PlayerMessage {...BASE} />)
    expect(getByText('Kessa Vurm')).toHaveClass(...TYPE_ROLE_CLASS['ui-caption'].split(' '))
    expect(getByText('Miklos')).toHaveClass(...TYPE_ROLE_CLASS.meta.split(' '))
  })

  it('sets the mono font on the row root', () => {
    const { container } = render(<PlayerMessage {...BASE} />)
    expect(container.firstElementChild).toHaveClass('font-ui')
  })

  it('carries a distinct paper tint (the quiet sibling band, NOT the DM surface)', () => {
    const { container } = render(<PlayerMessage {...BASE} />)
    const root = container.firstElementChild
    // The player row is the quiet sibling tint; DmMessage owns `bg-surface`, so
    // the two registers stay distinct by tint as well as by face (UX §2).
    expect(root).toHaveClass('bg-surface-hover')
    expect(root).not.toHaveClass('bg-surface')
  })

  it('conveys pending via a SOLID quieter ink token (not opacity) plus aria-busy', () => {
    const { container, getByText } = render(<PlayerMessage {...BASE} pending />)
    const root = container.firstElementChild
    // The quiet treatment is a solid AA-safe token on every text element; the
    // message body and the character name both dim to ink-secondary.
    expect(getByText(BASE.text)).toHaveClass('text-ink-secondary')
    expect(getByText('Kessa Vurm')).toHaveClass('text-ink-secondary')
    expect(root).toHaveAttribute('aria-busy', 'true')
  })

  it('NEVER uses opacity dimming (the memorialized sub-AA sweep-failure pattern)', () => {
    // Opacity composites text toward the band and drops the muted line under 4.5:1
    // (CharacterLoadingBeat). Guard it: no opacity utility in either state.
    const pendingTree = render(<PlayerMessage {...BASE} pending />)
    expect(pendingTree.container.querySelector('.opacity-60')).toBeNull()
    expect(pendingTree.container.querySelector('[class*="opacity-"]')).toBeNull()
    const confirmedTree = render(<PlayerMessage {...BASE} />)
    expect(confirmedTree.container.querySelector('[class*="opacity-"]')).toBeNull()
  })

  it('uses the normal (full-ink) roles when confirmed, and is not busy', () => {
    const { container, getByText } = render(<PlayerMessage {...BASE} />)
    const root = container.firstElementChild
    // Confirmed message text carries no muted override — it reads at full ink.
    expect(getByText(BASE.text)).not.toHaveClass('text-ink-secondary')
    expect(getByText('Kessa Vurm')).not.toHaveClass('text-ink-secondary')
    expect(root).not.toHaveAttribute('aria-busy')
  })

  it('shows only the display name when the character name is empty (unfinalized character)', () => {
    const { getByText, queryByText, container } = render(<PlayerMessage {...BASE} characterName="" />)
    expect(getByText('Miklos')).toBeInTheDocument()
    // No empty label element leaks in for the absent character — and no orphaned
    // separator either.
    expect(queryByText('Kessa Vurm')).not.toBeInTheDocument()
    expect(container.textContent).not.toContain('·')
  })

  // ── myth-ydu35: the mono voice stays READABLE typewriting ───────────────────
  it('caps the mono measure (~75ch) and opens the leading on the message body', () => {
    const { getByText } = render(<PlayerMessage {...BASE} />)
    const body = getByText(BASE.text)
    expect(body).toHaveClass('max-w-[75ch]')
    expect(body).toHaveClass('leading-[1.7]')
  })

  it('separates character from account with the label·value interpunct (never one apparent full name)', () => {
    const { container, getByText } = render(<PlayerMessage {...BASE} />)
    // "Kessa Vurm · Miklos" — the separator is aria-hidden typographic notation.
    const sep = container.querySelector('[data-testid="player-attribution-sep"]')
    expect(sep).not.toBeNull()
    expect(sep).toHaveTextContent('·')
    expect(sep).toHaveAttribute('aria-hidden', 'true')
    expect(getByText('Kessa Vurm')).toBeInTheDocument()
    expect(getByText('Miklos')).toBeInTheDocument()
  })

  it('renders no avatar image and no circle (square register, no bubble-and-avatar idiom)', () => {
    const { container } = render(<PlayerMessage {...BASE} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('forwards its ref to the row root', () => {
    const ref = createRef<HTMLDivElement>()
    render(<PlayerMessage ref={ref} {...BASE} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no axe violations (confirmed)', async () => {
    const { container } = render(<PlayerMessage {...BASE} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (pending)', async () => {
    const { container } = render(<PlayerMessage {...BASE} pending />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
