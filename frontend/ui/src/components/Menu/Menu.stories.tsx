import type { Meta, StoryObj } from '@storybook/react-vite'
import { Menu } from './Menu.tsx'
import { Button } from '../Button/Button.tsx'
import { IconButton } from '../IconButton/IconButton.tsx'

// Menu / DropdownMenu — a trigger + a list of selectable items. Wraps the unstyled
// Radix `DropdownMenu` primitive (open on Enter/Space/ArrowDown, roving ArrowKey
// nav, Enter to select, Esc-to-close with focus-RETURN to the trigger, a portalled
// content layer, ARIA `menu`/`menuitem` wiring), styled 100% with our tokens. Flat
// 1-bit: the content sits on the `--surface-raised` tier, 1px `--border-strong`
// edge, 0px radius, no shadow; items highlight via the `--surface-hover` token-swap.
// Layered at `--z-dropdown` (1000).
//
// Selection is the neutral `onSelect(value)` (§9); items support `disabled`. Each
// item's `label` is an i18n key; `value` is the stable action id.

const ITEMS = [
  { value: 'rename', label: 'menu.rename' },
  { value: 'duplicate', label: 'menu.duplicate' },
  { value: 'delete', label: 'menu.delete' },
]

const meta: Meta<typeof Menu> = {
  title: 'Overlays/Menu',
  component: Menu,
  tags: ['autodocs'],
  args: {
    items: ITEMS,
    trigger: <Button variant="secondary">action.actions</Button>,
  },
  argTypes: { onSelect: { action: 'selected' } },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Menu>

// Default — opens below a Button trigger; ArrowKeys navigate, Enter selects.
export const Default: Story = {}

// From an IconButton trigger (a labelled icon-only control).
export const FromIconButton: Story = {
  args: { trigger: <IconButton icon="menu" label="action.open_menu" variant="ghost" /> },
}

// With a disabled item — present but non-selectable.
export const WithDisabledItem: Story = {
  args: {
    items: [
      { value: 'rename', label: 'menu.rename' },
      { value: 'duplicate', label: 'menu.duplicate', disabled: true },
      { value: 'delete', label: 'menu.delete' },
    ],
  },
}
