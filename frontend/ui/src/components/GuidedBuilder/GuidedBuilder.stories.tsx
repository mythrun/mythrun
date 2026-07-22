import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { GuidedOption, RailStep } from '@mythrun/client-core/contract'
import { GuidedBuilder } from './GuidedBuilder.tsx'

// GuidedBuilder — the one-question-at-a-time character builder. FULLY CONTROLLED:
// the client-core guided reducer owns the step sequence, the subclass-skip logic,
// and which options a step shows; this component only renders the current rail +
// question + options and fires the neutral callbacks. These stories supply a small
// stateful harness (selection only) and a reading-measure container so each step
// reads like the real screen.
//
// Content/i18n: `question` + the option `name`/`description` + the nav `labels` are
// resolved display strings the shell passes in. The specimen copy below is realistic
// sample text (stories are lint-exempt).

const meta: Meta<typeof GuidedBuilder> = {
  title: 'Character/GuidedBuilder',
  component: GuidedBuilder,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof GuidedBuilder>

const noop = (): void => undefined

// The resolved nav labels the shell supplies (real MYT-100 copy).
const NAV_LABELS = { next: 'Next', back: 'Back', switchToFreeform: 'Describe them instead' }

// Step 1 (Calling) — nothing chosen yet, so no rung is `done` and Back is hidden.
const CALLING_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', state: 'now' },
  { step: 'species', label: 'Origin', state: 'todo' },
  { step: 'background', label: 'Background', state: 'todo' },
]

// The twelve SRD classes (realistic sample display copy).
const CLASS_OPTIONS: GuidedOption[] = [
  { id: 'barbarian', name: 'Barbarian', description: 'The fury that answers when reason will not.' },
  { id: 'bard', name: 'Bard', description: 'The story that bends the room.' },
  { id: 'cleric', name: 'Cleric', description: 'A borrowed power, and its price.' },
  { id: 'druid', name: 'Druid', description: 'The wild speaks; you answer.' },
  { id: 'fighter', name: 'Fighter', description: 'The discipline of the blade — and knowing when to use it.' },
  { id: 'monk', name: 'Monk', description: 'Stillness sharpened into a weapon.' },
  { id: 'paladin', name: 'Paladin', description: 'An oath heavier than any armor.' },
  { id: 'ranger', name: 'Ranger', description: 'The border between wild and settled.' },
  { id: 'rogue', name: 'Rogue', description: 'The door that was never locked to you.' },
  { id: 'sorcerer', name: 'Sorcerer', description: 'Power that was always in the blood.' },
  { id: 'warlock', name: 'Warlock', description: 'A bargain, and what it wants back.' },
  { id: 'wizard', name: 'Wizard', description: 'The world, written down and rewritten.' },
]

// A mid-sequence step (Origin) — two prior picks carried as `done` rungs.
const ORIGIN_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', chosen: 'Fighter', state: 'done' },
  { step: 'subclass', label: 'Practice', chosen: 'Champion', state: 'done' },
  { step: 'species', label: 'Origin', state: 'now' },
  { step: 'background', label: 'Background', state: 'todo' },
]

const SPECIES_OPTIONS: GuidedOption[] = [
  { id: 'human', name: 'Human', description: 'Adaptable, everywhere, unremarkable until they are not.' },
  { id: 'elf', name: 'Elf', description: 'A longer memory than the streets that raised them.' },
  { id: 'dwarf', name: 'Dwarf', description: 'Stone-patient, ledger-exact.' },
  { id: 'halfling', name: 'Halfling', description: 'Small, and comfortable being underestimated.' },
  { id: 'tiefling', name: 'Tiefling', description: 'A heritage the street reads before you speak.' },
]

// The subclass step for a class the SRD gives exactly one first-level subclass.
const PRACTICE_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', chosen: 'Cleric', state: 'done' },
  { step: 'subclass', label: 'Practice', state: 'now' },
  { step: 'species', label: 'Origin', state: 'todo' },
  { step: 'background', label: 'Background', state: 'todo' },
]

const SINGLE_SUBCLASS: GuidedOption[] = [
  { id: 'life', name: 'Life Domain', description: 'The care of the living — warmth, mending, the refusal to let go.' },
]

// A small stateful harness so a specimen behaves like the real screen: clicking a
// card moves the ember selection. Flow callbacks are no-ops (the reducer owns them).
function Builder({
  rail,
  question,
  options,
  initialSelected = null,
}: {
  rail: RailStep[]
  question: string
  options: GuidedOption[]
  initialSelected?: string | null
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected)
  return (
    <div className="mx-auto max-w-[1120px] bg-bg p-[var(--space-6)]">
      <GuidedBuilder
        labels={NAV_LABELS}
        rail={rail}
        question={question}
        options={options}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNext={noop}
        onBack={noop}
        onSkipToFreeform={noop}
      />
    </div>
  )
}

// Step 1 — the twelve callings in a grid, Fighter pre-selected (the ember card),
// Back hidden (nothing done yet).
export const Calling: Story = {
  name: 'Calling — 12 classes (first step)',
  render: () => (
    <Builder
      rail={CALLING_RAIL}
      question="What is your calling?"
      options={CLASS_OPTIONS}
      initialSelected="fighter"
    />
  ),
}

// A mid-sequence step — prior picks carried in the rail, Back visible.
export const Origin: Story = {
  name: 'Origin — mid sequence (prior picks in the rail)',
  render: () => (
    <Builder rail={ORIGIN_RAIL} question="Where do you come from?" options={SPECIES_OPTIONS} />
  ),
}

// A single-option subclass step — one full-width confirm card.
export const SingleSubclass: Story = {
  name: 'Practice — single-option confirm',
  render: () => (
    <Builder rail={PRACTICE_RAIL} question="How do you practice it?" options={SINGLE_SUBCLASS} />
  ),
}

// The calling step at ~375px — the grid collapses to one column, the rail + nav wrap.
export const MobileCalling: Story = {
  name: 'Mobile — calling (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <GuidedBuilder
        labels={NAV_LABELS}
        rail={CALLING_RAIL}
        question="What is your calling?"
        options={CLASS_OPTIONS.slice(0, 4)}
        selectedId="fighter"
        onSelect={noop}
        onNext={noop}
        onBack={noop}
        onSkipToFreeform={noop}
      />
    </div>
  ),
}
