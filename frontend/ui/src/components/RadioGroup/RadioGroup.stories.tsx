import type { Meta, StoryObj } from '@storybook/react-vite'
import { RadioGroup, Radio } from './RadioGroup.tsx'

// RadioGroup / Radio — wraps the unstyled Radix `RadioGroup` primitive (arrow-key
// roving selection within the group, ARIA `radiogroup`/`radio`, a hidden form
// input), styled 100% with our tokens. The `RadioGroup` owns the value/name/
// keyboard model; each `Radio` is an item rendered inside it. The neutral
// `onChange(value)` hands the consumer the selected string (§9).
//
// Flat 1-bit (§3) with one exception: the radio dot is CIRCULAR (a radio must
// read as a radio). The ring is the same 1px `--border-strong` boundary, the
// selected dot is the `--accent` token, and the focus ring is the shared
// theme-aware `outline-accent`.
//
// State matrix (§6): default (one selected) · disabled (group or single option).
// Content/i18n: each option's `label` is an i18n key the consumer resolves.

const meta: Meta<typeof RadioGroup> = {
  title: 'Controls/RadioGroup',
  component: RadioGroup,
  tags: ['autodocs'],
  argTypes: {
    disabled: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof RadioGroup>

// Default — a three-option group with one selected via `defaultValue`.
export const Default: Story = {
  args: { defaultValue: 'neutral' },
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="good" label="align.good" />
      <Radio value="neutral" label="align.neutral" />
      <Radio value="evil" label="align.evil" />
    </RadioGroup>
  ),
}

// Selected — the `--accent` dot marks the chosen option.
export const Selected: Story = {
  args: { defaultValue: 'good' },
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="good" label="align.good" />
      <Radio value="neutral" label="align.neutral" />
      <Radio value="evil" label="align.evil" />
    </RadioGroup>
  ),
}

// Disabled group — every option is non-interactive + muted (a11y-exempt for
// contrast).
export const Disabled: Story = {
  args: { defaultValue: 'good', disabled: true },
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="good" label="align.good" />
      <Radio value="neutral" label="align.neutral" />
      <Radio value="evil" label="align.evil" />
    </RadioGroup>
  ),
}

// One disabled option — the rest of the group stays interactive.
export const SingleDisabledOption: Story = {
  name: 'Single disabled option',
  args: { defaultValue: 'good' },
  render: (args) => (
    <RadioGroup {...args}>
      <Radio value="good" label="align.good" />
      <Radio value="neutral" label="align.neutral" />
      <Radio value="evil" label="align.evil" disabled />
    </RadioGroup>
  ),
}
