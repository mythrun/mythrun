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
const NAV_LABELS = { next: 'Next', back: 'Back', switchToFreeform: 'Describe your character instead' }

// Step 1 (Calling) — nothing chosen yet, so no rung is `done`.
const CALLING_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', state: 'now' },
  { step: 'species', label: 'Origin', state: 'todo' },
  { step: 'background', label: 'Background', state: 'todo' },
]

// The twelve SRD classes (realistic sample display copy).
const CLASS_OPTIONS: GuidedOption[] = [
  { id: 'barbarian', name: 'Barbarian', description: 'Hit things. Get hit. Keep standing.' },
  { id: 'bard', name: 'Bard', description: 'Charm, songs, and a bit of everything.' },
  { id: 'cleric', name: 'Cleric', description: 'You asked a power for help. Something answered.' },
  { id: 'druid', name: 'Druid', description: 'The wild lends you its shapes and storms.' },
  { id: 'fighter', name: 'Fighter', description: 'Weapons are a language. You are fluent.' },
  { id: 'monk', name: 'Monk', description: 'Empty hands, faster than knives.' },
  { id: 'paladin', name: 'Paladin', description: 'An oath you keep with a sword.' },
  { id: 'ranger', name: 'Ranger', description: 'At home where the maps give up.' },
  { id: 'rogue', name: 'Rogue', description: "Locks, shadows, and other people's pockets." },
  { id: 'sorcerer', name: 'Sorcerer', description: 'Magic was born in you. It leaks.' },
  { id: 'warlock', name: 'Warlock', description: 'You made a deal. The magic is the interest.' },
  { id: 'wizard', name: 'Wizard', description: 'Fragile body, immense studied power.' },
]

// A mid-sequence step (Origin) — two prior picks carried as `done` rungs.
const ORIGIN_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', chosen: 'Fighter · Champion', state: 'done' },
  { step: 'species', label: 'Origin', state: 'now' },
  { step: 'background', label: 'Background', state: 'todo' },
]

const SPECIES_OPTIONS: GuidedOption[] = [
  { id: 'human', name: 'Human', description: 'Everywhere, ambitious, quick to adapt.' },
  { id: 'elf', name: 'Elf', description: 'Long lives, light feet, older memories.' },
  { id: 'dwarf', name: 'Dwarf', description: 'Stone-patient, forge-proud, hard to knock down.' },
  { id: 'halfling', name: 'Halfling', description: 'Small, cheerful, and strangely lucky.' },
  { id: 'tiefling', name: 'Tiefling', description: 'A fiendish inheritance you never asked for.' },
]

// The subclass sub-question for a class the SRD gives exactly one first-level
// subclass — the CLASS station stays current (the rail never grows a station
// mid-flow; ux-run2 myth-udhp3 / myth-mttu7).
const PRACTICE_RAIL: RailStep[] = [
  { step: 'class', label: 'Calling', chosen: 'Cleric', state: 'now' },
  { step: 'species', label: 'Origin', state: 'todo' },
  { step: 'background', label: 'Background', state: 'todo' },
]

const SINGLE_SUBCLASS: GuidedOption[] = [{ id: 'life', name: 'Life Domain', description: '' }]

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

// Step 1 — the twelve callings in a grid, Fighter pre-selected (the ember card).
// Back rides the wayfinding row at the top, beside the rail (ux-run3 myth-t6pxy:
// twelve cards push a bottom-seated Back below a 720px fold, and step 1 is where
// the path choice is cheapest to reverse) — on the first step the parent wires it
// to leave the builder.
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

// A mid-sequence step — prior picks carried in the rail beside Back.
export const Origin: Story = {
  name: 'Origin — mid sequence (prior picks in the rail)',
  render: () => (
    <Builder rail={ORIGIN_RAIL} question="Where do you come from?" options={SPECIES_OPTIONS} />
  ),
}

// The single-option subclass — a statement with consent (ux-run2 myth-mttu7):
// the lore statement as the question, the sole card preselected, Continue the
// single act (no staged choice).
export const SingleSubclass: Story = {
  name: 'Practice — statement with consent',
  render: () => (
    <Builder
      rail={PRACTICE_RAIL}
      question="Life Domain is the Cleric's path here."
      options={SINGLE_SUBCLASS}
      initialSelected="life"
    />
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
