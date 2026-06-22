import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconButton } from './IconButton.tsx'

// IconButton — the icon-only action control. A REAL <button aria-label={label}>
// (native keyboard + a11y): the BUTTON carries the accessible name (label is
// REQUIRED), and the inner glyph is DECORATIVE — so the control is never
// nameless (the #1 icon-button a11y bug). Same flat 1-bit corners, token-swap
// state matrix, and theme-aware focus ring as Button.
//
// Geometry: an icon-only control has no text to pad the tap area, so the ≥44px
// hit-target is pinned on BOTH axes at EVERY size — even `sm` (32px visual) has
// a 44px square tap area.
//
// State matrix (§6): default · hover (doc) · active (doc) · focus (tab to it) ·
// disabled · loading (Spinner replaces the glyph). Variants: primary / secondary
// / ghost. Content/i18n: `label` is an i18n key the consumer resolves.

const meta: Meta<typeof IconButton> = {
  title: 'Controls/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
    label: { control: 'text' },
    onPress: { action: 'pressed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof IconButton>

export const Default: Story = {
  args: { icon: 'close', label: 'Close' },
}

// The three emphasis tiers.
export const Variants: Story = {
  name: 'Variants (primary · secondary · ghost)',
  render: () => (
    <div className="flex items-center gap-[var(--space-4)] bg-bg p-[var(--space-4)]">
      <IconButton icon="close" label="Close" variant="primary" />
      <IconButton icon="close" label="Close" variant="secondary" />
      <IconButton icon="close" label="Close" variant="ghost" />
    </div>
  ),
}

// The size axis — sm/md/lg visual box (the tap area stays a ≥44px square on each).
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <IconButton icon="plus" label="Add" size="sm" />
      <IconButton icon="plus" label="Add" size="md" />
      <IconButton icon="plus" label="Add" size="lg" />
    </div>
  ),
}

// Focus — tab to the button to reveal the theme-aware 2px accent ring.
export const Focus: Story = {
  name: 'Focus (tab to reveal the accent ring)',
  args: { icon: 'search', label: 'Search', variant: 'primary' },
}

// Hover / active are POINTER states — hover/press to see the fill token swap.
export const HoverAndActive: Story = {
  name: 'Hover · Active (pointer states — hover/press to see the token swap)',
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <IconButton icon="menu" label="Menu" variant="primary" />
      <IconButton icon="menu" label="Menu" variant="secondary" />
      <IconButton icon="menu" label="Menu" variant="ghost" />
    </div>
  ),
}

// Disabled — native disabled + muted token swap, non-interactive.
export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <IconButton icon="close" label="Close" variant="primary" disabled />
      <IconButton icon="close" label="Close" variant="secondary" disabled />
      <IconButton icon="close" label="Close" variant="ghost" disabled />
    </div>
  ),
}

// Loading — the Spinner replaces the glyph, aria-busy is set, non-interactive.
export const Loading: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <IconButton icon="check" label="Saving" variant="primary" loading />
      <IconButton icon="check" label="Saving" variant="secondary" loading />
      <IconButton icon="check" label="Saving" variant="ghost" loading />
    </div>
  ),
}
