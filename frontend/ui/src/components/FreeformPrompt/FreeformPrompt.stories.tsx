import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FreeformPrompt } from './FreeformPrompt.tsx'

// FreeformPrompt — the "tell us who you are" fork of character creation: a single
// calm question + whisper + one generous textarea + a submit control. The prompt
// is the field's real <label> (the question names the answer for AT); the whisper
// is the field's aria-described guidance. Pure/presentational — value/onChange and
// onSubmit are the neutral callbacks the view-model wires.
//
// Content/i18n: `prompt`, `whisper`, `placeholder`, and `submitLabel` are the
// resolved copy the shell passes in; the specimen strings below are realistic
// samples (stories are lint-exempt). The component is measure-agnostic, so these
// stories supply the reading measure (the desktop column and the 375px phone frame).

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
function Live({
  initial = '',
  stepIndicator,
  whisperVoice,
  compact = false,
  withBack = false,
}: {
  initial?: string
  stepIndicator?: string
  whisperVoice?: 'hint' | 'dm'
  compact?: boolean
  withBack?: boolean
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <FreeformPrompt
      prompt={PROMPT}
      whisper={WHISPER}
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      submitLabel="Continue"
      placeholder={PLACEHOLDER}
      {...(stepIndicator !== undefined && { stepIndicator })}
      {...(whisperVoice !== undefined && { whisperVoice })}
      {...(compact && { compact })}
      {...(withBack && { onBack: () => undefined, backLabel: 'Back' })}
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

// The step signpost (MYT-102) — the quiet mono "1 of 2" eyebrow above the
// prompt, so the player knows a second question follows and doesn't front-load
// their whole answer into the first.
export const WithStepIndicator: Story = {
  name: 'With step indicator (1 of 2)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <Live stepIndicator="1 of 2" />
    </div>
  ),
}

// The DM-voice whisper (ux-run2 myth-4gnrp) — the AI's bespoke, personalized
// prompt promoted to roman body size with a quiet left rule (the guided path's
// grounding step), with the quiet action-row Back (ux-run2 myth-80an1).
export const DmVoiceWhisper: Story = {
  name: 'DM-voice whisper + action-row Back',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <Live whisperVoice="dm" withBack />
    </div>
  ),
}

// The compact detail field (ux-run2 myth-z45sb) — the notes coda's ~3-line
// floor: the field matches the ask ("a detail"), not an essay.
export const CompactDetail: Story = {
  name: 'Compact (the notes detail floor)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <Live compact withBack />
    </div>
  ),
}

// Mobile — the same composition in a single column at ~375px (signpost included).
export const Phone: Story = {
  name: 'Phone (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <Live stepIndicator="1 of 2" />
    </div>
  ),
}
