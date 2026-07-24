import type { Meta, StoryObj } from '@storybook/react-vite'
import { TextArea } from './TextArea.tsx'
import { FormField } from '../FormField/FormField.tsx'

// TextArea — the multi-line text control. A REAL native <textarea> (form
// control + a11y), the multi-line sibling of Input: same flat 1-bit register
// (0px radius, `--border-strong`, `bg-surface`/`text-ink`), same neutral
// `onChange(value)` (§9), same theme-aware focus ring. Height comes from `rows`;
// only vertical resize is allowed. The `face` variant picks the type face: `ui`
// (default) mono `font-ui` for DATA, `prose` serif `font-body` + the ember caret
// for USER-AUTHORED PROSE (the one face player writing wears; myth-xs9tc).
//
// State matrix (§6): default · focus (tab to it) · invalid (danger border +
// `aria-invalid` + danger focus ring) · disabled · read-only. Sizes sm/md/lg set
// the per-control min-height from `--control-*`.
//
// Labelling is FormField's job in the real app, so the single-control state
// swatches are shown in their FormField context — that supplies the associated
// <Label> (the control's accessible NAME) the now-ENFORCED a11y gate requires.
// The placeholder-only specimens (Sizes / With placeholder) and the Auto-grow
// composer (own bound <label>) carry their name another way and stay bare.
// Content/i18n: `label` / `placeholder` are i18n keys the consumer resolves.

const meta: Meta<typeof TextArea> = {
  title: 'Controls/TextArea',
  component: TextArea,
  tags: ['autodocs'],
  argTypes: {
    face: { control: 'inline-radio', options: ['ui', 'prose'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    rows: { control: 'number' },
    autoSize: { control: 'boolean' },
    minRows: { control: 'number' },
    maxRows: { control: 'number' },
    invalid: { control: 'boolean' },
    disabled: { control: 'boolean' },
    readOnly: { control: 'boolean' },
    required: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof TextArea>

export const Default: Story = {
  args: { rows: 4, defaultValue: 'The road to Stonehollow winds through the fog.' },
  render: (args) => (
    <FormField requiredLabel="(required)" label="field.session_notes">
      <TextArea {...args} />
    </FormField>
  ),
}

// The size axis — sm/md/lg set the per-control min-height (32/40/48px).
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-[var(--space-3)] w-80">
      <TextArea size="sm" rows={2} placeholder="control.sm" />
      <TextArea size="md" rows={3} placeholder="control.md" />
      <TextArea size="lg" rows={4} placeholder="control.lg" />
    </div>
  ),
}

// Invalid — the danger border token + a danger-colored focus ring; the impl
// also sets `aria-invalid` so the state reaches assistive tech. `invalid` rides
// on the FormField (authoritative), which forwards it to the wrapped TextArea.
export const Invalid: Story = {
  args: { rows: 4, defaultValue: 'Too short.' },
  render: (args) => (
    <FormField requiredLabel="(required)" label="field.session_notes" invalid>
      <TextArea {...args} />
    </FormField>
  ),
}

// Disabled — the native disabled attribute + muted token swap (a11y-exempt for
// contrast). Non-interactive.
export const Disabled: Story = {
  args: { disabled: true, rows: 4, defaultValue: "Can't edit this." },
  render: (args) => (
    <FormField requiredLabel="(required)" label="field.session_notes">
      <TextArea {...args} />
    </FormField>
  ),
}

// Read-only — value visible but not editable (native readOnly). Still focusable.
export const ReadOnly: Story = {
  name: 'Read-only',
  args: { readOnly: true, rows: 4, defaultValue: 'Locked narration.' },
  render: (args) => (
    <FormField requiredLabel="(required)" label="field.session_notes">
      <TextArea {...args} />
    </FormField>
  ),
}

// Placeholder — an i18n key the consumer resolves (shown muted).
export const WithPlaceholder: Story = {
  name: 'With placeholder',
  args: { rows: 4, placeholder: 'field.session_notes' },
}

// ProseFace — the serif user-authored-prose face (`face="prose"`). This is the one
// voice a player's own writing wears: the world/character concept fields and the
// play composer share it, so player prose never reads as a mono code stub
// (myth-xs9tc). Serif `font-body` + the branded ember caret; the paper field,
// border, and focus ring are the shared control chrome.
export const ProseFace: Story = {
  name: 'Prose face (user-authored writing)',
  render: () => (
    <div className="flex flex-col gap-[var(--space-1)] w-96 max-w-full">
      <label htmlFor="prose-field" className="font-body text-lg font-semibold text-ink">
        Describe the world you want to play in.
      </label>
      <TextArea
        id="prose-field"
        face="prose"
        size="lg"
        autoSize
        minRows={4}
        maxRows={12}
        defaultValue="A rain-soaked port city where the tide never fully goes out, and the harbourmaster owes a debt to something under the water."
      />
    </div>
  ),
}

// AutoGrow — the chat-composer pattern. With `autoSize`, the textarea starts at
// `minRows` and grows as you type newlines (Shift+Enter) or long prose wraps,
// then caps at `maxRows` and scrolls. Mechanism: CSS `field-sizing: content`
// (Tailwind `field-sizing-content`) with a JS scrollHeight fallback for Firefox.
// `rows` is ignored in this mode. Type a few lines to watch it grow then cap.
//
// NOTE: Enter-to-submit vs Shift+Enter-for-newline is the CONSUMER's keydown
// concern — the design-system component never hard-codes submit. Here Enter just
// inserts a newline (the native default), which is what makes the grow visible.
export const AutoGrow: Story = {
  name: 'Auto-grow (chat composer)',
  render: () => (
    <div className="flex flex-col gap-[var(--space-1)] w-96 max-w-full">
      <label htmlFor="autogrow-composer" className="font-ui text-xs text-ink-secondary">
        Message
      </label>
      <TextArea
        id="autogrow-composer"
        autoSize
        minRows={1}
        maxRows={6}
        placeholder="composer.message"
      />
    </div>
  ),
}
