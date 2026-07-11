import type { Meta, StoryObj } from '@storybook/react-vite'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { CharacterLoadingBeat } from './CharacterLoadingBeat.tsx'

// CharacterLoadingBeat — the "coming into being" beat that holds the screen while
// the pipeline generates the character sheet. The 1-bit silhouette fills in (a
// reused Dither hatch rising from the base) beside a column of surfacing beats.
// Pure/presentational: the specimens below hand it fixed `beats` snapshots at
// different progress. The beat labels are realistic samples (stories are
// lint-exempt); the real screen streams them from the client-core view-model.

const MID_BEATS: LoadingBeat[] = [
  { id: 'name', label: 'Kessa Vurm — a name surfaces', state: 'done' },
  { id: 'class', label: 'Human · Fighter — Champion', state: 'done' },
  { id: 'scores', label: 'rolling ability scores…', state: 'active' },
  { id: 'kit', label: 'gathering equipment…', state: 'pending' },
]

const COMPLETE_BEATS: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'done' }))

const meta: Meta<typeof CharacterLoadingBeat> = {
  title: 'Character/CharacterLoadingBeat',
  component: CharacterLoadingBeat,
  tags: ['autodocs'],
  // A paper page ground so the loadwrap card reads as it does on the real screen.
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <Story />
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CharacterLoadingBeat>

// Mid-progress — two beats done (the fill is ~half-risen), one surfacing in ember,
// one still dimmed.
export const MidProgress: Story = {
  name: 'Mid-progress (2 of 4)',
  args: { beats: MID_BEATS, reducedMotion: false },
}

// Complete — every beat done, the silhouette fully materialised.
export const Complete: Story = {
  name: 'Complete (all done)',
  args: { beats: COMPLETE_BEATS, reducedMotion: false },
}

// Reduced motion — the same mid-progress snapshot with every transition dropped
// (the fill snaps to its proportion; rows swap state with no fade).
export const ReducedMotion: Story = {
  name: 'Reduced motion (mid-progress, no transitions)',
  args: { beats: MID_BEATS, reducedMotion: true },
}

// Narrow — the loadwrap at ~375px, confirming the figure + text column hold
// together (the text column is min-w-0, the figure a fixed base).
export const Narrow: Story = {
  name: 'Mobile (~375px)',
  render: (args) => (
    <div className="max-w-[375px]">
      <CharacterLoadingBeat {...args} />
    </div>
  ),
  args: { beats: MID_BEATS, reducedMotion: false },
}
