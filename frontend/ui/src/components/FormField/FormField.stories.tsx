import type { Meta, StoryObj } from '@storybook/react-vite'
import { FormField } from './FormField.tsx'
import { Input } from '../Input/Input.tsx'
import { Select } from '../Select/Select.tsx'
import { TextArea } from '../TextArea/TextArea.tsx'

// FormField — the labelling / helper / error / required-state wrapper for a
// single form control. It supplies the associated <Label>, optional helper +
// error text, and required/invalid state, all wired to the control for
// accessibility (the control gets its accessible NAME from the label, and its
// helper/error ids via the neutral `describedBy` relationship). The error is
// BOTH programmatically associated AND announced (role="alert").
//
// Content/i18n: `label` / `description` / `error` are i18n KEYS the consumer
// resolves; the wrapped control's own content props are keys too.

const RACES = [
  { value: 'human', label: 'race.human' },
  { value: 'elf', label: 'race.elf' },
  { value: 'dwarf', label: 'race.dwarf' },
]

const meta: Meta<typeof FormField> = {
  title: 'Forms/FormField',
  component: FormField,
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text' },
    description: { control: 'text' },
    error: { control: 'text' },
    required: { control: 'boolean' },
    invalid: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof FormField>

// FormField + Input — the baseline: a label associated to the input.
export const WithInput: Story = {
  name: 'With Input',
  args: { label: 'field.character_name' },
  render: (args) => (
    <FormField {...args}>
      <Input placeholder="field.character_name" />
    </FormField>
  ),
}

// Required — the label carries the marker; the input is natively required.
export const Required: Story = {
  args: { label: 'field.email', required: true },
  render: (args) => (
    <FormField {...args}>
      <Input type="email" placeholder="field.email" />
    </FormField>
  ),
}

// With helper — the description text is muted and wired into aria-describedby.
export const WithHelper: Story = {
  name: 'With helper',
  args: { label: 'field.password', description: 'field.password.help' },
  render: (args) => (
    <FormField {...args}>
      <Input type="password" placeholder="field.password" />
    </FormField>
  ),
}

// With error — the field is invalid (danger border + aria-invalid), and the
// error text is in the danger token, announced via role="alert", and described.
export const WithError: Story = {
  name: 'With error',
  args: { label: 'field.email', error: 'field.email.error' },
  render: (args) => (
    <FormField {...args}>
      <Input type="email" defaultValue="not-an-email" />
    </FormField>
  ),
}

// Helper AND error — both regions present; both ids flow into aria-describedby.
export const HelperAndError: Story = {
  name: 'Helper and error',
  args: { label: 'field.email', description: 'field.email.help', error: 'field.email.error' },
  render: (args) => (
    <FormField {...args}>
      <Input type="email" defaultValue="not-an-email" />
    </FormField>
  ),
}

// FormField + Select — a different control shape behind the SAME contract: the
// label binds to the Select trigger, helper/error wire the same way.
export const WithSelect: Story = {
  name: 'With Select',
  args: { label: 'field.race', description: 'field.race.help' },
  render: (args) => (
    <FormField {...args}>
      <Select options={RACES} placeholder="field.race.placeholder" />
    </FormField>
  ),
}

// Disabled with a hint — a disabled control is otherwise a dead end with no
// explanation, so the helper carries the WHY (e.g. "unlocks once you pick a
// class"). The hint stays VISIBLE under the inert field. (a11y note: native
// `disabled` removes the field from the tab order, so the describedBy hint isn't
// announceable on focus — when the reason must reach AT on an inert field, prefer
// readOnly / aria-disabled so it stays focusable. Here the hint is sighted
// context.)
export const DisabledWithHint: Story = {
  name: 'Disabled (with hint)',
  args: { label: 'field.patron_deity', description: 'field.patron_deity.locked_help' },
  render: (args) => (
    <FormField {...args}>
      <Input disabled placeholder="field.patron_deity" />
    </FormField>
  ),
}

// FormField + TextArea — a multi-line control takes the same label / helper /
// error wiring; the helper gives a longer-form field the context it needs.
export const WithTextArea: Story = {
  name: 'With TextArea',
  args: { label: 'field.backstory', description: 'field.backstory.help' },
  render: (args) => (
    <FormField {...args}>
      <TextArea rows={3} placeholder="field.backstory" />
    </FormField>
  ),
}
