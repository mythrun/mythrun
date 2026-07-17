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

// The grounding screen — every builder rung done, the rail-only grounding rung
// `now`: the state guided-path renders above the grounding prompt.
const GROUNDING_RAIL: RailStep[] = [
  { step: 'class', label: 'Class', chosen: 'Fighter', state: 'done' },
  { step: 'subclass', label: 'Subclass', chosen: 'Champion', state: 'done' },
  { step: 'species', label: 'Species', chosen: 'Human', state: 'done' },
  { step: 'background', label: 'Background', chosen: 'Soldier', state: 'done' },
  { step: 'notes', label: 'Notes', state: 'done' },
  { step: 'grounding', label: 'Grounding', state: 'now' },
]

// The notes screen — the free-text coda mid-journey: picks done, notes `now`,
// grounding still `todo` ahead.
const NOTES_RAIL: RailStep[] = [
  { step: 'class', label: 'Class', chosen: 'Cleric', state: 'done' },
  { step: 'subclass', label: 'Subclass', chosen: 'Life Domain', state: 'done' },
  { step: 'species', label: 'Species', chosen: 'Dwarf', state: 'done' },
  { step: 'background', label: 'Background', chosen: 'Acolyte', state: 'done' },
  { step: 'notes', label: 'Notes', state: 'now' },
  { step: 'grounding', label: 'Grounding', state: 'todo' },
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

// Mid-journey — the notes step with grounding still ahead.
export const Notes: Story = {
  name: 'Notes (grounding ahead)',
  render: () => (
    <div className="max-w-[720px] bg-bg p-[var(--space-6)]">
      <GuidedRail rail={NOTES_RAIL} />
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
