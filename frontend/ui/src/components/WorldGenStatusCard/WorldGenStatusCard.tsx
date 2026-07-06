import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { StageProgress, WorldGenStatusCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// WorldGenStatusCard (MYT-89 Phase C, C4) — a DOM overlay pinned top-left of the graph
// pane so the ~2-minute pre-entity generation stretch reads as PROGRESS, not a hang.
// It reads the stream's `stages[]` (B4 `StageProgress`) + `costUsd` and shows: the
// current (running) stage's friendly label, a completed/total percent, and a PAPER-
// REGISTER working indicator.
//
// The working indicator IS the percent bar: a segmented SQUARE bar, one cell per stage
// — completed cells solid ink, the running cell ember + `animate-pulse` (an opacity
// fade, the brand's ONLY sanctioned motion — §4), pending cells a faint track. NO
// circle, NO spinner, NO dots (hard brand rule). At 100% no cell is running, so the
// pulse stops and the bar rests full. Colour is never the sole signal: the running
// cell is distinct by fill (ember) even with motion reduced, and the label/percent/
// progressbar aria carry the meaning.
//
// The card self-positions `absolute` inside its host pane (documented on the contract),
// is `pointer-events-none` (a readout, never intercepting graph interaction), and caps
// its width so it fits a ~375px pane without overflow.

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
const COST_CLASS = 'font-ui text-xs tabular-nums text-ink-tertiary leading-none'

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

interface Progress {
  readonly total: number
  readonly completed: number
  readonly percent: number
  readonly running: StageProgress | undefined
  readonly isComplete: boolean
}

/** Percent is a simple completed/total (v1 stage weighting) — the running stage
 *  counts as in-flight, not partial. */
function computeProgress(stages: readonly StageProgress[]): Progress {
  const total = stages.length
  const completed = stages.filter((s) => s.status === 'completed').length
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)
  const running = stages.find((s) => s.status === 'running')
  return { total, completed, percent, running, isComplete: total > 0 && completed === total }
}

export const WorldGenStatusCard = forwardRef<HTMLDivElement, WorldGenStatusCardProps>(
  function WorldGenStatusCard(
    {
      stages,
      costUsd,
      stageLabels,
      titleLabel = '[ph: weaving your world]',
      doneLabel = '[ph: your world is ready]',
      progressLabel = '[ph: world generation progress]',
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const { total, percent, running, isComplete } = computeProgress(stages)
    // Nothing to show before the first snapshot frame (the stage set is empty).
    if (total === 0) return null

    // The main line: the running stage while generating, the done label at 100%, else
    // the first not-yet-complete stage (a brief lull between stages).
    const nextIncomplete = stages.find((s) => s.status !== 'completed')
    const currentLabel = running
      ? resolveStageLabel(running.stage, stageLabels)
      : isComplete
        ? doneLabel
        : nextIncomplete
          ? resolveStageLabel(nextIncomplete.stage, stageLabels)
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
          {stages.map((s) => {
            const state = cellState(s.status)
            return (
              <span
                key={s.stage}
                aria-hidden="true"
                data-cell-state={state}
                className={cn(cell({ state }))}
              />
            )
          })}
        </div>
        {costUsd !== undefined && costUsd !== null && (
          <span className={COST_CLASS}>{`$${costUsd.toFixed(2)}`}</span>
        )}
      </div>
    )
  },
)
