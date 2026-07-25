import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CuratedSheet, CharacterOverlay } from '@mythrun/client-core/contract'
import { SessionSheet } from './SessionSheet.tsx'

// SessionSheet — the in-session variant of the member's curated sheet, shown in the
// play sidebar's "Character Sheet" tab. Same field-guide body as CharacterSheetReveal
// (identity, stat stripe, ability tiles, prose, the do/carry/cast panels) but with
// the creation-flow chrome stripped (no confirm / start over / full sheet) and the
// LIVE character-state overlay folded over it: the HP stat tracks the authoritative
// `ledger_update` HP, and a quiet "recent changes" log renders condition summaries.
// The prose/spell/feature content below are realistic samples (stories are lint-
// exempt); the real strings arrive from the backend via the sheet view-model. The HP
// stat's label is 'HP' because the shipped `buildStats` emits it that way — that is
// the key the live-HP overlay replaces.

const MARTIAL: CuratedSheet = {
  name: 'Kessa Vurm',
  identityLine: 'Level 3 · Human Fighter · Champion · Toll-clerk of Greenward',
  stats: [
    { key: 'ac', label: 'AC', value: '16' },
    { key: 'hp', label: 'HP', value: '28 / 28' },
    { key: 'proficiency', label: 'Proficiency', value: '+2' },
    { key: 'hitDie', label: 'Hit Die', value: 'd10' },
    { key: 'speed', label: 'Speed', value: '30 ft' },
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
    'Kessa spent eleven years stamping manifests at the Greenward Toll, and she never once miscounted a wagon. Broad through the shoulders, careful with her hands, slow to anger and unnerving once she gets there.',
    "When six wagons rolled through empty and the drivers couldn't say why, the numbers wouldn't leave her alone. She's the only one who noticed. That's usually how it starts.",
  ],
  features: [
    { name: 'Second Wind', gloss: 'Catch her breath: recover a burst of HP once per rest.' },
    { name: 'Action Surge', gloss: 'One extra action when it counts. Once per rest.' },
    { name: 'Improved Critical', gloss: 'Champion: her blade bites on a 19 or 20.' },
  ],
  equipment: [
    { name: 'Longsword', gloss: "Versatile · her father's, re-hilted." },
    { name: 'Chain mail & shield' },
    { name: 'Belt pouch · 9 gp' },
  ],
}

const CASTER: CuratedSheet = {
  name: 'Ilma the Unwritten',
  identityLine: 'Level 3 · Gnome Wizard · Evocation · Runaway apprentice',
  stats: [
    { key: 'ac', label: 'AC', value: '12' },
    { key: 'hp', label: 'HP', value: '17 / 17' },
    { key: 'proficiency', label: 'Proficiency', value: '+2' },
    { key: 'hitDie', label: 'Hit Die', value: 'd6' },
    { key: 'speed', label: 'Speed', value: '25 ft' },
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
    "Ilma left her master's tower with a stolen spellbook and a burn scar she won't explain. She reads faster than she talks, which is often.",
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

// No live overlay yet — the resting sheet shows the static HP + the calm empty line.
// `activeConditions: null` = no frame has spoken yet, distinct from `[]` ("none
// right now"). The sheet renders the conditionLog prose only; the active set is
// folded on the overlay but its presentation is still an open design call.
const RESTING: CharacterOverlay = {
  hp: null, maxHp: null, gold: null, conditionLog: [], activeConditions: null,
}
// Mid-combat — the ledger has folded a damage beat + condition notes.
const MID_COMBAT: CharacterOverlay = {
  hp: 9,
  maxHp: 28,
  gold: null,
  conditionLog: [
    'A hobgoblin blade opens a gash along her ribs.',
    'She staggers, breath ragged — the venom starts to bite.',
  ],
  activeConditions: [{ condition: 'poisoned', level: null }],
}

// Fixed brand chrome labels are wired by the composing route from i18n; the stories
// pass realistic resolved samples.
const LABELS = {
  hpLabel: 'Current HP',
  conditionsLabel: 'Recent changes',
  emptyLabel: 'Nothing has changed yet.',
}

const meta: Meta<typeof SessionSheet> = {
  title: 'Session/SessionSheet',
  component: SessionSheet,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof SessionSheet>

// Desktop-in-rail — the martial specimen resting (static HP, calm empty line). Framed
// at the sidebar rail width so the single-column layout reads as it will in play.
export const Martial: Story = {
  name: 'Martial — resting (static HP)',
  render: () => (
    <div className="max-w-[22rem] bg-bg p-[var(--space-5)]">
      <SessionSheet sheet={MARTIAL} overlay={RESTING} {...LABELS} />
    </div>
  ),
}

// A caster — the "What they can cast" spell panel appears.
export const Caster: Story = {
  name: 'Caster — resting (spells panel)',
  render: () => (
    <div className="max-w-[22rem] bg-bg p-[var(--space-5)]">
      <SessionSheet sheet={CASTER} overlay={RESTING} {...LABELS} />
    </div>
  ),
}

// Mid-combat — the live HP overlays the static HP and the condition log surfaces the
// recent changes as quiet prose lines (no chips).
export const MidCombat: Story = {
  name: 'Mid-combat — live HP + condition log',
  render: () => (
    <div className="max-w-[22rem] bg-bg p-[var(--space-5)]">
      <SessionSheet sheet={MARTIAL} overlay={MID_COMBAT} {...LABELS} />
    </div>
  ),
}

// Mobile — the same sheet at ~375px (it also mounts inside the mobile Drawer).
export const Mobile: Story = {
  name: 'Mobile — single column (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <SessionSheet sheet={MARTIAL} overlay={MID_COMBAT} {...LABELS} />
    </div>
  ),
}
