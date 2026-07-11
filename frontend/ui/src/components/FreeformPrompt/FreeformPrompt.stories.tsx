import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FreeformPrompt } from './FreeformPrompt.tsx'

// FreeformPrompt — the "tell us who you are" fork of character creation: a single
// calm question + whisper + one generous textarea + a submit control. The prompt
// is the field's real <label> (the question names the answer for AT); the whisper
// is the field's aria-described guidance. Pure/presentational — value/onChange and
// onSubmit are the neutral callbacks the view-model wires.
//
// Content/i18n: `prompt`, `whisper`, and `placeholder` are the resolved copy the
// shell passes in; the specimen strings below are realistic samples (stories are
// lint-exempt). The component is measure-agnostic, so these stories supply the
// reading measure (the desktop column and the 375px phone frame).

const meta: Meta<typeof FreeformPrompt> = {
  title: 'Character/FreeformPrompt',
  component: FreeformPrompt,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof FreeformPrompt>

const PROMPT = 'Who are you?'
const WHISPER =
  'Tell us about your character. Who are they? What brought them to the empty caravan at Greenward Toll?'
const PLACEHOLDER =
  'A retired toll-clerk who never stopped counting. She reads ledgers like other people read faces, and the manifests on those six wagons don’t add up — which is exactly why she can’t walk away…'
const FILLED =
  'A retired toll-clerk who never stopped counting. She reads ledgers like other people read faces, and the manifests on those six wagons don’t add up.'

// A tiny stateful harness so the specimen behaves like the real screen: typing
// updates the field, and the submit control is a live (no-op) commit.
function Live({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <FreeformPrompt
      prompt={PROMPT}
      whisper={WHISPER}
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      placeholder={PLACEHOLDER}
    />
  )
}

// Desktop — the empty prompt at its calm reading measure.
export const Empty: Story = {
  name: 'Empty (desktop)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <Live />
    </div>
  ),
}

// A filled concept — the textarea has grown with the prose.
export const Filled: Story = {
  name: 'Filled',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <Live initial={FILLED} />
    </div>
  ),
}

// Mobile — the same composition in a single column at ~375px.
export const Phone: Story = {
  name: 'Phone (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <Live />
    </div>
  ),
}
