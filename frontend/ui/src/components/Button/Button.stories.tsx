import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button.tsx'

// Button — the text/label action control. A REAL <button> (native keyboard
// activation + a11y), flat 1-bit (0px radius), with TOKEN-SWAP states (no
// shadows/transforms): hover/active shift the fill token; the theme-aware focus
// ring (tab to it to see the 2px accent outline) is a11y-critical; disabled
// swaps to muted tokens; loading shows a Spinner beside the still-visible label
// and sets aria-busy.
//
// Variants: primary (accent fill — the page's main action), secondary (bordered
// neutral), ghost (low-emphasis text). Sizes: sm/md/lg (32/40/48px VISUAL height
// — the interactive hit-target is always ≥44px, padded under the visual box).
//
// State matrix (§6): default · hover (doc) · active (doc) · focus (tab to it) ·
// disabled · loading. hover/active are pointer states — see the Variants matrix
// note; the rest have dedicated stories below.
// Content/i18n: children + any accessible name are i18n-resolved by the consumer.

const meta: Meta<typeof Button> = {
  title: 'Controls/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
    onPress: { action: 'pressed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Button>

export const Default: Story = {
  args: { children: 'Save the world' },
}

// The three emphasis tiers, side by side.
export const Variants: Story = {
  name: 'Variants (primary · secondary · ghost)',
  render: () => (
    <div className="flex items-center gap-[var(--space-4)] bg-bg p-[var(--space-4)]">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
    </div>
  ),
}

// The size axis — sm/md/lg visual height (the tap area stays ≥44px on each).
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
}

// Focus — tab to the button to reveal the theme-aware 2px accent ring (the
// a11y-critical state). Documented here; focus is shown live on keyboard focus.
export const Focus: Story = {
  name: 'Focus (tab to reveal the accent ring)',
  args: { children: 'Tab to me', variant: 'primary' },
}

// Hover / active are POINTER states — hover or press the button to see the fill
// token swap (accent → accent-hover → accent-active). No transform/shadow.
export const HoverAndActive: Story = {
  name: 'Hover · Active (pointer states — hover/press to see the token swap)',
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <Button variant="primary">Hover / press me</Button>
      <Button variant="secondary">Hover / press me</Button>
      <Button variant="ghost">Hover / press me</Button>
    </div>
  ),
}

// Disabled — the native disabled attribute + muted token swap (a11y-exempt for
// contrast). Non-interactive across all variants.
export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <Button variant="primary" disabled>
        Primary
      </Button>
      <Button variant="secondary" disabled>
        Secondary
      </Button>
      <Button variant="ghost" disabled>
        Ghost
      </Button>
    </div>
  ),
}

// Loading — a Spinner sits beside the still-visible label (width never
// collapses), aria-busy is set, and the control is non-interactive.
export const Loading: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <Button variant="primary" loading>
        Saving
      </Button>
      <Button variant="secondary" loading>
        Saving
      </Button>
      <Button variant="ghost" loading>
        Saving
      </Button>
    </div>
  ),
}
