import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { CharacterSheetReveal } from './CharacterSheetReveal.tsx'
import type { CuratedSheet, FullSheet } from '@mythrun/client-core/contract'

// CharacterSheetReveal — the "Meet your character" payoff. A new player meets their
// character as a FIELD-GUIDE ENTRY (name + identity eyebrow, stat stripe, six square
// ability tiles, connection prose, and the "what they can do / carry / cast" panels),
// not a stat block. "See full sheet" is a pure CLIENT reveal of the full mechanical
// sheet — no network. The prose + spell/feature content below are realistic samples
// (stories are lint-exempt); the real strings arrive from the backend via props.

const meta: Meta<typeof CharacterSheetReveal> = {
  title: 'Character/CharacterSheetReveal',
  component: CharacterSheetReveal,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CharacterSheetReveal>

const noop = (): void => undefined

// The resolved chrome labels the shell supplies (real MYT-100 copy — `startOver`
// resolves `$t(shared.beginAgain)`).
const REVEAL_LABELS = {
  confirm: 'This is me',
  seeFull: 'See full sheet',
  hideFull: 'Hide full sheet',
  startOver: 'Begin again',
  panelFeatures: 'What they can do',
  panelEquipment: 'What they carry',
  panelSpells: 'What they can cast',
}

// A martial character (Kessa Vurm — the mockup specimen): NO spells.
const MARTIAL_CURATED: CuratedSheet = {
  name: 'Kessa Vurm',
  identityLine: 'Level 3 · Human Fighter · Champion · Toll-clerk of Greenward',
  stats: [
    { label: 'Armor Class', value: '16' },
    { label: 'Hit Points', value: '28' },
    { label: 'Proficiency', value: '+2' },
    { label: 'Hit Die', value: 'd10' },
    { label: 'Speed', value: '30 ft' },
  ],
  abilities: [
    { abbrev: 'STR', score: 16, modifier: 3 },
    { abbrev: 'DEX', score: 13, modifier: 1 },
    { abbrev: 'CON', score: 15, modifier: 2 },
    { abbrev: 'INT', score: 12, modifier: 1 },
    { abbrev: 'WIS', score: 11, modifier: 0 },
    { abbrev: 'CHA', score: 9, modifier: -1 },
  ],
  prose: [
    'Kessa spent eleven years stamping manifests at the Greenward Toll, and she never once miscounted a wagon. She keeps her old ledger-stylus sharpened to a point that could open a letter — or a throat. Broad through the shoulders, careful with her hands, slow to anger and unnerving once she gets there.',
    "When six wagons rolled through empty and the drivers couldn't say why, the numbers wouldn't leave her alone. She's the only one who noticed. That's usually how it starts.",
  ],
  features: [
    { name: 'Second Wind', gloss: 'Catch her breath: recover a burst of HP once per rest.' },
    { name: 'Action Surge', gloss: 'One extra action when it counts. Once per rest.' },
    { name: 'Improved Critical', gloss: 'Champion: her blade bites on a 19 or 20.' },
    { name: 'Fighting Style: Defense', gloss: "+1 AC while she's wearing armor." },
  ],
  equipment: [
    { name: 'Longsword', gloss: "Versatile · her father's, re-hilted." },
    { name: 'Chain mail & shield' },
    { name: 'Ledger-stylus', gloss: 'Sharpened. Sentimental. Occasionally lethal.' },
    { name: 'Belt pouch · 9 gp' },
  ],
}

const MARTIAL_FULL: FullSheet = {
  skills: [
    { name: 'Acrobatics', proficient: false, expertise: false },
    { name: 'Athletics', proficient: true, expertise: false },
    { name: 'Deception', proficient: false, expertise: false },
    { name: 'History', proficient: false, expertise: false },
    { name: 'Insight', proficient: true, expertise: false },
    { name: 'Intimidation', proficient: true, expertise: true },
    { name: 'Investigation', proficient: false, expertise: false },
    { name: 'Perception', proficient: true, expertise: false },
    { name: 'Persuasion', proficient: false, expertise: false },
    { name: 'Survival', proficient: false, expertise: false },
  ],
  savingThrows: ['Strength', 'Constitution'],
  equipment: [
    { name: 'Longsword', gloss: "Versatile · her father's, re-hilted." },
    { name: 'Chain mail' },
    { name: 'Shield' },
    { name: 'Ledger-stylus' },
    { name: "Explorer's pack" },
    { name: 'Belt pouch · 9 gp' },
  ],
  spells: [],
}

// A caster (a Wizard): the curated + full spell panels are present.
const CASTER_CURATED: CuratedSheet = {
  name: 'Ilma the Unwritten',
  identityLine: 'Level 3 · Gnome Wizard · Evocation · Runaway apprentice',
  stats: [
    { label: 'Armor Class', value: '12' },
    { label: 'Hit Points', value: '17' },
    { label: 'Proficiency', value: '+2' },
    { label: 'Hit Die', value: 'd6' },
    { label: 'Speed', value: '25 ft' },
  ],
  abilities: [
    { abbrev: 'STR', score: 8, modifier: -1 },
    { abbrev: 'DEX', score: 14, modifier: 2 },
    { abbrev: 'CON', score: 13, modifier: 1 },
    { abbrev: 'INT', score: 17, modifier: 3 },
    { abbrev: 'WIS', score: 12, modifier: 1 },
    { abbrev: 'CHA', score: 10, modifier: 0 },
  ],
  prose: [
    "Ilma left her master's tower with a stolen spellbook and a burn scar she won't explain. She reads faster than she talks, which is often, and she writes in a shorthand no one else can follow.",
    'The tower is still looking for its book. She tells herself she only borrowed it.',
  ],
  features: [
    { name: 'Arcane Recovery', gloss: 'Recover spell slots on a short rest, once a day.' },
    { name: 'Sculpt Spells', gloss: 'Evocation: her allies step through the blast unburned.' },
  ],
  equipment: [
    { name: 'Quarterstaff' },
    { name: 'Spellbook', gloss: 'Stolen. Half in a cipher.' },
    { name: 'Component pouch' },
  ],
  spells: [
    { name: 'Fire Bolt', gloss: 'Cantrip · a mote of directed flame.' },
    { name: 'Shield', gloss: 'Reaction · a sudden wall of force.' },
    { name: 'Magic Missile', gloss: 'Three darts that never miss.' },
    { name: 'Misty Step', gloss: 'Blink thirty feet through the veil.' },
  ],
}

const CASTER_FULL: FullSheet = {
  skills: [
    { name: 'Arcana', proficient: true, expertise: false },
    { name: 'History', proficient: true, expertise: false },
    { name: 'Insight', proficient: false, expertise: false },
    { name: 'Investigation', proficient: true, expertise: true },
    { name: 'Medicine', proficient: false, expertise: false },
    { name: 'Perception', proficient: false, expertise: false },
  ],
  savingThrows: ['Intelligence', 'Wisdom'],
  equipment: [
    { name: 'Quarterstaff' },
    { name: 'Spellbook' },
    { name: 'Component pouch' },
    { name: "Scholar's pack" },
  ],
  spells: [
    { name: 'Fire Bolt' },
    { name: 'Mage Hand' },
    { name: 'Prestidigitation' },
    { name: 'Shield' },
    { name: 'Magic Missile' },
    { name: 'Detect Magic' },
    { name: 'Misty Step' },
    { name: 'Scorching Ray' },
  ],
}

// A stateful harness so "See full sheet" behaves like the real screen: the toggle
// flips the controlled `expanded` and the full mechanical sheet reveals inline.
function Reveal({
  curated,
  full,
  startExpanded = false,
}: {
  curated: CuratedSheet
  full: FullSheet
  startExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(startExpanded)
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <CharacterSheetReveal
        labels={REVEAL_LABELS}
        curated={curated}
        full={full}
        expanded={expanded}
        onToggleExpand={() => {
          setExpanded((v) => !v)
        }}
        onConfirm={noop}
        onStartOver={noop}
      />
    </div>
  )
}

// Desktop — the martial specimen (no spells), collapsed.
export const Martial: Story = {
  name: 'Desktop — martial (no spells)',
  render: () => <Reveal curated={MARTIAL_CURATED} full={MARTIAL_FULL} />,
}

// Desktop — a caster, so the "What they can cast" spell panel appears.
export const Caster: Story = {
  name: 'Desktop — caster (spells panel)',
  render: () => <Reveal curated={CASTER_CURATED} full={CASTER_FULL} />,
}

// Desktop — the full mechanical sheet revealed inline (skills / saves / equipment /
// spells).
export const Expanded: Story = {
  name: 'Desktop — expanded (full sheet)',
  render: () => <Reveal curated={CASTER_CURATED} full={CASTER_FULL} startExpanded />,
}

// Mobile — the same entry as a single column at ~375px.
export const Mobile: Story = {
  name: 'Mobile — single column (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px]">
      <Reveal curated={MARTIAL_CURATED} full={MARTIAL_FULL} />
    </div>
  ),
}
