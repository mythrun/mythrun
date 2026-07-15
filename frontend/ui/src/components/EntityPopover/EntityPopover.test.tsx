import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type { EntityCard, EntityPopoverProps } from '@mythrun/client-core/contract'
import { EntityPopover } from './EntityPopover.tsx'

// EntityPopover — the terse one-tap knowledge card wrapping an entity trigger.
// It composes the shipped `Popover` (focus trap/return + Esc + ARIA are ITS job,
// covered by Popover.test — here we test the CARD content + the controlled seam).
// Content is terse (spec §6): the entity name (serif) + a standalone, LABELLED
// type glyph (monochrome shape carries the type; `typeLabel` is its accessible
// name) + the one-line lead + one "open in wiki" action. Nothing else.
//
// EntityMention (Task 9) is the real trigger and is built concurrently; per the
// task brief we use a neutral <button> trigger here — the pairing is wired in
// Task 11.
const trigger = <button type="button">Elenya-mention</button>

const npcCard: EntityCard = {
  entityId: 'e1',
  name: 'Elenya',
  glyph: 'npc',
  leadLine: 'The archmage who keeps the lamps of Highreach lit.',
}
const factionCardNoLead: EntityCard = {
  entityId: 'e2',
  name: 'The Ashen Hand',
  glyph: 'faction',
  leadLine: '',
}
const otherCard: EntityCard = {
  entityId: 'e3',
  name: 'A guttering torch',
  glyph: 'other',
  leadLine: 'It sputters against the dark.',
}

function renderPopover(overrides: Partial<EntityPopoverProps> = {}) {
  const props: EntityPopoverProps = {
    card: npcCard,
    open: true,
    onOpenChange: vi.fn(),
    onOpenInWiki: vi.fn(),
    label: 'popover.entity_card',
    typeLabel: 'entity.type.npc',
    openInWikiLabel: 'action.open_in_wiki',
    children: trigger,
    ...overrides,
  }
  const utils = render(<EntityPopover {...props}>{props.children}</EntityPopover>)
  return { props, ...utils }
}

describe('EntityPopover', () => {
  it('renders the entity name and a labelled standalone type glyph when open', async () => {
    renderPopover()
    expect(await screen.findByRole('heading', { name: 'Elenya' })).toBeInTheDocument()
    // The type glyph is STANDALONE — labelled via typeLabel (role=img), not
    // decorative — so it is the sole type signal, announced to AT by name.
    expect(screen.getByRole('img', { name: 'entity.type.npc' })).toBeInTheDocument()
  })

  it('renders the one-line lead when the card carries one', async () => {
    renderPopover()
    await screen.findByRole('heading', { name: 'Elenya' })
    expect(screen.getByTestId('entity-popover-lead')).toHaveTextContent(
      'The archmage who keeps the lamps of Highreach lit.',
    )
  })

  it('omits the lead line when the card has no known facts (empty leadLine)', async () => {
    renderPopover({ card: factionCardNoLead, typeLabel: 'entity.type.faction' })
    // The name + action still render; the lead line is absent entirely.
    expect(await screen.findByRole('heading', { name: 'The Ashen Hand' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'action.open_in_wiki' })).toBeInTheDocument()
    expect(screen.queryByTestId('entity-popover-lead')).not.toBeInTheDocument()
  })

  it('renders NO type glyph for the neutral "other" kind', async () => {
    renderPopover({ card: otherCard, typeLabel: 'entity.type.other' })
    await screen.findByRole('heading', { name: 'A guttering torch' })
    // 'other' maps to no glyph — the header is just the name.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('fires onOpenInWiki when the open-in-wiki action is chosen', async () => {
    const user = userEvent.setup()
    const { props } = renderPopover()
    await user.click(await screen.findByRole('button', { name: 'action.open_in_wiki' }))
    expect(props.onOpenInWiki).toHaveBeenCalledTimes(1)
  })

  it('is controlled — closed when open=false, and the trigger requests open via onOpenChange', async () => {
    const user = userEvent.setup()
    const { props } = renderPopover({ open: false })
    // Content is hidden while open=false…
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // …and activating the trigger reports the next state, never mutating locally.
    await user.click(screen.getByText('Elenya-mention'))
    expect(props.onOpenChange).toHaveBeenCalledWith(true)
  })

  it('names the dialog-role content from label and forwards data-testid', async () => {
    renderPopover({ 'data-testid': 'entity-pop' })
    const panel = await screen.findByTestId('entity-pop')
    expect(panel).toHaveAccessibleName('popover.entity_card')
    expect(panel).toHaveAttribute('role', 'dialog')
  })

  it('has no axe violations when open', async () => {
    renderPopover()
    await screen.findByRole('heading', { name: 'Elenya' })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
