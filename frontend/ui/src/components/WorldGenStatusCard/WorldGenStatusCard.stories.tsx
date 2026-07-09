import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { WATCHED_ENTITY_STAGES } from '@mythrun/contract/events'
import { remainingWaitMs } from '@mythrun/client-core/worldgen'
import type { StageProgress } from '@mythrun/client-core/contract'
import { WorldGenStatusCard } from './WorldGenStatusCard.tsx'

// WorldGenStatusCard — the generation status/loading overlay pinned top-left of the
// graph pane during the VISIBLE WAIT of the graph act. Since the two-act cut, the
// pre-entity prep stretch (concept_intake / world_color / vocabulary_intake) lives in
// the WorldGenLoading screen; since the reveal-timing cut (MYT-89), the SILENT TAIL
// (entity_consolidation → embed_world) runs behind the wiki reveal — this card renders
// ONLY the watched entity stages (world_and_factions → entity_relationships): the
// current (running) stage's friendly label, a completed/3 percent, an optional
// per-second COUNTDOWN (MYT-89 waiting-feedback — the consumer ticks + formats the
// `~M:SS`; the Ticking specimen drives the REAL `remainingWaitMs` derivation through
// a scripted overrun so the hold + the completion jump are visible), and a
// PAPER-REGISTER segmented square bar of a FIXED 4 cells (one per canonical
// WATCHED_ENTITY_STAGES stage, known from frame one — the stream only advances the
// fills) whose running cell pulses (opacity fade — the brand's only sanctioned
// motion; NO spinner, NO circle). The bars hit 100% exactly at the wiki-reveal
// moment: the pulse stops and the bar rests full. Cost is NOT shown (the player
// never sees API spend). Every label is a `[ph:]` i18n key (the DS owns no copy).
// These specimens render it inside a mock graph pane so the `absolute` overlay pins
// correctly.

