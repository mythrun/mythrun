import type { Meta, StoryObj } from '@storybook/react-vite'
import { within, userEvent } from 'storybook/test'
import { Select } from './Select.tsx'
import { FormField } from '../FormField/FormField.tsx'

// Select — the single-select dropdown. Wraps the unstyled Radix `Select`
// primitive (focus management, type-ahead, ArrowKey nav, ARIA listbox, a
// portalled content layer), styled 100% with our tokens. The TRIGGER is shaped
// like an Input (flat 1-bit: 0px radius, 1px `--border-strong`, mono `font-ui`,
// theme-aware focus ring); the CONTENT sits on the `--surface-raised` popover
// tier with a `--border-strong` edge (depth via border, not shadow). The neutral
// `onChange(value)` hands the consumer the selected string (§9).
//
// State matrix (§6): default (placeholder) · selected · open (highlighted item +
// `check` on the selected) · disabled · invalid (danger border + `aria-invalid`).
// Sizes sm/md/lg track `--control-*`.
//
// Labelling is FormField's job in the real app. Content/i18n: each option's
// `label` (and `placeholder`) is an i18n key the consumer resolves.

const OPTIONS = [
  { value: 'human', label: 'race.human' },
  { value: 'elf', label: 'race.elf' },
  { value: 'dwarf', label: 'race.dwarf' },
  { value: 'halfling', label: 'race.halfling' },
]

const meta: Meta<typeof Select> = {
  title: 'Controls/Select',
  component: Select,
  tags: ['autodocs'],
  args: { options: OPTIONS, placeholder: 'field.choose_race' },
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    invalid: { control: 'boolean' },
    disabled: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Select>

// Default — nothing selected, the placeholder (an i18n key) shows muted.
export const Default: Story = {}

// Selected — a controlled value renders that option's label in the trigger.
export const Selected: Story = {
  args: { defaultValue: 'elf' },
}

// The size axis — sm/md/lg trigger height (32/40/48px).
export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col gap-[var(--space-3)] w-80">
      <Select {...args} size="sm" />
      <Select {...args} size="md" />
      <Select {...args} size="lg" />
    </div>
  ),
}

// Invalid — danger border token + a danger focus ring; the impl also sets
// `aria-invalid` on the trigger so the state reaches assistive tech.
export const Invalid: Story = {
  args: { invalid: true },
}

// Disabled — a non-interactive trigger + muted token swap (a11y-exempt for
// contrast).
export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'human' },
}

// Open — the play clicks the trigger so the catalogue shows the OPEN listbox, and
// the overflow gate measures the portalled `[role="listbox"]` at 375/1280 (a
// closed trigger would pass trivially without exercising the overlay). Wrapped in
// FormField so the trigger has an accessible name (labelling is FormField's job,
// not the bare Select's — see FormField/With Select).
//
// a11y carve-out: a Radix Select is MODAL — opening it aria-hides the background
// (incl. the trigger) while focus moves into the listbox. axe's `aria-hidden-focus`
// rule flags the still-tabbable background trigger, a by-design transient state
// (Radix Dialog/Popover suppress the same flag; Select never got the fix). We
// disable ONLY that one rule here — every other axe rule stays enforced.
export const Open: Story = {
  parameters: {
    overflowGate: { openSelector: '[role="listbox"]' },
    a11y: { config: { rules: [{ id: 'aria-hidden-focus', enabled: false }] } },
  },
  render: (args) => (
    <FormField label="field.choose_race">
      <Select {...args} />
    </FormField>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('combobox'))
  },
}
