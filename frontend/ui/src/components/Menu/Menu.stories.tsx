import type { Meta, StoryObj } from '@storybook/react-vite'
import { within, userEvent } from 'storybook/test'
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

// Open — the play activates the trigger so the catalogue shows the menu content,
// and the overflow gate measures the portalled `[role="menu"]` list at 375/1280 (a
// closed-trigger-only story would pass trivially without exercising the overlay).
//
// a11y carve-out: a Radix DropdownMenu is MODAL — opening it aria-hides the
// background (incl. the trigger) while Radix moves focus INTO the menu. axe's
// `aria-hidden-focus` rule flags the still-tabbable background trigger, but that is
// a by-design transient state (Radix Dialog/Popover suppress the same flag; the
// equivalent fix never landed for DropdownMenu). We disable ONLY that one rule for
// this open specimen — every other axe rule stays enforced.
export const Open: Story = {
  parameters: {
    overflowGate: { openSelector: '[role="menu"]' },
    a11y: { config: { rules: [{ id: 'aria-hidden-focus', enabled: false }] } },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'))
  },
}

// With a header row — a non-interactive identity line atop the item list (the
// mobile frame menu's "signed in as" row). Rendered as a Radix Label: visible
// text, not a menuitem, never keyboard-highlighted. Same open-specimen
// parameters as `Open` (overflow gate on the portal; the documented
// `aria-hidden-focus` carve-out).
export const WithHeaderRow: Story = {
  args: {
    items: [
      { header: true, label: 'menu.identity' },
      { value: 'settings', label: 'menu.settings' },
      { value: 'logout', label: 'menu.logout' },
    ],
  },
  parameters: {
    overflowGate: { openSelector: '[role="menu"]' },
    a11y: { config: { rules: [{ id: 'aria-hidden-focus', enabled: false }] } },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'))
  },
}

// Dark theme, open, with the first item keyboard-highlighted — the specimen for
// the raised-tier highlight token: dark `--surface-hover` (paper-700) equals the
// raised popover surface, so items highlight via `--surface-raised-hover`
// (paper-600) to stay visible. Story-level `globals` locks the theme toolbar to
// dark (the preview decorator reads `globals.theme`).
export const DarkOpenHighlight: Story = {
  globals: { theme: 'dark' },
  parameters: {
    overflowGate: { openSelector: '[role="menu"]' },
    a11y: { config: { rules: [{ id: 'aria-hidden-focus', enabled: false }] } },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'))
    await userEvent.keyboard('{ArrowDown}')
  },
}
