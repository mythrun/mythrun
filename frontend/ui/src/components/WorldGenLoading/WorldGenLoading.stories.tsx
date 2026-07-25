import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { remainingWaitMs } from '@mythrun/client-core/worldgen'
import type { StageProgress } from '@mythrun/client-core/contract'
import { WorldGenLoading } from './WorldGenLoading.tsx'

// WorldGenLoading — act ONE of the two-act generating flow (reworked for
// ux-run2 myth-i2pdo + myth-xe38q). The calm wait: an ACCRETING ~96px dither
// mark (quantized fill driven by real-event `accretion`; ambient breathe at 0 —
// never an empty frame) over a whisper line at headline scale (~20px) cycling
// twenty short playful loading messages every ~10s in RANDOM order (a shuffled
// permutation, every line once before any repeats, no back-to-back repeat
// across the reshuffle), past whispers settling beneath as a faint LEDGER — the
// growing list is the progress texture. Below, the COARSE aggregate countdown
// ("Ready in about N min" — one monotonic budget shared with the live-map
// status card; the stalled line stands in on exhaustion), and one quiet mono
// line of permission to leave. When entities start streaming, the "watch your
// world be born" button appears: generation keeps running regardless; pressing
// it swaps the route to the graph view. Every string arrives resolved from the
// shell (the DS owns no copy); these specimens use the real copy. Under
// prefers-reduced-motion the mark stills and the cycler freezes on its opening
// line (empty ledger) — the countdown still updates (content, not decoration).

const meta: Meta<typeof WorldGenLoading> = {
  title: 'Patterns/WorldGenLoading',
  component: WorldGenLoading,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenLoading>

// The full twenty-line catalog the generating route threads through (the real
// MYT-100 copy, worldGen.flavor1–20) — the shuffle needs the real breadth to show.
const FLAVORS = [
  'The gods decide what to name themselves.',
  'History fades into mythology.',
  'The spark of magic enters the world.',
  'Waters spring forth.',
  'A landscape is carved into shape.',
  'A creature notices its own thoughts.',
  'Populations spill across the world.',
  'Somewhere, a people decides that they are a people.',
  'A calendar is scrawled across the seasons.',
  'The first law is made and then broken.',
  'Languages find their words.',
  'Ink is put to page.',
  'Invisible borders snake across the land.',
  'A song is sung for the first time.',
  'The stars are grouped into stories.',
  'Music finds its first instrument.',
  'A throne is carved that will outlast its king.',
  'The first grave is marked.',
  'A gift is given.',
  "The world's name is spoken aloud.",
]

// The resolved watch-button label the shell supplies (real MYT-100 copy, worldGen.watch).
const WATCH = 'Watch it take shape'
// The resolved mark SR label (real MYT-100 copy, worldGen.loadingLabel).
const SPINNER = 'Making your world'
// The permission-to-leave line (real copy, worldGen.safeToLeave).
const LEAVE = 'Safe to leave. The world keeps forming.'

// --- The live countdown harness -------------------------------------------
// Drives the REAL derivation the app uses: historical per-stage averages ∩ a
// live prep-stage fixture, re-derived every second from the wall clock — the
// same walk the player sees (concept_intake runs from mount against a 90s
// average, with world_color's 45s still ahead → opens at ~2:15 and ticks down).

const DEMO_TIMINGS = [
  { stage: 'concept_intake', avgMs: 90_000 },
  { stage: 'world_color', avgMs: 45_000 },
] as const

function demoStages(startMs: number): StageProgress[] {
  return [
    {
      stage: 'concept_intake',
      status: 'running',
      userId: null,
      costUsd: 0,
      startedAt: new Date(startMs).toISOString(),
      completedAt: null,
    },
  ]
}

/** Format the remaining ms as the COARSE countdown line (mirrors the app's
 *  register — minute-granular "Ready in about N min" / "Ready in under a
 *  minute", never a ticking `M:SS`; the words are resolved i18n in the app,
 *  specimens use the same shape). Returns undefined when the estimate exhausts
 *  (remaining ≤ 0) — the app swaps in the stalled line there. */
function formatCountdown(remainingMs: number | null): string | undefined {
  if (remainingMs === null || remainingMs <= 0) return undefined
  const time =
    remainingMs < 60_000 ? 'under a minute' : `about ${String(Math.max(1, Math.round(remainingMs / 60_000)))} min`
  return `Ready in ${time}`
}

function LiveCountdownDemo({
  watchReady = false,
  accretion = 0,
}: {
  watchReady?: boolean
  accretion?: number
}): React.JSX.Element {
  const [startMs] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(startMs)
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(id)
    }
  }, [])
  const countdownLabel = formatCountdown(
    remainingWaitMs(DEMO_TIMINGS, demoStages(startMs), nowMs),
  )
  return (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel={SPINNER}
        accretion={accretion}
        leaveLabel={LEAVE}
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
        watchReady={watchReady}
        watchLabel={WATCH}
        onWatch={() => {
          /* the route swaps to the graph view */
        }}
      />
    </div>
  )
}

// PREP — the fresh act-one state: the mark BREATHING (zero accretion — nothing
// has landed yet), the whisper cycling, the live coarse countdown, the leave
// line. Watch the whispers settle into the ledger every ~10s.
export const Prep: Story = {
  render: () => <LiveCountdownDemo />,
}

// ACCRETING — real events have landed (a third of the expected total): the mark
// runs its quantized fill. Structural resolution means work happened.
export const Accreting: Story = {
  render: () => <LiveCountdownDemo accretion={0.35} />,
}

// WATCH READY — entities have started streaming: the "watch your world be born"
// button appears (the deliberate beat). The whispers keep cycling and the
// countdown keeps walking — generation runs regardless; the button only swaps
// the view.
export const WatchReady: Story = {
  render: () => <LiveCountdownDemo watchReady accretion={0.2} />,
}

// STALLED — the estimate exhausted: the stalled reassurance stands in for the
// number (degrade in language, never a frozen floor — ux-run2 myth-uz1bn).
export const Stalled: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel={SPINNER}
        accretion={0.6}
        leaveLabel={LEAVE}
        stalledLabel="Still working. This is taking longer than usual."
        watchLabel={WATCH}
      />
    </div>
  ),
}

// COLD START — no timings history yet (a fresh deployment): no countdown line,
// the surface degrades gracefully to the mark + whisper cycle.
export const ColdStart: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading flavorLabels={FLAVORS} spinnerLabel={SPINNER} leaveLabel={LEAVE} watchLabel={WATCH} />
    </div>
  ),
}

// SINGLE LINE — one flavor label: nothing to cycle, the line just holds.
export const SingleLine: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading
        flavorLabels={['The gods decide what to name themselves.']}
        spinnerLabel={SPINNER}
        watchLabel={WATCH}
      />
    </div>
  ),
}
