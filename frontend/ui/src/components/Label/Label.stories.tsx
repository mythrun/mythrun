import type { Meta, StoryObj } from '@storybook/react-vite'
import { Label } from './Label.tsx'
import { Input } from '../Input/Input.tsx'

// Label — the form-control label. A REAL native <label htmlFor> in the
// `ui-label` type role (mono, uppercase, tracked). It binds to a control by id
// (FormField owns that wiring in real use; these stories bind a bare Input).
//
// `required` renders a meaning-carrying marker: a visible ember asterisk
// (aria-hidden) PLUS a screen-reader "(required)" word — never color alone.
// Content/i18n: the label text is an i18n key the consumer resolves.

const meta: Meta<typeof Label> = {
  title: 'Forms/Label',
  component: Label,
  tags: ['autodocs'],
  // The required-marker SR word is a required prop (shell-owned i18n) — supply it
  // once at the meta level so every `{...args}` specimen inherits it.
  args: { requiredLabel: '(required)' },
  argTypes: {
    required: { control: 'boolean' },
    htmlFor: { control: 'text' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Label>

export const Default: Story = {
  args: { htmlFor: 'lbl-default', children: 'field.character_name' },
  render: (args) => (
    <div className="flex flex-col gap-[var(--space-1)] w-80">
      <Label {...args} />
      <Input id="lbl-default" placeholder="field.character_name" />
    </div>
  ),
}

// Required — the marker (visible asterisk + SR-only "(required)").
export const Required: Story = {
  args: { htmlFor: 'lbl-required', required: true, children: 'field.email' },
  render: (args) => (
    <div className="flex flex-col gap-[var(--space-1)] w-80">
      <Label {...args} />
      <Input id="lbl-required" type="email" required placeholder="field.email" />
    </div>
  ),
}