const meta: Meta<typeof WorldGenStatusCard> = {
  title: 'Patterns/WorldGenStatusCard',
  component: WorldGenStatusCard,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldGenStatusCard>

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// The canonical watched-entity act (the WATCHED_ENTITY_STAGES slice the card seeds
// its FIXED bars from), built at a chosen point of progress. Only the first `done`
// stages have appeared in the "stream" — the card fills the rest as pending from the
// taxonomy.
function stagesAt(done: number): StageProgress[] {
  return WATCHED_ENTITY_STAGES.slice(0, Math.min(done + 1, WATCHED_ENTITY_STAGES.length)).map(
    (id, i) => stage(id, i < done ? 'completed' : 'running'),
  )
}

// Friendly per-stage labels (i18n keys — the DS owns no copy). Watched entity stages
// only — the prep stages live on the loading screen and the silent tail has no bar.
const STAGE_LABELS: Record<string, string> = {
  world_and_factions: '[ph: raising the powers]',
  locations_and_npcs: '[ph: settling people and places]',
  entity_relationships: '[ph: drawing connections]',
}

// A mock graph pane (the `relative` host the overlay pins inside).
function Pane({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-dvh bg-bg p-[var(--space-6)]">
      <div className="relative aspect-[4/3] w-full max-w-[720px] border border-border bg-surface">
        {children}
      </div>
    </div>
  )
}

// --- The live countdown harness -------------------------------------------
// Drives the REAL `remainingWaitMs` derivation through a SCRIPTED stage
// timeline, so the three countdown behaviours are all visible in one sitting:
//   0–36s  world_and_factions runs against a 24s average → the count walks
//          1:12→0:48, then the stage OVERRUNS 12s: the count HOLDS at 0:48
//          (the remaining-future floor — never negative);
//  36–60s  the completion event lands → locations_and_npcs starts; the count
//          RESUMES walking 0:48→0:24 (a boundary jump, when it happens, is
//          deliberate);
//  60–90s  entity_relationships runs its 24s average with a 6s overrun → the
//          count walks 0:24→0:00 and holds there ("any moment now") until the
//          boundary completes — bars at 100%, the reveal moment. (In the app
//          the route swaps to the reveal at that instant; the specimen just
//          rests done.)

const DEMO_TIMINGS = [
  { stage: 'world_and_factions', avgMs: 24_000 },
  { stage: 'locations_and_npcs', avgMs: 24_000 },
  { stage: 'entity_relationships', avgMs: 24_000 },
] as const

/** The scripted ACTUAL spans (ms since demo start) — stage 1 overruns its 24s
 *  average by 12s, stage 3 by 6s. */
const DEMO_SPANS = [
  { stage: 'world_and_factions', start: 0, end: 36_000 },
  { stage: 'locations_and_npcs', start: 36_000, end: 60_000 },
  { stage: 'entity_relationships', start: 60_000, end: 90_000 },
] as const

function demoStagesAt(startMs: number, nowMs: number): StageProgress[] {
  const t = nowMs - startMs
  return DEMO_SPANS.filter((span) => t >= span.start).map((span) => ({
    stage: span.stage,
    status: t >= span.end ? ('completed' as const) : ('running' as const),
    userId: null,
    costUsd: 0,
    startedAt: new Date(startMs + span.start).toISOString(),
    completedAt: t >= span.end ? new Date(startMs + span.end).toISOString() : null,
  }))
}

/** Mirrors the app's `~M:SS` formatting (the words are i18n there; specimens
 *  hold placeholder copy). */
function formatCountdown(remainingMs: number | null): string | undefined {
  if (remainingMs === null) return undefined
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `[ph: ~${String(minutes)}:${String(seconds).padStart(2, '0')} left]`
}

function TickingDemo(): React.JSX.Element {
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
  const stages = demoStagesAt(startMs, nowMs)
  const countdownLabel = formatCountdown(remainingWaitMs(DEMO_TIMINGS, stages, nowMs))
  return (
    <Pane>
      <WorldGenStatusCard
        stages={stages}
        stageLabels={STAGE_LABELS}
        doneLabel="[ph: your world is ready]"
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
      />
    </Pane>
  )
}

// TICKING — the live countdown against the scripted overrun timeline above:
// per-second walk → the overrun HOLD → the completion jump → 100% at the reveal.
export const Ticking: Story = {
  render: () => <TickingDemo />,
}

// EARLY — the first entity stage running, nothing completed yet (the moment the
// player enters the graph). 4 bars from frame one; a single pulsing ember cell.
export const Early: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(0)}
        stageLabels={STAGE_LABELS}
        countdownLabel="[ph: ~4:12 left]"
      />
    </Pane>
  ),
}

// MID — some stages done, the boundary stage running (the graph is filling behind
// the overlay).
export const Mid: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(2)}
        stageLabels={STAGE_LABELS}
        countdownLabel="[ph: ~1:37 left]"
      />
    </Pane>
  ),
}

// NO ESTIMATE — cold-start (no history): the bars, but no "time left" line.
export const NoEstimate: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(1)} stageLabels={STAGE_LABELS} />
    </Pane>
  ),
}

// COMPLETE — every watched entity stage done: 100%, the done label, the pulse
// stopped, the bar full. This is the wiki-reveal moment — the silent tail keeps
// running behind the reveal, but the card's wait is over.
export const Complete: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(WATCHED_ENTITY_STAGES.length)}
        stageLabels={STAGE_LABELS}
        doneLabel="[ph: your world is ready]"
      />
    </Pane>
  ),
}

// FOOTER — the narrow-viewport variant (MYT-89 audit v2): on a phone the graph
// pane goes full-bleed and the status becomes this compact full-width bar at the
// bottom of the screen — one label + countdown + percent row over the same fixed
// square bars; no framing caption, no absolute pinning. The specimen mocks the
// phone anatomy: a full-bleed pane above, the footer flush at the fold.
export const Footer: Story = {
  render: () => (
    <div className="mx-auto flex h-dvh max-w-[375px] flex-col bg-bg">
      <div className="relative min-h-0 flex-1 bg-bg p-[var(--space-3)] font-ui text-xs text-ink-tertiary">
        [ph: the full-bleed graph pane]
      </div>
      <WorldGenStatusCard
        variant="footer"
        stages={stagesAt(1)}
        stageLabels={STAGE_LABELS}
        countdownLabel="[ph: ~3:41 left]"
      />
    </div>
  ),
}
