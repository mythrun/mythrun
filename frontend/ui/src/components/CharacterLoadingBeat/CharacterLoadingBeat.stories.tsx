import { useEffect, useState } from 'react'
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

// The resolved beat heading the shell supplies (real MYT-100 copy).
const HEADING = 'Bringing them to life…'

const meta: Meta<typeof CharacterLoadingBeat> = {
  title: 'Character/CharacterLoadingBeat',
  component: CharacterLoadingBeat,
  tags: ['autodocs'],
  // The heading is required chrome — supply it once at the meta level so every
  // specimen (and the `{...args}` renders) inherits it.
  args: { heading: HEADING },
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

// With the countdown — the quiet COARSE remaining-wait line under the ladder
// (MYT-102 timer revamp): minute-granular ("2 min remaining"), never a ticking
// `0:24`. The label arrives resolved from the consumer (the surface owns the
// tick + i18n); it is OMITTED entirely on cold-start, so the mid-progress story
// above doubles as the no-estimate specimen.
export const WithCountdown: Story = {
  name: 'With countdown (coarse)',
  args: { beats: MID_BEATS, reducedMotion: false, countdownLabel: '2 min remaining' },
}

// Stalled — the estimate exhausted (the running stage overran) so the countdown
// is swapped for the indeterminate "still working" line (MYT-102): the wait
// NEVER sits at a dead 0:00. Meaningful content (not aria-hidden), a calm
// secondary-ink line.
export const Stalled: Story = {
  name: 'Stalled (estimate exhausted)',
  args: {
    beats: MID_BEATS,
    reducedMotion: false,
    stalledLabel: "Still working. This one's taking a while.",
  },
}

// Reduced motion — the same mid-progress snapshot with every transition dropped
// (the fill snaps to its proportion; rungs swap state with no fade). The
// countdown still shows under reduced motion (content, not decoration) — shown
// here so the frozen fill + coarse estimate pairing has a specimen.
export const ReducedMotion: Story = {
  name: 'Reduced motion (mid-progress, no transitions)',
  args: { beats: MID_BEATS, reducedMotion: true, countdownLabel: '2 min remaining' },
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

// A self-driving demo: the beats advance pending → active → done on a timer, so each
// completion lands a decelerating quantized advance of the meter (and the active beat's
// presence shows in the front band's liveness). It loops back to the start. Production streams
// the beat states from the client-core view-model.
const BEAT_SEEDS = MID_BEATS.map((b) => ({ id: b.id, label: b.label }))

function beatsAt(done: number): LoadingBeat[] {
  return BEAT_SEEDS.map((b, i) => ({
    ...b,
    state: i < done ? 'done' : i === done ? 'active' : 'pending',
  }))
}

function LoadingDriver(): React.JSX.Element {
  // `done` runs 0…total; at `total` every beat is done (the meter full), then it resets.
  const [done, setDone] = useState(0)
  useEffect(() => {
    const atEnd = done >= BEAT_SEEDS.length
    const t = setTimeout(() => {
      setDone((n) => (n >= BEAT_SEEDS.length ? 0 : n + 1))
    }, atEnd ? 2200 : 1400)
    return () => {
      clearTimeout(t)
    }
  }, [done])
  return (
    <CharacterLoadingBeat
      heading={HEADING}
      beats={beatsAt(done)}
      reducedMotion={false}
      countdownLabel="2 min remaining"
    />
  )
}

export const Driving: Story = {
  name: 'Driving (demo advance)',
  render: () => <LoadingDriver />,
}
