import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tooltip, TooltipProvider } from './Tooltip.tsx'
import { IconButton } from '../IconButton/IconButton.tsx'
import { Button } from '../Button/Button.tsx'

// Tooltip — a small SUPPLEMENTARY-info bubble that appears on hover AND keyboard
// focus. Wraps the unstyled Radix `Tooltip` primitive, styled 100% with our
// tokens. Flat 1-bit: a token bubble on the `--surface-raised` tier, 1px
// `--border-strong` edge, 0px radius, no shadow. Layered at `--z-tooltip` (1500).
//
// ⚠️ SUPPLEMENTARY ONLY. A tooltip MUST NOT be the sole label for, or sole access
// to, a control: it does NOT appear on touch, and (as `aria-describedby`, not
// `aria-labelledby`) it is NOT a reliable accessible NAME. Always give the trigger
// its OWN label — an IconButton's `label`, a Button's text — and use the tooltip
// for the EXTRA hint. The `WrongUsage_DoNot` story documents the anti-pattern.
//
// Needs a `TooltipProvider` ancestor (mount ONCE at the app root) for the shared
// open-delay timing. These stories wrap each example in one.

const meta: Meta<typeof Tooltip> = {
  title: 'Overlays/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider delayDuration={200}>
        <div className="p-[var(--space-9)]">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: { content: 'tip.save_changes' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Tooltip>

// CORRECT — the trigger (an IconButton) ALREADY has its own accessible name
// (`label`); the tooltip supplements it with the extra hint. This is the only
// supported usage.
export const Default: Story = {
  args: {
    trigger: <IconButton icon="check" label="action.save" />,
  },
}

// On a text Button — the visible label is the name; the tooltip adds context.
export const OnTextButton: Story = {
  args: {
    trigger: <Button variant="secondary">action.save</Button>,
    content: 'tip.save_keyboard_hint',
  },
}

// Sides — the bubble can prefer a different side; Radix flips it when there's no room.
export const Sides: Story = {
  render: (args) => (
    <div className="flex gap-[var(--space-6)]">
      <Tooltip {...args} side="top" trigger={<IconButton icon="arrow-left" label="side.top" />} />
      <Tooltip {...args} side="bottom" trigger={<IconButton icon="arrow-right" label="side.bottom" />} />
    </div>
  ),
}
