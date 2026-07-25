import { useEffect, useRef, useState } from 'react'
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
// ONLY the watched entity stages (world_and_factions → world_introduction): the
// current (running) stage's friendly label WITH ITS SCOPE composed in by the shell
// ("Stage 2 of 4 · …", ux-run2 myth-uz1bn — stage scope and overall time must never
// conflate), an optional COARSE overall countdown ("Ready in about 4 min" — the
// consumer derives ONE aggregate monotonic budget and swaps in the stalled line the
// instant it exhausts; the Ticking specimen drives the REAL `remainingWaitMs`
// derivation through a scripted overrun so the hold + the stalled handoff are
// visible), an optional quiet RETURN link back to the calm wait (myth-t11az), and a
// PAPER-REGISTER segmented square bar of a FIXED 4 cells (one per canonical
// WATCHED_ENTITY_STAGES stage, known from frame one — the stream only advances the
// fills) whose running cell pulses (opacity fade — the brand's only sanctioned
// motion; NO spinner, NO circle). NO percent numeral (myth-uz1bn — the bars + the
// stage line carry progress; percent lives in the progressbar aria only). The bars
// rest full exactly at the wiki-reveal moment. Cost is NOT shown. Every label
// arrives resolved from the shell (the DS owns no copy); these specimens use the
// real copy. They render inside a mock graph pane so the `absolute` overlay pins
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

// Friendly per-stage labels (resolved copy — the DS owns none), scope composed in
// exactly the way the shell does since ux-run2 myth-uz1bn: the watched-entity
// position framed as "Stage N of 4 · <label>" so the line can never read as
// overall progress.
const STAGE_LABELS: Record<string, string> = {
  world_and_factions: 'Stage 1 of 4 · Creating regions and factions',
  locations_and_npcs: 'Stage 2 of 4 · Settling people and places',
  entity_relationships: 'Stage 3 of 4 · Drawing the connections',
  world_introduction: 'Stage 4 of 4 · Writing the opening pages',
}

// The card's resolved chrome labels the shell supplies (real copy).
const CARD_LABELS = {
  titleLabel: 'Weaving your world',
  doneLabel: 'Your world is ready',
  progressLabel: 'World generation progress',
}

// The quiet way back to the calm wait (myth-t11az) — the shell flips the act.
const RETURN_PROPS = {
  returnLabel: 'Wait quietly instead',
  onReturn: (): void => undefined,
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
// timeline, folded through the same monotonic min-clamp the app applies, so the
// countdown behaviours are all visible in one sitting:
//   0–36s  world_and_factions runs against a 24s average → "Ready in about
//          1 min", then "Ready in under a minute"; the stage OVERRUNS 12s — the
//          coarse label HOLDS (never climbs);
//  36–60s  the completion event lands → locations_and_npcs starts and the walk
//          resumes;
//  60–90s  world_introduction overruns to exhaustion → the STALLED line stands
//          in for the number (degrade in language, never a frozen floor), until
//          the boundary completes — bars full, the reveal moment.

const DEMO_TIMINGS = [
  { stage: 'world_and_factions', avgMs: 24_000 },
  { stage: 'locations_and_npcs', avgMs: 24_000 },
  { stage: 'entity_relationships', avgMs: 12_000 },
  { stage: 'world_introduction', avgMs: 12_000 },
] as const

/** The scripted ACTUAL spans (ms since demo start) — stage 1 overruns its 24s
 *  average by 12s, the boundary stage by 12s. */
const DEMO_SPANS = [
  { stage: 'world_and_factions', start: 0, end: 36_000 },
  { stage: 'locations_and_npcs', start: 36_000, end: 60_000 },
  { stage: 'entity_relationships', start: 60_000, end: 72_000 },
  { stage: 'world_introduction', start: 72_000, end: 96_000 },
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

/** Mirrors the app's coarse label register (the words are resolved i18n in the
 *  app; specimens use the same shape): minute-granular "Ready in about N min" /
 *  "Ready in under a minute", never a ticking M:SS; `undefined` on exhaustion
 *  (the stalled line stands in) or no history. */
function formatCoarse(remainingMs: number | null): string | undefined {
  if (remainingMs === null || remainingMs <= 0) return undefined
  if (remainingMs < 60_000) return 'Ready in under a minute'
  return `Ready in about ${String(Math.max(1, Math.round(remainingMs / 60_000)))} min`
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
  // The app's monotonic fold (clampEtaMonotonic): shown = min(new, lastShown).
  const lastShownRef = useRef<number | null>(null)
  const raw = remainingWaitMs(DEMO_TIMINGS, stages, nowMs)
  const shown = raw === null ? null : Math.min(raw, lastShownRef.current ?? raw)
  lastShownRef.current = shown ?? lastShownRef.current
  const countdownLabel = formatCoarse(shown)
  const done = stages.filter((s) => s.status === 'completed').length >= DEMO_SPANS.length
  const stalled = !done && shown !== null && shown <= 0
  return (
    <Pane>
      <WorldGenStatusCard
        stages={stages}
        stageLabels={STAGE_LABELS}
        {...CARD_LABELS}
        {...RETURN_PROPS}
        {...(countdownLabel !== undefined ? { countdownLabel } : {})}
        {...(stalled ? { stalledLabel: 'Still working. This is taking longer than usual.' } : {})}
      />
    </Pane>
  )
}

// TICKING — the live countdown against the scripted overrun timeline above:
// the coarse walk → the overrun HOLD (monotonic) → the stalled handoff → bars
// full at the reveal.
export const Ticking: Story = {
  render: () => <TickingDemo />,
}

// EARLY — the first entity stage running, nothing completed yet (the moment the
// player enters the graph). 4 bars from frame one; a single pulsing ember cell;
// the stage line carries its scope; the overall countdown reads as overall.
export const Early: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(0)}
        stageLabels={STAGE_LABELS}
        {...CARD_LABELS}
        {...RETURN_PROPS}
        countdownLabel="Ready in about 6 min"
      />
    </Pane>
  ),
}

