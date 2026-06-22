import type { Meta, StoryObj } from '@storybook/react-vite'
import { Switch } from './Switch.tsx'

// Switch — wraps the unstyled Radix `Switch` primitive (Space-to-toggle, ARIA
// `role="switch"`/`aria-checked`, a hidden form input), styled 100% with our
// tokens. A Switch is a BINARY on/off that takes effect immediately (vs a
// Checkbox, which stages a form value). The neutral `onChange(checked)` hands the
// consumer the new boolean (§9).
//
// Flat 1-bit (§3): 0px radius everywhere — a RECTANGULAR track + a RECTANGULAR
// thumb (no pill exception). off → `--surface` track + `--border-strong` edge; on
// → `--accent` fill (token-swap). The thumb SLIDES —
// but the position IS the state (a control affordance, not decorative motion);
// the slide is `transform`-only at `--duration-fast`/`--ease-out`, and the global
// `prefers-reduced-motion` reset neutralises it (the color swap still conveys
// state, so motion is never the sole signal).
//
// State matrix (§6): off · on · disabled. The optional inline `label` is a
// convenience; full field labelling is FormField's job. Content/i18n: `label` is
// an i18n key the consumer resolves.

const meta: Meta<typeof Switch> = {
  title: 'Controls/Switch',
  component: Switch,
  tags: ['autodocs'],
  argTypes: {
    checked: { control: 'boolean' },
    disabled: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Switch>

// Default (off) — the track is `--surface` with a `--border-strong` edge.
export const Default: Story = {
  args: { id: 'sw-default', label: 'setting.email_notifications' },
}

// On — the `--accent` fill + the thumb slid to the end.
export const On: Story = {
  args: { id: 'sw-on', label: 'setting.email_notifications', checked: true },
}

// Disabled — non-interactive + muted token swap (a11y-exempt for contrast).
export const Disabled: Story = {
  args: { id: 'sw-disabled', label: 'setting.email_notifications', disabled: true },
}

// Disabled + on — both the muted treatment and the on position.
export const DisabledOn: Story = {
  name: 'Disabled (on)',
  args: { id: 'sw-disabled-on', label: 'setting.email_notifications', checked: true, disabled: true },
}
