import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RailStep } from '@mythrun/client-core/contract'
import { GuidedRail } from './GuidedRail.tsx'

// GuidedRail — the guided journey's progress rail as a standalone component
// (MYT-102): the same done/now/todo rung row GuidedBuilder shows on its option
// steps, mounted on the builder-less screens of the flow (the notes and grounding
// prompts) so the signposting never disappears mid-journey. Non-interactive; the
// rung labels are the brain's fixed chrome, the chosen values are the player's
// picks (specimen copy below is realistic sample text; stories are lint-exempt).

const meta: Meta<typeof GuidedRail> = {
  title: 'Character/GuidedRail',
  component: GuidedRail,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof GuidedRail>

// The grounding screen — every builder rung done (collapsed to their chosen
// values — the receipt IS the path; a chosen subclass rides the class rung), the
// rail-only Arrival rung `now`: the state guided-path renders above the
// grounding prompt.
const GROUNDING_RAIL: RailStep[] = [
  { step: 'class', label: 'Class', chosen: 'Fighter · Champion', state: 'done' },
  { step: 'species', label: 'Species', chosen: 'Human', state: 'done' },
  { step: 'background', label: 'Background', chosen: 'Soldier', state: 'done' },
  { step: 'notes', label: 'Notes', state: 'done' },
  { step: 'grounding', label: 'Arrival', state: 'now' },
]

// The notes screen — the free-text coda mid-journey: picks done, notes `now`,
// the arrival still `todo` ahead.
const NOTES_RAIL: RailStep[] = [
  { step: 'class', label: 'Class', chosen: 'Cleric · Life Domain', state: 'done' },
  { step: 'species', label: 'Species', chosen: 'Dwarf', state: 'done' },
  { step: 'background', label: 'Background', chosen: 'Acolyte', state: 'done' },
  { step: 'notes', label: 'Notes', state: 'now' },
  { step: 'grounding', label: 'Arrival', state: 'todo' },
]

// A completed NOTES station carrying the player's own prose — clamped to a
// one-line ellipsis token, expandable on click (ux-run2 myth-udhp3).
const CLAMPED_RAIL: RailStep[] = [
  { step: 'class', label: 'Class', chosen: 'Cleric · Life Domain', state: 'done' },
  { step: 'species', label: 'Species', chosen: 'Human', state: 'done' },
  { step: 'background', label: 'Background', chosen: 'Hermit', state: 'done' },
  {
    step: 'notes',
    label: 'Notes',
    chosen: 'They call me Sable now, though that is only the half of it. The ledger remembers the rest.',
    state: 'done',
  },
  { step: 'grounding', label: 'Arrival', state: 'now' },
]

// Desktop — the grounding state at a comfortable measure.
export const Grounding: Story = {
  name: 'Grounding (all picks done)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <GuidedRail rail={GROUNDING_RAIL} />
    </div>
  ),
}

// Mid-journey — the notes step with the arrival still ahead, plus the quiet
// step counter on the trailing edge.
export const Notes: Story = {
  name: 'Notes (arrival ahead, counter)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <GuidedRail rail={NOTES_RAIL} counter="Step 4 of 5" />
    </div>
  ),
}

// A long NOTES value — the rung clamps to a one-line token with an ellipsis and
// expands on click (the full note is one click away; the breadcrumb never
// out-shouts the current step).
export const ClampedNotes: Story = {
  name: 'Long notes (clamped, click to expand)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <GuidedRail rail={CLAMPED_RAIL} counter="Step 5 of 5" />
    </div>
  ),
}

// Mobile — the rail wraps into rows at ~375px (flex-wrap; no horizontal scroll).
export const Phone: Story = {
  name: 'Phone (~375px)',
  render: () => (
    <div className="mx-auto max-w-[375px] bg-bg p-[var(--space-4)]">
      <GuidedRail rail={GROUNDING_RAIL} />
    </div>
  ),
}
