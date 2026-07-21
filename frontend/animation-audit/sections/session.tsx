import { useEffect, useState } from 'react'
import { SessionPreparing, SessionStartBeat, WorldGenLoading } from '@mythrun/ui'
import { remainingWaitMs } from '@mythrun/client-core/worldgen'
import type { StageProgress } from '@mythrun/client-core/contract'
import type { AuditSection } from '../types.ts'

// ── SessionStartBeat: the beat between pressing Start and the first DM token. The
//    1-bit tile fills from the base (ease-in acceleration) across two phases —
//    `prep` (partway) then `connecting` (full). Cycled here so the rise replays.
function StartBeatLoop({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const [phase, setPhase] = useState<'prep' | 'connecting'>('prep')
  useEffect(() => {
    const id = window.setInterval(() => {
      setPhase((p) => (p === 'prep' ? 'connecting' : 'prep'))
    }, 2600)
    return () => {
      window.clearInterval(id)
    }
  }, [])
  return (
    <div className="bg-bg p-[var(--space-6)]">
      <SessionStartBeat
        phase={phase}
        reducedMotion={reducedMotion}
        prepLabel="the DM is preparing tonight’s session…"
        connectingLabel="connecting to the table…"
      />
    </div>
  )
}

// ── WorldGenLoading: act-one of the generating flow — the DS Spinner (dither wave)
//    over a flavor line that shuffles every ~3s (internal) + a per-second countdown.
//    The live countdown harness is replicated verbatim from the story (drives the
//    real remainingWaitMs derivation). Reduced motion is read internally (matchMedia,
//    handled by the gallery's shim): spinner static, cycler frozen, countdown ticks.
const FLAVORS = Array.from({ length: 20 }, (_, i) => `[ph: worldgen flavor ${String(i + 1)}]`)
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

function formatCountdown(remainingMs: number | null): string | undefined {
  if (remainingMs === null) return undefined
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `[ph: ~${String(minutes)}:${String(seconds).padStart(2, '0')} left]`
}

function WorldGenLoadingLoop(): React.JSX.Element {
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
  const countdownLabel = formatCountdown(remainingWaitMs(DEMO_TIMINGS, demoStages(startMs), nowMs))
  return (
    <div className="flex h-full w-full items-center bg-bg">
      <WorldGenLoading
        flavorLabels={FLAVORS}
        spinnerLabel="[ph: making your world]"
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
        watchReady
        watchLabel="[ph: watch your world be born]"
        onWatch={() => undefined}
      />
    </div>
  )
}

export const sessionSections: AuditSection[] = [
  {
    id: 'worldgen-loading',
    name: 'WorldGenLoading — act-one loading',
    path: 'frontend/ui/src/components/WorldGenLoading',
    where: 'World generation, first ~2 min (before entities stream — precedes WorldGenGraph)',
    note: 'Spinner (dither wave) + a flavor line that shuffles every ~3s + a per-second countdown + the “watch your world be born” button. Reduced motion (internal matchMedia): spinner static, cycler frozen, countdown still ticks.',
    height: 320,
    render: ({ replayKey }) => (
      <div className="h-full w-full" style={{ height: 320 }}>
        <WorldGenLoadingLoop key={replayKey} />
      </div>
    ),
  },
  {
    id: 'session-start-beat',
    name: 'SessionStartBeat — start → first token',
    path: 'frontend/ui/src/components/SessionStartBeat',
    where: 'Between pressing Start and the first DM token (live session boot)',
    note: 'Full-width quantized meter: progress advances as a Bayer threshold-sweep front — hard cells, locked once filled, easing carried by variable dwell (4 decelerating frames per phase delta), front band alone shimmering at ~7fps between events. Cycled here so the advance replays. Reduced motion: position lands instantly, no ticks.',
    height: 200,
    render: ({ reducedMotion, replayKey }) => (
      <div className="h-full w-full bg-bg" style={{ height: 200 }}>
        <StartBeatLoop key={replayKey} reducedMotion={reducedMotion} />
      </div>
    ),
  },
  {
    id: 'session-preparing',
    name: 'SessionPreparing — between-sessions hold',
    path: 'frontend/ui/src/components/SessionPreparing',
    where: 'Play route when the next session isn’t startable yet (backoff-poll hold)',
    note: 'One unhurried line over a full-width 1-bit figure whose dither DENSITY breathes — a ~3.2s asymmetric (40/60) threshold sweep with diagonal phase offset, so the breath travels through the cells rather than pulsing in unison. No opacity anywhere. Reduced motion: a legible static frame.',
    height: 240,
    render: ({ reducedMotion, replayKey }) => (
      <div className="flex h-full w-full items-center bg-bg" style={{ height: 240 }}>
        <div className="w-full">
          <SessionPreparing
            key={replayKey}
            label="The DM is preparing the next session…"
            detail="This can take a moment."
            reducedMotion={reducedMotion}
          />
        </div>
      </div>
    ),
  },
]
