import type { Meta, StoryObj } from '@storybook/react-vite'
import { Popover } from './Popover.tsx'
import { Button } from '../Button/Button.tsx'
import { Text } from '../Text/Text.tsx'

// Popover — anchored, portalled content that can hold INTERACTIVE elements
// (buttons, links, a form). Wraps the unstyled Radix `Popover` primitive (focus
// move into the content + back to the trigger on close, Esc-to-close, ARIA
// wiring), styled 100% with our tokens. The CONTENT sits on the `--surface-raised`
// popover tier with a 1px `--border-strong` edge (flat 1-bit: 0px radius, no
// shadow — depth via the border + surface tier). Layered at `--z-popover` (1100).
//
// NOT a Tooltip: a popover opens on click/keyboard activation and can contain
// actions — it is the primitive for the entity-card popover (spec §12). The
// `label` is the required accessible name (Radix gives the content `role="dialog"`,
// which must be named). Open/close is the neutral `onOpenChange(open)` (§9).

const meta: Meta<typeof Popover> = {
  title: 'Overlays/Popover',
  component: Popover,
  tags: ['autodocs'],
  args: {
    label: 'popover.entity_card',
    trigger: <Button variant="secondary">action.show_details</Button>,
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Popover>

// Default — opens below the trigger with arbitrary (interactive) content.
export const Default: Story = {
  args: {
    children: (
      <>
        <Text>[placeholder for entity name]</Text>
        <Text>[placeholder for entity summary copy]</Text>
        <Button variant="ghost" size="sm">
          action.open_full_page
        </Button>
      </>
    ),
  },
}

// Side — the content can prefer a different side; Radix flips it when there's no room.
export const Sides: Story = {
  render: (args) => (
    <div className="flex gap-[var(--space-6)] p-[var(--space-9)]">
      <Popover {...args} side="top" trigger={<Button variant="secondary">side.top</Button>}>
        <Text>[placeholder for popover copy]</Text>
      </Popover>
      <Popover {...args} side="right" trigger={<Button variant="secondary">side.right</Button>}>
        <Text>[placeholder for popover copy]</Text>
      </Popover>
      <Popover {...args} side="bottom" trigger={<Button variant="secondary">side.bottom</Button>}>
        <Text>[placeholder for popover copy]</Text>
      </Popover>
    </div>
  ),
}

// Open by default — shows the open state in the catalogue without interaction.
export const OpenByDefault: Story = {
  args: {
    defaultOpen: true,
    children: <Text>[placeholder for popover copy]</Text>,
  },
}
