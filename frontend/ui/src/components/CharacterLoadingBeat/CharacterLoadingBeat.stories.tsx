import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { CharacterLoadingBeat } from './CharacterLoadingBeat.tsx'

// CharacterLoadingBeat — the "coming into being" beat that holds the screen while
// the pipeline generates the character sheet. Since ux-run2 (myth-8ddt4 +
// myth-zyk6o): a TYPOGRAPHIC ladder (no bordered "button-cosplay" rows) with
// three states — done = leading filled accent square + quiet accent label,
// ACTIVE = emphasized ink + ellipsis, pending = dimmed — over the quantized
// figure, which BREATHES until the first beat lands (never an empty fill frame)
// and wears the panel-weight muted frame. The panel caps near 600px; the coarse
// estimate sits label·value on the kicker row. Pure/presentational: the
// specimens hand it fixed `beats` snapshots; the real stage copy below is
// praise-ledger (reused verbatim).

const MID_BEATS: LoadingBeat[] = [
  { id: 'name', label: 'A name surfaces', state: 'done' },
  { id: 'class', label: 'A calling takes shape', state: 'done' },
  { id: 'scores', label: 'Ability scores settle', state: 'active' },
  { id: 'kit', label: 'Equipment is gathered', state: 'pending' },
]

// Fresh entry — nothing done yet: the ladder all-pending and the figure in its
// faint IDLE shimmer (ux-run3 myth-c96rf: nearly blank, poised at the fill's
// origin — emptier than any accretion state, yet never a dead empty rectangle).
const FRESH_BEATS: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'pending' }))

const COMPLETE_BEATS: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'done' }))

// The resolved kicker the shell supplies — the factual stage counter (ux-run3
// myth-1yxfr; the old "Bringing them to life…" eyebrow doubled the screen H1
// and carried a second live ellipsis).
const HEADING = 'Stage 3 of 4'

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

// Fresh — zero progress: the faint idle shimmer (nearly blank, poised at the
// fill's origin — ux-run3 myth-c96rf), all-pending ladder.
export const Fresh: Story = {
  name: 'Fresh (0 of 4 — idle shimmer)',
  args: { beats: FRESH_BEATS, reducedMotion: false },
}

// Mid-progress — two beats done (quiet accent + filled squares), one active
// (ink emphasis + ellipsis), one still dimmed.
export const MidProgress: Story = {
  name: 'Mid-progress (2 of 4)',
  args: { beats: MID_BEATS, reducedMotion: false },
}

// Complete — every beat done, the silhouette fully materialised.
export const Complete: Story = {
  name: 'Complete (all done)',
  args: { beats: COMPLETE_BEATS, reducedMotion: false },
}

// With the countdown — the quiet COARSE estimate seated label·value on the
// kicker row (ux-run2 myth-8ddt4 — never floating attached to nothing):
// minute-granular ("Ready in about 2 min"), never a ticking `0:24`. The label
// arrives resolved from the consumer (the surface owns the tick + i18n); it is
// OMITTED entirely on cold-start, so the mid-progress story above doubles as
// the no-estimate specimen.
export const WithCountdown: Story = {
  name: 'With countdown (coarse)',
  args: { beats: MID_BEATS, reducedMotion: false, countdownLabel: 'Ready in about 2 min' },
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
  args: { beats: MID_BEATS, reducedMotion: true, countdownLabel: 'Ready in about 2 min' },
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
      countdownLabel="Ready in about 2 min"
    />
  )
}

export const Driving: Story = {
  name: 'Driving (demo advance)',
  render: () => <LoadingDriver />,
}
