import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button.tsx'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'
import { Icon } from '../Icon/Icon.tsx'

// Button — the text/label action control. A REAL <button> (native keyboard
// activation + a11y), flat 1-bit (0px radius), with TOKEN-SWAP states (no
// shadows/transforms): hover/active shift the fill token; the theme-aware focus
// ring (tab to it to see the 2px accent outline) is a11y-critical; busy shows a
// Spinner beside the label (swapped to `busyLabel` when given) and sets
// aria-busy (`loading` is the legacy alias).
//
// Variants: primary (accent fill — the page's main action), secondary (bordered
// neutral), ghost (low-emphasis text). Sizes: sm/md/lg — distinct on three axes:
// height 32/40/48 (--control-*), padding 12/16/24, font 12/14/16. On a COARSE
// (touch) pointer the interactive target floors at ≥44px (WCAG 2.5.5); a fine
// (mouse) pointer keeps the distinct visual heights.
//
// Non-interactive invariant (myth-skbzw): a disabled OR busy button never
// carries the accent — every variant mutes to ~45% ink (tertiary-ink token)
// keeping only its geometry, and an enabled primary SNAPS to the full accent
// fill. "Accent" and "pressable now" are synonymous, by construction.
//
// State matrix (§6): default · hover (doc) · active (doc) · focus (tab to it) ·
// disabled · busy. hover/active are pointer states — see the Variants matrix
// note; the rest have dedicated stories below (incl. the full variant × state
// grid).
// Content/i18n: children + any accessible name are i18n-resolved by the consumer.

const meta: Meta<typeof Button> = {
  title: 'Controls/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    busy: { control: 'boolean' },
    busyLabel: { control: 'text' },
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

// Disabled — ONE muted stood-down family with per-variant geometry (a11y-exempt
// for contrast), and NO accent anywhere (myth-skbzw — run 2 found the old
// accent-carrying disabled primary indistinguishable from enabled: "a player who
// has waited ten minutes will click it and get nothing"). The accent fill is the
// exclusive mark of an enabled primary; it SNAPS in the moment the control
// becomes available (compare the top pair). Non-interactive across all variants,
// plain default cursor.
export const Disabled: Story = {
  render: () => (
    <Stack gap={4}>
      {/* The primary progression the fix is about: not yet available (muted ink
          on paper) → available (solid accent fill, the reward for having decided). */}
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

// Busy — a Spinner beside the label (swapped to `busyLabel` when given, so
// "Save" reads "Saving" while the system works), aria-busy set, and the SAME
// muted stood-down treatment as disabled: while working, the accent drops; it
// snaps back when the control re-enables. `loading` is the legacy alias.
export const Busy: Story = {
  render: () => (
    <div className="flex items-center gap-[var(--space-4)]">
      <Button variant="primary" busy busyLabel="Saving">
        Save
      </Button>
      <Button variant="secondary" busy>
        Saving
      </Button>
      <Button variant="ghost" busy>
        Saving
      </Button>
    </div>
  ),
}

// The full variant × state grid — every emphasis tier in every static state
// (enabled / disabled / busy), side by side. The reading the matrix should give:
// exactly ONE cell wears the accent fill per row-set (the enabled primary);
// every non-interactive cell shares the muted ~45%-ink family, differing only
// in its variant geometry (bordered paper / bordered neutral / bare label).
export const VariantStateMatrix: Story = {
  name: 'Variant × state matrix',
  render: () => (
    <Stack gap={4}>
      {(['primary', 'secondary', 'ghost'] as const).map((variant) => (
        <div key={variant} className="flex items-center gap-[var(--space-4)]">
          <Button variant={variant}>Enabled</Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} busy busyLabel="Working">
            Begin
          </Button>
        </div>
      ))}
    </Stack>
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

// flush="start" (ux-run3 myth-4jbmr): a ghost Back seated on a text column
// bleeds its own start padding so the glyph sits flush on the content grid the
// headings share — hit area unchanged. The hairline marks the grid edge.
export const FlushStart: Story = {
  name: 'Flush start (grid-seated ghost)',
  render: () => (
    <div className="flex flex-col gap-[var(--space-2)] border-l border-border-strong pl-0">
      <Button variant="ghost" size="sm" flush="start" icon={<Icon name="arrow-left" decorative />}>
        Back
      </Button>
      <Text role="ui-label">A heading seated on the same grid edge</Text>
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
