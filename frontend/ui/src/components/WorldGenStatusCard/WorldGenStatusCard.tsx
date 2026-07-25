import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import { WATCHED_ENTITY_STAGES } from '@mythrun/contract/events'
import type { StageProgress, WorldGenStatusCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// WorldGenStatusCard (MYT-89 Phase C, C4 + audit ③/⑥ + the two-act cut + reveal
// timing + waiting-feedback; ux-run2 myth-uz1bn + myth-t11az) — a DOM overlay
// pinned top-left of the graph pane so the visible wait reads as PROGRESS, not a
// hang. It shows: the current (running) stage's friendly label (the consumer
// composes any stage-scope framing, e.g. "Stage 2 of 4 · …", into the label —
// the DS owns no copy), an optional COUNTDOWN or its stalled stand-in, an
// optional quiet RETURN link, and a PAPER-REGISTER working indicator.
//
// THE COUNTDOWN (MYT-102 coarse buckets + ux-run2 myth-uz1bn): `countdownLabel`
// is the consumer-supplied coarse overall estimate ("Ready in about 4 min") —
// the consumer owns the tick, the aggregate derivation, and the MONOTONIC clamp
// (the shown number never climbs; see client-core `clampEtaMonotonic`). This
// card only RENDERS the string — a quiet mono/tabular line, no urgency
// theatrics. aria-hidden: a churning line would be live-region noise — the
// determinate progressbar (label + valuetext) carries the progress semantics to
// AT. It still updates under reduced motion: the number is CONTENT (the
// remaining wait), not decoration. `stalledLabel` is the degrade-in-language
// stand-in the consumer swaps in the instant the estimate exhausts — a frozen
// number never sits; the card shows at most one of the two (countdown wins,
// defensively).
//
// NO PERCENT NUMERAL (ux-run2 myth-uz1bn): run 2 rendered "0%" over six named
// markers already on the canvas, froze "50%" for ~90s, and let the numeral
// contradict the bar fill. The numeral is gone — the segmented bars + the stage
// line carry within-wait progress; percent lives only in the progressbar's
// machine values (aria-valuenow).
//
// THE RETURN LINK (ux-run2 myth-t11az): once "Watch it take shape" was clicked
// nothing offered a way back to the calm wait — a one-way door. `returnLabel` +
// `onReturn` render a quiet mono text link under the readout; the card is
// `pointer-events-none` chrome, so the link alone re-enables pointer events.
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
//
// TWO VARIANTS (MYT-89 audit v2 — the mobile full-bleed fix). `overlay` (default)
// is everything above. `footer` is the narrow-viewport treatment WorldGenGraph
// selects on phone-class viewports: the pane goes full-bleed, so the status leaves
// the canvas and becomes a compact full-width IN-FLOW bar below it — the SAME
// substance (running-stage label, percent, fixed bars, countdown) in one
// label+readout row over the bars, minus the framing caption (compactness is the
// point: the footer reclaims real estate, it doesn't relocate the card verbatim).

const TOTAL_STAGES = WATCHED_ENTITY_STAGES.length // 3 — the FIXED bar count + % denominator

const CARD_CLASS = cn(
  'pointer-events-none absolute left-[var(--space-3)] top-[var(--space-3)] z-10',
  'flex max-w-[16rem] flex-col gap-[var(--space-2)]',
  'rounded-none border border-border-strong bg-surface-overlay',
  'p-[var(--space-3)]',
)
// The FOOTER variant (MYT-89 audit v2 — the mobile full-bleed fix): a compact
// full-width IN-FLOW bar the graph places below the pane on narrow viewports.
// Same paper vocabulary (square bars, ember cell, mono readouts), no absolute
// positioning (it is page chrome, not an overlay), a top rule instead of the
// card border, and no framing caption — one label+readout row over the bars.
const FOOTER_CLASS = cn(
  'flex w-full min-w-0 shrink-0 flex-col gap-[var(--space-2)]',
  'rounded-none border-t border-border-strong bg-surface-overlay',
  'px-[var(--space-4)] py-[var(--space-3)]',
)
// The footer's single readout row: the running-stage label absorbs the shrink
// (truncate), the countdown + percent hold their width on the right.
const FOOTER_ROW_CLASS = 'flex items-baseline gap-[var(--space-3)]'
const TITLE_CLASS = 'font-ui text-xs text-ink-tertiary leading-none'
const LABEL_CLASS = 'font-body text-sm font-medium text-ink leading-[1.3] min-w-0'
const BAR_CLASS = 'flex h-[6px] w-full gap-[2px]'
// The countdown: quiet mono/tabular, paper register — mirrors the loading
// screen's countdown line so the two waiting surfaces read as one voice.
const COUNTDOWN_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary leading-none'
// The stalled stand-in — real reassurance content (not per-second churn): a calm
// secondary-ink line, a touch more present than the countdown, never loud.
const STALLED_CLASS = 'font-body text-sm text-ink-secondary leading-[1.4]'
// The return link (myth-t11az): a quiet mono text link back to the calm wait.
// The card is pointer-transparent chrome, so the link re-enables its own pointer
// events; self-start keeps its hit target to the text, not the card width.
const RETURN_CLASS = cn(
  'pointer-events-auto self-start cursor-pointer appearance-none border-0 bg-transparent p-0',
  'font-ui text-xs text-ink-secondary underline underline-offset-2',
)

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

/** Resolve a stage id to its consumer-supplied friendly label, else the card's
 *  generic running caption (`fallback` = `titleLabel`). With the full stage map
 *  supplied the fallback is defensive only — the DS owns no copy, so it never
 *  invents a placeholder. */
function resolveStageLabel(
  stage: string,
  fallback: string,
  stageLabels?: Readonly<Record<string, string>>,
): string {
  return stageLabels?.[stage] ?? fallback
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

/** The main line: the running stage while generating, the done label at 100%, else
 *  the first not-yet-complete canonical stage (a brief lull between stages, or the
 *  pre-first-frame state where the stream is still empty). */
function currentLabelFrom(
  progress: Progress,
  doneLabel: string,
  titleLabel: string,
  stageLabels?: Readonly<Record<string, string>>,
): string {
  const { bars, running, isComplete } = progress
  if (running !== undefined) return resolveStageLabel(running, titleLabel, stageLabels)
  if (isComplete) return doneLabel
  const nextIncomplete = bars.find((b) => b.state !== 'completed')?.stage
  return nextIncomplete !== undefined ? resolveStageLabel(nextIncomplete, titleLabel, stageLabels) : doneLabel
}

export const WorldGenStatusCard = forwardRef<HTMLDivElement, WorldGenStatusCardProps>(
  function WorldGenStatusCard(
    {
      stages,
      countdownLabel,
      stalledLabel,
      stageLabels,
      variant = 'overlay',
      titleLabel,
      doneLabel,
      progressLabel,
      returnLabel,
      onReturn,
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const progress = computeProgress(stages)
    const currentLabel = currentLabelFrom(progress, doneLabel, titleLabel, stageLabels)

    // The shared pieces both variants compose: the fixed segmented bar (the ONE
    // progressbar, carrying the AT semantics — percent lives only in its machine
    // values, never as a visible numeral), the countdown line or its stalled
    // stand-in (at most one; the live countdown wins defensively), and the quiet
    // return link.
    const bar = (
      <div
        role="progressbar"
        aria-label={progressLabel}
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={currentLabel}
        data-testid="worldgen-status-bar"
        className={BAR_CLASS}
      >
        {progress.bars.map((b) => (
          <span
            key={b.stage}
            aria-hidden="true"
            data-cell-state={b.state}
            className={cn(cell({ state: b.state }))}
          />
        ))}
      </div>
    )
    const waitLine =
      countdownLabel !== undefined ? (
        <span aria-hidden="true" data-testid="worldgen-status-countdown" className={COUNTDOWN_CLASS}>
          {countdownLabel}
        </span>
      ) : stalledLabel !== undefined ? (
        <span data-testid="worldgen-status-stalled" className={STALLED_CLASS}>
          {stalledLabel}
        </span>
      ) : null
    const returnLink = returnLabel !== undefined && onReturn !== undefined && (
      <button type="button" data-testid="worldgen-status-return" className={RETURN_CLASS} onClick={onReturn}>
        {returnLabel}
      </button>
    )
    const testId = dataTestId !== undefined ? { 'data-testid': dataTestId } : {}

    // FOOTER (narrow viewports): one label + countdown row over the bars — no
    // caption, no absolute pinning; the graph places it below the full-bleed pane.
    if (variant === 'footer') {
      return (
        <div ref={ref} {...testId} data-variant="footer" className={FOOTER_CLASS}>
          <div className={FOOTER_ROW_CLASS}>
            <span className={cn(LABEL_CLASS, 'flex-1 truncate')}>{currentLabel}</span>
            {waitLine}
          </div>
          {bar}
          {returnLink}
        </div>
      )
    }

    return (
      <div ref={ref} {...testId} data-variant="overlay" className={CARD_CLASS}>
        <span className={TITLE_CLASS}>{titleLabel}</span>
        <span className={LABEL_CLASS}>{currentLabel}</span>
        {bar}
        {waitLine}
        {returnLink}
      </div>
    )
  },
)
