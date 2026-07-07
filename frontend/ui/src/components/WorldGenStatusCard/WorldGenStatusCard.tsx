import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import { WATCHED_ENTITY_STAGES } from '@mythrun/contract/events'
import type { StageProgress, WorldGenStatusCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// WorldGenStatusCard (MYT-89 Phase C, C4 + audit ③/⑥ + the two-act cut + reveal
// timing) — a DOM overlay pinned top-left of the graph pane so the visible wait reads
// as PROGRESS, not a hang. It shows: the current (running) stage's friendly label, a
// completed/total percent, an optional data-driven "time left", and a PAPER-REGISTER
// working indicator.
//
// The working indicator IS the percent bar: a segmented SQUARE bar with a FIXED count —
// one cell per canonical `WATCHED_ENTITY_STAGES` stage (all known from frame one, NOT
// grown one bar per stream stage; audit ③). The PREP stages (concept_intake /
// world_color / vocabulary_intake) are NOT bars here — the two-act flow shows the
// WorldGenLoading screen for that stretch — and neither are the SILENT TAIL stages
// (entity_consolidation → embed_world): the visible wait ends at the wiki-reveal
// boundary (entity_relationships), so the bars hit 100% exactly at the moment the
// route fires the reveal (a card that kept counting the tail would vanish at ~62%). A
// prep or tail entry in the stream's `stages[]` is simply ignored. The stream only
// ADVANCES each cell's fill: completed cells solid ink, the running cell ember +
// `animate-pulse` (an opacity fade, the brand's ONLY sanctioned motion — §4), and a
// stage not yet seen in the stream a faint pending track. NO circle, NO spinner, NO
// dots (hard brand rule). Percent is `completedCount / TOTAL_STAGES` (fixed
// watched-entity denominator). At 100% no cell is running, so the pulse stops and the
// bar rests full. Colour is never the sole signal: the running cell is distinct by
// fill (ember) even with motion reduced, and the label/percent/progressbar aria carry
// the meaning.
//
// Cost is NOT rendered (audit ⑥): the player never sees API spend; the dev ticker owns
// cost. The card self-positions `absolute` inside its host pane (documented on the
// contract), is `pointer-events-none` (a readout, never intercepting graph
// interaction), and caps its width so it fits a ~375px pane without overflow.

const TOTAL_STAGES = WATCHED_ENTITY_STAGES.length // 3 — the FIXED bar count + % denominator

const CARD_CLASS = cn(
  'pointer-events-none absolute left-[var(--space-3)] top-[var(--space-3)] z-10',
  'flex max-w-[16rem] flex-col gap-[var(--space-2)]',
  'rounded-none border border-border-strong bg-surface-overlay',
  'p-[var(--space-3)]',
)
const TITLE_CLASS = 'font-ui text-xs text-ink-tertiary leading-none'
const ROW_CLASS = 'flex items-baseline justify-between gap-[var(--space-2)]'
const LABEL_CLASS = 'font-body text-sm font-medium text-ink leading-[1.3] min-w-0'
const PERCENT_CLASS = 'font-ui text-xs tabular-nums text-ink-secondary shrink-0'
const BAR_CLASS = 'flex h-[6px] w-full gap-[2px]'
const ETA_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary leading-none'

// Per-cell fill: solid ink = done, ember + pulse = the working cell, faint track =
// pending. Square (0px radius), full-height, equal-width segments.
const cell = cva('h-full flex-1 rounded-none', {
  variants: {
    state: {
      completed: 'bg-ink',
      running: 'bg-accent animate-pulse',
      pending: 'bg-surface-active',
    },
  },
})

type CellState = 'completed' | 'running' | 'pending'

/** A stage's cell state. `failed` renders as a plain (pending-style) track — the
 *  failure/retry surface lives elsewhere (the loading screen), not in this readout. */
function cellState(status: StageProgress['status']): CellState {
  if (status === 'completed') return 'completed'
  if (status === 'running') return 'running'
  return 'pending'
}

/** Resolve a stage id to its consumer-supplied friendly label, else a `[ph:]`
 *  placeholder (the DS owns no copy). */
function resolveStageLabel(stage: string, stageLabels?: Readonly<Record<string, string>>): string {
  return stageLabels?.[stage] ?? `[ph: ${stage}]`
}

/** One of the FIXED watched-entity bars: its canonical stage id + the fill state
 *  derived from the matching stream entry (or `pending` when the stream hasn't
 *  reached it). */
interface Bar {
  readonly stage: string
  readonly state: CellState
}

interface Progress {
  readonly bars: readonly Bar[]
  readonly completed: number
  readonly percent: number
  /** The canonical stage id currently running (from the stream), if any. */
  readonly running: string | undefined
  readonly isComplete: boolean
}

/** Seed the FIXED bars from the `WATCHED_ENTITY_STAGES` taxonomy (known from frame
 *  one) and advance each cell's fill from its matching stream entry — a PREP or
 *  silent-TAIL stage in the stream matches no bar, so it is ignored. Percent is
 *  `completedCount / TOTAL_STAGES` — a fixed watched-entity denominator, never the
 *  growing stream length; it reaches 100% exactly at the wiki-reveal moment. */
function computeProgress(stages: readonly StageProgress[]): Progress {
  const statusByStage = new Map(stages.map((s) => [s.stage, s.status]))
  const bars: Bar[] = WATCHED_ENTITY_STAGES.map((stage) => ({
    stage,
    state: cellState(statusByStage.get(stage) ?? 'pending'),
  }))
  const completed = bars.filter((b) => b.state === 'completed').length
  const percent = Math.round((completed / TOTAL_STAGES) * 100)
  const running = bars.find((b) => b.state === 'running')?.stage
  return { bars, completed, percent, running, isComplete: completed === TOTAL_STAGES }
}

export const WorldGenStatusCard = forwardRef<HTMLDivElement, WorldGenStatusCardProps>(
  function WorldGenStatusCard(
    {
      stages,
      etaLabel,
      stageLabels,
      titleLabel = '[ph: weaving your world]',
      doneLabel = '[ph: your world is ready]',
      progressLabel = '[ph: world generation progress]',
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const { bars, percent, running, isComplete } = computeProgress(stages)

    // The main line: the running stage while generating, the done label at 100%, else
    // the first not-yet-complete canonical stage (a brief lull between stages, or the
    // pre-first-frame state where the stream is still empty).
    const nextIncomplete = bars.find((b) => b.state !== 'completed')?.stage
    const currentLabel = running
      ? resolveStageLabel(running, stageLabels)
      : isComplete
        ? doneLabel
        : nextIncomplete !== undefined
          ? resolveStageLabel(nextIncomplete, stageLabels)
          : doneLabel
    const percentText = `${String(percent)}%`

    return (
      <div
        ref={ref}
        {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
        className={CARD_CLASS}
      >
        <span className={TITLE_CLASS}>{titleLabel}</span>
        <div className={ROW_CLASS}>
          <span className={LABEL_CLASS}>{currentLabel}</span>
          <span className={PERCENT_CLASS}>{percentText}</span>
        </div>
        <div
          role="progressbar"
          aria-label={progressLabel}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${currentLabel} — ${percentText}`}
          data-testid="worldgen-status-bar"
          className={BAR_CLASS}
        >
          {bars.map((b) => (
            <span
              key={b.stage}
              aria-hidden="true"
              data-cell-state={b.state}
              className={cn(cell({ state: b.state }))}
            />
          ))}
        </div>
        {etaLabel !== undefined && <span className={ETA_CLASS}>{etaLabel}</span>}
      </div>
    )
  },
)
