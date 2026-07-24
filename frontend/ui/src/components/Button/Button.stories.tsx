import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button.tsx'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'
import { Icon } from '../Icon/Icon.tsx'

// Button — the text/label action control. A REAL <button> (native keyboard
// activation + a11y), flat 1-bit (0px radius), with TOKEN-SWAP states (no
// shadows/transforms): hover/active shift the fill token; the theme-aware focus
// ring (tab to it to see the 2px accent outline) is a11y-critical; disabled
// swaps to muted tokens; loading shows a Spinner beside the still-visible label
// and sets aria-busy.
//
// Variants: primary (accent fill — the page's main action), secondary (bordered
// neutral), ghost (low-emphasis text). Sizes: sm/md/lg — distinct on three axes:
// height 32/40/48 (--control-*), padding 12/16/24, font 12/14/16. On a COARSE
// (touch) pointer the interactive target floors at ≥44px (WCAG 2.5.5); a fine
// (mouse) pointer keeps the distinct visual heights.
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

// The size axis — sm/md/lg, distinct on height (32/40/48), padding, and font
// (12/14/16). On a touch (coarse) pointer each floors at a ≥44px tap target.
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
// token swap. primary: accent → accent-hover → accent-active. secondary/ghost:
// surface → surface-hover → surface-active (a neutral paper step per state). No
// transform/shadow.
export const HoverAndActive: Story = {
  name: 'Hover · Active (pointer states — hover/press to see the token swap)',
  render: () => (
    <div className="flex flex-wrap items-center gap-[var(--space-4)]">
      <Button variant="primary">Hover / press me</Button>
      <Button variant="secondary">Hover / press me</Button>
      <Button variant="ghost">Hover / press me</Button>
    </div>
  ),
}

// Disabled — a PER-VARIANT muted treatment (a11y-exempt for contrast), NOT one
// blanket grey (MYT-0xao0). A disabled PRIMARY stays THE primary as a muted ember
// GHOST (edge + label, unfilled), so an awaiting-input CTA reads as "not yet
// available", never broken — it fills solid the moment it's enabled (compare the
// top pair). secondary/ghost mute to a tertiary-ink neutral. Non-interactive across
// all variants.
export const Disabled: Story = {
  render: () => (
    <Stack gap={4}>
      {/* The primary progression the fix is about: awaiting (ghost ember) →
          available (solid ember fill). The disabled one still reads as the primary. */}
      <div className="flex items-center gap-[var(--space-4)]">
        <Button variant="primary" disabled>
          Begin
        </Button>
        <Button variant="primary">Begin</Button>
      </div>
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
    </Stack>
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

// Leading icon — the native `icon` slot (the contained-button-with-icon convention):
// a ~18-20px decorative mark/glyph before the label with the canonical 8px gap. This
// is how the sign-in provider buttons carry the Google / Discord marks — pass the mark
// to `icon`, never hand-place it as a child (which wouldn't get the slot's spacing).
export const WithIcon: Story = {
  name: 'With a leading icon',
  render: () => (
    <div className="flex flex-col items-stretch gap-[var(--space-3)]">
      <Button variant="secondary" icon={<Icon name="arrow-right" decorative />}>
        Continue with Provider
      </Button>
      <Button variant="primary" icon={<Icon name="plus" decorative />}>
        New campaign
      </Button>
    </div>
  ),
}

export const HoldsSizeBesideShrinkingText: Story = {
  name: 'Holds size beside shrinking text',
  render: () => (
    <div className="max-w-[260px]">
      <Stack direction="row" align="center" justify="between" gap={3}>
        <Text role="ui-label" truncate>
          A long identity label that must give way to the action
        </Text>
        <Button>Settings</Button>
      </Stack>
    </div>
  ),
}
