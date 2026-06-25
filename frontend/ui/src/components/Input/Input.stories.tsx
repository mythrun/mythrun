import type { Meta, StoryObj } from '@storybook/react-vite'
import { Input } from './Input.tsx'
import { FormField } from '../FormField/FormField.tsx'

// Input — the single-line text control. A REAL native <input> (form control +
// a11y), flat 1-bit (0px radius, 1px `--border-strong` interactive boundary,
// `bg-surface`/`text-ink`, mono `font-ui` — inputs are data). The neutral
// `onChange(value)` hands the consumer a plain string (§9). The theme-aware
// focus ring (tab to it) is a11y-critical.
//
// State matrix (§6): default · focus (tab to it) · invalid (danger border +
// `aria-invalid` + danger focus ring) · disabled · read-only. Sizes sm/md/lg
// track `--control-*` (32/40/48px).
//
// Labelling is FormField's job in the real app, so the single-control state
// swatches are shown in their FormField context — that supplies the associated
// <Label> (the control's accessible NAME) the now-ENFORCED a11y gate requires.
// The placeholder-only specimens (Sizes / With placeholder) carry their name via
// the native `placeholder` and stay bare. Content/i18n: `label` / `placeholder`
// are i18n keys the consumer resolves.

const meta: Meta<typeof Input> = {
  title: 'Controls/Input',
  component: Input,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    type: { control: 'inline-radio', options: ['text', 'email', 'password', 'search'] },
    invalid: { control: 'boolean' },
    disabled: { control: 'boolean' },
    readOnly: { control: 'boolean' },
    required: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Input>

export const Default: Story = {
  args: { defaultValue: 'Mira Stonehollow' },
  render: (args) => (
    <FormField label="field.character_name">
      <Input {...args} />
    </FormField>
  ),
}

// The size axis — sm/md/lg visual height (32/40/48px).
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-[var(--space-3)] w-80">
      <Input size="sm" placeholder="control.sm" />
      <Input size="md" placeholder="control.md" />
      <Input size="lg" placeholder="control.lg" />
    </div>
  ),
}

// Invalid — the danger border token + a danger-colored focus ring; the impl
// also sets `aria-invalid` so the state reaches assistive tech. `invalid` rides
// on the FormField (authoritative), which forwards it to the wrapped Input.
export const Invalid: Story = {
  args: { defaultValue: 'not-an-email' },
  render: (args) => (
    <FormField label="field.email" invalid>
      <Input {...args} />
    </FormField>
  ),
}

// Disabled — the native disabled attribute + muted token swap (a11y-exempt for
// contrast). Non-interactive.
export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Can't edit this" },
  render: (args) => (
    <FormField label="field.character_name">
      <Input {...args} />
    </FormField>
  ),
}

// Read-only — value visible but not editable (native readOnly). Distinct from
// disabled: still focusable / selectable.
export const ReadOnly: Story = {
  name: 'Read-only',
  args: { readOnly: true, defaultValue: 'Locked value' },
  render: (args) => (
    <FormField label="field.character_name">
      <Input {...args} />
    </FormField>
  ),
}

// Placeholder — an i18n key the consumer resolves (shown muted).
export const WithPlaceholder: Story = {
  name: 'With placeholder',
  args: { placeholder: 'field.your_name' },
}
