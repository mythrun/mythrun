import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { remainingWaitMs } from '@mythrun/client-core/worldgen'
import type { StageProgress } from '@mythrun/client-core/contract'
import { WorldGenLoading } from './WorldGenLoading.tsx'

// WorldGenLoading — act ONE of the two-act generating flow. While the prep stages
// (concept_intake → world_color → vocabulary_intake, the first ~2 minutes) run,
// there is nothing to draw — so the player gets the DS Spinner (the brand dither
// wave) over a flavor line cycling twenty short playful loading messages every
// ~3s in RANDOM order (MYT-89 waiting-feedback: a shuffled permutation, every
// line once before any repeats, no back-to-back repeat across the reshuffle; a
// hard swap — no animated transition), plus the per-second `~M:SS` COUNTDOWN to
// the wiki reveal (consumer-ticked — the LiveCountdown specimen drives the real
// `remainingWaitMs` derivation so the number visibly walks). When entities start
// streaming, the "watch your world be born" watch button appears: generation
// keeps running regardless; pressing it swaps the route to the graph view. Every
// string is a `[ph:]` i18n key (the DS owns no copy). Under
// prefers-reduced-motion the Spinner goes static and the cycler freezes on its
// opening line — the countdown still ticks (content, not decoration).

const meta: Meta<typeof WorldGenLoading> = {
  title: 'Patterns/WorldGenLoading',
  component: WorldGenLoading,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenLoading>

// The full twenty-line catalog the generating route threads through (Miklos
// writes the real copy later) — the shuffle needs the real breadth to show.
const FLAVORS = Array.from({ length: 20 }, (_, i) => `[ph: worldgen flavor ${String(i + 1)}]`)

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

/** Format the remaining ms as the `[ph:]` countdown line (mirrors the app's
 *  `~M:SS` formatting — the words are i18n there; specimens hold placeholder). */
function formatCountdown(remainingMs: number | null): string | undefined {
  if (remainingMs === null) return undefined
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `[ph: ~${String(minutes)}:${String(seconds).padStart(2, '0')} left]`
}

function LiveCountdownDemo({ watchReady = false }: { watchReady?: boolean }): React.JSX.Element {
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
        spinnerLabel="[ph: making your world]"
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
        watchReady={watchReady}
        watchLabel="[ph: watch your world be born]"
        onWatch={() => {
          /* the route swaps to the graph view */
        }}
      />
    </div>
  )
}

// PREP — the pure act-one state: the Spinner + the randomly-cycling flavor line +
// the live per-second countdown, no button. Watch the line shuffle every ~3
// seconds and the number walk down every second.
export const Prep: Story = {
  render: () => <LiveCountdownDemo />,
}

// WATCH READY — entities have started streaming: the "watch your world be born"
// button appears (the deliberate beat). The flavor line keeps cycling and the
// countdown keeps walking — generation runs regardless; the button only swaps
// the view.
export const WatchReady: Story = {
  render: () => <LiveCountdownDemo watchReady />,
}

// COLD START — no timings history yet (a fresh deployment): no countdown line,
// the surface degrades gracefully to the Spinner + flavor cycle.
export const ColdStart: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading flavorLabels={FLAVORS} spinnerLabel="[ph: making your world]" />
    </div>
  ),
}

// SINGLE LINE — one flavor label: nothing to cycle, the line just holds.
export const SingleLine: Story = {
  render: () => (
    <div className="min-h-dvh bg-bg">
      <WorldGenLoading
        flavorLabels={['[ph: worldgen flavor 1]']}
        spinnerLabel="[ph: making your world]"
      />
    </div>
  ),
}