// MID — some stages done, a later stage running (the graph is filling behind
// the overlay).
export const Mid: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(2)}
        stageLabels={STAGE_LABELS}
        {...CARD_LABELS}
        {...RETURN_PROPS}
        countdownLabel="Ready in about 2 min"
      />
    </Pane>
  ),
}

// STALLED — the estimate exhausted mid-stage: the number is gone and the calm
// reassurance stands in (ux-run2 myth-uz1bn — a frozen "50%" / dead floor never
// sits again).
export const Stalled: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(2)}
        stageLabels={STAGE_LABELS}
        {...CARD_LABELS}
        {...RETURN_PROPS}
        stalledLabel="Still working. This is taking longer than usual."
      />
    </Pane>
  ),
}

// NO ESTIMATE — cold-start (no history): the bars, but no "time left" line.
export const NoEstimate: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard stages={stagesAt(1)} stageLabels={STAGE_LABELS} {...CARD_LABELS} {...RETURN_PROPS} />
    </Pane>
  ),
}

// COMPLETE — every watched entity stage done: the done label, the pulse
// stopped, the bar full. This is the wiki-reveal moment — the silent tail keeps
// running behind the reveal, but the card's wait is over (no return link — the
// route swaps to the reveal here).
export const Complete: Story = {
  render: () => (
    <Pane>
      <WorldGenStatusCard
        stages={stagesAt(WATCHED_ENTITY_STAGES.length)}
        stageLabels={STAGE_LABELS}
        {...CARD_LABELS}
      />
    </Pane>
  ),
}

// FOOTER — the narrow-viewport variant (MYT-89 audit v2): on a phone the graph
// pane goes full-bleed and the status becomes this compact full-width bar at the
// bottom of the screen — one stage-line + countdown row over the same fixed
// square bars; no framing caption, no absolute pinning, no percent numeral. The
// specimen mocks the phone anatomy: a full-bleed pane above, the footer flush at
// the fold.
export const Footer: Story = {
  render: () => (
    <div className="mx-auto flex h-dvh max-w-[375px] flex-col bg-bg">
      <div className="relative min-h-0 flex-1 bg-bg p-[var(--space-3)] font-ui text-xs text-ink-tertiary">
        the full-bleed graph pane
      </div>
      <WorldGenStatusCard
        variant="footer"
        stages={stagesAt(1)}
        stageLabels={STAGE_LABELS}
        {...CARD_LABELS}
        {...RETURN_PROPS}
        countdownLabel="Ready in about 4 min"
      />
    </div>
  ),
}
