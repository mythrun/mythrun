import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { EntityPopoverProps } from '@mythrun/client-core/contract'
import { EntityPopover } from './EntityPopover.tsx'
import { Text } from '../Text/Text.tsx'

// EntityPopover — the terse one-tap knowledge card that opens off a recognized
// entity mention in settled DM prose (spec §6). It composes the shipped `Popover`
// (focus trap/return, Esc, `role="dialog"` ARIA). Content is TERSE: the entity
// name (serif) + a STANDALONE monochrome type glyph (shape carries the type;
// `typeLabel` is its accessible name — no entity-type COLOR) + the one-line lead
// (omitted when the entity has no known facts) + one "open in wiki" action. The
// rich knowledge lives one tap away in the wiki tab.
//
// EntityMention (Task 9) is the real trigger and is built concurrently; these
// specimens use a neutral inline underlined <button> so the pairing (Task 11)
// stays out of scope here. Controlled: the specimen owns `open`/`onOpenChange`.

// A stateful specimen — EntityPopover is controlled, so the trigger lives in real
// prose and toggles local open state, the way the settled DM row will drive it.
function PopoverSpecimen({ initialOpen = false, ...props }: EntityPopoverProps & { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <Text role="prose-body" as="p">
      [placeholder for settled DM prose leading up to the name]{' '}
      <EntityPopover {...props} open={open} onOpenChange={setOpen}>
        <button type="button" className="font-body underline underline-offset-2">
          {props.card.name}
        </button>
      </EntityPopover>{' '}
      [placeholder for the prose that continues past the mention].
    </Text>
  )
}

const meta: Meta<typeof EntityPopover> = {
  title: 'Session/EntityPopover',
  component: EntityPopover,
  tags: ['autodocs'],
  args: {
    label: 'session.entity_popover.label',
    typeLabel: 'session.entity.type.npc',
    openInWikiLabel: 'session.entity_popover.open_in_wiki',
    onOpenInWiki: () => undefined,
    card: {
      entityId: 'e1',
      name: 'Elenya',
      glyph: 'npc',
      leadLine: 'The archmage who keeps the lamps of Highreach lit.',
    },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof EntityPopover>

// An npc mention with a lead line. The play() opens it in real Chromium and
// asserts the card's end state (the named heading + the open-in-wiki action) —
// proving the controlled trigger seam, not just "the page rendered".
export const Npc: Story = {
  render: (args) => <PopoverSpecimen {...args} />,
  play: async () => {
    const body = within(document.body)
    await userEvent.click(body.getByRole('button', { name: 'Elenya' }))
    await expect(await body.findByRole('heading', { name: 'Elenya' })).toBeInTheDocument()
    await expect(
      body.getByRole('button', { name: 'session.entity_popover.open_in_wiki' }),
    ).toBeInTheDocument()
  },
}

// A faction with NO known facts — the lead line is omitted; the card is just the
// name + the labelled banner glyph + the action.
export const FactionNoLead: Story = {
  args: {
    typeLabel: 'session.entity.type.faction',
    card: { entityId: 'e2', name: 'The Ashen Hand', glyph: 'faction', leadLine: '' },
  },
  render: (args) => <PopoverSpecimen {...args} />,
}

// A location mention — the pin glyph.
export const Location: Story = {
  args: {
    typeLabel: 'session.entity.type.location',
    card: {
      entityId: 'e3',
      name: 'Highreach',
      glyph: 'location',
      leadLine: 'A lamp-lit city terraced up the cliff face.',
    },
  },
  render: (args) => <PopoverSpecimen {...args} />,
}

// Open at rest — the catalogue specimen for the card itself. The overflow gate
// measures the portalled Radix content (`[data-radix-popper-content-wrapper]`) at
// 375/1280 so the terse card never overflows a phone-width viewport.
export const Open: Story = {
  parameters: { overflowGate: { openSelector: '[data-radix-popper-content-wrapper]' } },
  render: (args) => <PopoverSpecimen {...args} initialOpen />,
}
