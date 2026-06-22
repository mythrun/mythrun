import type { Meta, StoryObj } from '@storybook/react-vite'
import { Checkbox } from './Checkbox.tsx'

// Checkbox — wraps the unstyled Radix `Checkbox` primitive (Space-to-toggle,
// ARIA `aria-checked` incl. the `mixed` tri-state, a hidden form input), styled
// 100% with our tokens. Flat 1-bit (§3): a square `rounded-none` box with a 1px
// `--border-strong` edge; checked/indeterminate swap to the `--accent` fill with
// the `paper-50` glyph (the same on-accent pairing Button uses). The neutral
// `onChange(checked)` hands the consumer the new boolean OR `'indeterminate'`
// (§9) — indeterminate is a VALUE, not a separate flag (Radix's model).
//
// State matrix (§6): default · checked · indeterminate (minus glyph) · disabled ·
// invalid (danger border + `aria-invalid`). The optional inline `label` is a
// convenience; full field labelling (helper/error/required) is FormField's job.
// Content/i18n: `label` is an i18n key the consumer resolves.

const meta: Meta<typeof Checkbox> = {
  title: 'Controls/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  argTypes: {
    checked: { control: 'inline-radio', options: [false, true, 'indeterminate'] },
    disabled: { control: 'boolean' },
    invalid: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Checkbox>

// Default — unchecked, with an inline label (an i18n key).
export const Default: Story = {
  args: { id: 'cb-default', label: 'consent.newsletter' },
}

// Checked — the accent fill + the `check` glyph.
export const Checked: Story = {
  args: { id: 'cb-checked', label: 'consent.newsletter', checked: true },
}

// Indeterminate — the third (mixed) state; renders the `minus` glyph and reports
// `aria-checked="mixed"`. Expressed as `checked="indeterminate"`.
export const Indeterminate: Story = {
  args: { id: 'cb-mixed', label: 'select.all', checked: 'indeterminate' },
}

// Disabled — non-interactive + muted token swap (a11y-exempt for contrast).
export const Disabled: Story = {
  args: { id: 'cb-disabled', label: 'consent.newsletter', disabled: true },
}

// Invalid — danger border + `aria-invalid` (e.g. an unchecked required consent).
export const Invalid: Story = {
  args: { id: 'cb-invalid', label: 'consent.required', invalid: true },
}
