import { useEffect, useRef } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SeamlessInput } from './SeamlessInput.tsx'

// SeamlessInput — the borderless "ghost" creation-flow field (working name). The
// calm, one-question-at-a-time (Typeform-style) world-creation surface: a
// prominent serif QUESTION (the associated label) with the user's answer below
// it as just text + a blinking ember caret — no visible box.
//
// Built to the ghost-input design language: no border/background (the field
// reads as text), display-size serif PROSE type (the "magical" register, vs the
// boxed Input's mono data face), a branded `caret-accent`, the question as the
// programmatically-associated visible label (WCAG 3.3.2), and a NON-BOX focus
// affordance — a thin baseline rule that thickens + colors to accent on focus
// (WCAG 2.4.13; the box outline is removed because the baseline IS the
// indicator). Placeholder is a faint hint only. `multiline` swaps to an
// auto-growing `<textarea>` for long world-creation prose.
//
// Content/i18n: `label` + `placeholder` are i18n keys the consumer resolves; the
// stories show resolved prose so the magical view reads correctly.

const meta: Meta<typeof SeamlessInput> = {
  title: 'Controls/SeamlessInput',
  component: SeamlessInput,
  tags: ['autodocs'],
  argTypes: {
    multiline: { control: 'boolean' },
    disabled: { control: 'boolean' },
    required: { control: 'boolean' },
    onChange: { action: 'changed' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SeamlessInput>

// The magical view — a single question, the borderless field + ember caret
// below. The screen is "just the prompt and the answer".
export const Default: Story = {
  name: 'What is your world called?',
  render: () => (
    <div className="w-[40rem] max-w-full">
      <SeamlessInput label="What is your world called?" placeholder="A name will come to you…" />
    </div>
  ),
}

// Multiline — the auto-growing textarea for long world-creation prose. Type past
// a line and the field grows to fit (field-sizing-content); no resize handle, no
// inner scrollbar.
export const Multiline: Story = {
  name: 'Describe the feel of your world…',
  render: () => (
    <div className="w-[40rem] max-w-full">
      <SeamlessInput
        multiline
        label="Describe the feel of your world…"
        placeholder="Damp stone, lantern-light, something old waking under the hills…"
      />
    </div>
  ),
}

// Focused — shows the non-box focus affordance: the accent baseline rule (2px,
// ember) under a pre-filled answer, with the box outline removed. The field is
// focused programmatically on mount (a `ref.focus()`, not the JSX `autoFocus`
// attribute) so the accent baseline is visible in the catalogue. (Tab to the
// field in the other stories to see the resting→focus transition live.)
function FocusedSpecimen() {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div className="w-[40rem] max-w-full">
      <SeamlessInput ref={ref} label="What is your world called?" defaultValue="The Hollow Reach" />
    </div>
  )
}

export const Focused: Story = {
  name: 'Focus affordance (accent baseline rule)',
  render: () => <FocusedSpecimen />,
}

// Disabled — the muted, non-interactive state (native disabled + muted ink).
export const Disabled: Story = {
  render: () => (
    <div className="w-[40rem] max-w-full">
      <SeamlessInput
        disabled
        label="What is your world called?"
        defaultValue="Locked while the prep engine runs"
      />
    </div>
  ),
}
