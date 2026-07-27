import { forwardRef } from 'react'
import { cn } from '../../lib/cn.ts'

// WhisperLedger (ux-run2 myth-i2pdo) — the long-wait whisper column shared by
// the two multi-minute waits (WorldGenLoading + SessionPreparing): the CURRENT
// flavor line with the previously shown lines settling beneath it as a faint
// ledger, newest first, oldest most faded. The growing list IS the progress
// texture — a wait that has visibly been lived through, not just endured.
// Purely presentational: the consumer owns the cycle (useWhisperCycle), the
// copy, and the cadence; under reduced motion the cycle never advances, so the
// ledger simply stays empty. Decorative prose → the whole column is
// aria-hidden (the composing surface owns the a11y busy semantics).
//
// TWO SIZES: `hero` — the whisper is the ONLY content on the screen (the
// world-gen calm wait), so the current line carries a headline's job at ~20px
// (ux-run2 myth-xe38q: 16px body was "body text carrying a headline's job");
// `sub` — the whisper is a sub-line under a serif title (session prep), so the
// current line stays at body-quiet scale. The ledger fades by AGE via an
// opacity ladder — decorative texture (aria-hidden), deliberately sub-AA as it
// recedes; state never rides on it.
//
// STABILITY (ux-run3 myth-5ekb5): the ledger grows inside a FIXED-HEIGHT WELL
// reserved from first paint, and the hero current line reserves two text lines
// — so neither a settling whisper nor a wrapping one re-centers the column (the
// mark above stays anchored). Overflow clips at the bottom, where the oldest,
// most-faded line lives.
//
// MARKS (ux-run3 myth-1yxfr): each settled line leads with a quiet 1-bit
// FILLED SQUARE (bg-current — it inherits the line's ink and age fade; square
// per register, never a dot or checkmark), flipping the log from decoration to
// progress without touching the prose. The live line carries no mark.

type WhisperSize = 'hero' | 'sub'

export interface WhisperLedgerProps {
  /** The line currently showing (already-resolved i18n). Omitted → only the
   *  ledger renders (a consumer edge; normally always present). */
  current?: string
  /** Previously shown lines, NEWEST FIRST (useWhisperCycle's shape). */
  history: readonly string[]
  /** `hero` = the screen's only content (world-gen); `sub` = a sub-line under
   *  a title (session prep). Default `hero`. */
  size?: WhisperSize
  'data-testid'?: string
}

const WRAP_CLASS = 'flex min-w-0 flex-col items-center gap-[var(--space-2)] text-center'

const CURRENT_CLASS: Record<WhisperSize, string> = {
  // The only content on the screen — a headline's job at a whisper's volume.
  // min-h reserves TWO lines (a one-line whisper centers in the slot), so a
  // wrapping line never shifts the mark above (myth-5ekb5).
  hero: 'flex min-h-[3.5rem] items-center justify-center font-body text-xl text-ink-secondary leading-[1.4] max-w-[28rem]',
  sub: 'font-body text-sm text-ink-secondary leading-[1.4] max-w-[24rem]',
}

// The reserved well (myth-5ekb5): height fixed at first paint — four settled
// lines plus gaps — with overflow clipped at the bottom (the oldest, most-faded
// line). Present even while empty, so the first settle displaces nothing.
const WELL_CLASS: Record<WhisperSize, string> = {
  hero: 'h-[5.75rem] w-full overflow-hidden',
  sub: 'h-[5rem] w-full overflow-hidden',
}

const LEDGER_CLASS = 'flex list-none flex-col items-center gap-[var(--space-1)] p-0'
const LEDGER_LINE_CLASS: Record<WhisperSize, string> = {
  hero: 'flex items-baseline justify-center gap-[var(--space-2)] font-body text-sm text-ink-tertiary leading-[1.4] max-w-[28rem]',
  sub: 'flex items-baseline justify-center gap-[var(--space-2)] font-body text-xs text-ink-tertiary leading-[1.4] max-w-[24rem]',
}
// The settled line's 1-bit completion mark (myth-1yxfr): a filled square in the
// line's own ink (bg-current rides the li's color + age opacity). Square, never
// a dot — the paper register has no circles.
const MARK_CLASS = 'shrink-0 self-center rounded-none bg-current'
// The age cue. This used to be an opacity ramp on the whole line
// (opacity-80/60/40/25), which was the age-fade AND an accessibility failure:
// composited over the paper ground, ink-tertiary lands at 3.49:1 at .80 and
// 1.39:1 at .25 against a 4.5:1 AA floor, and NO ink token in the system can
// carry a ramp that deep — ink-secondary, the darkest, still only reaches
// 3.37:1 by .60. The fade and AA were structurally incompatible, so the cue
// moved off tone entirely rather than being quietly exempted.
//
// Age is now carried by the MARK's size. That works because the ledger already
// encodes age spatially — index 0 is the newest and the well clips the oldest
// off the bottom — so the mark reinforces a gradient the eye is already reading
// down the stack, instead of inventing one. The mark is decorative and
// aria-hidden, so shrinking it costs no legibility; the line's text now holds a
// single passing ink at full opacity (ink-tertiary, 5.18:1). Squares only — the
// paper register has no circles, at any size.
const AGE_MARK_SIZE = ['size-[5px]', 'size-[4px]', 'size-[3px]', 'size-[2px]'] as const

export const WhisperLedger = forwardRef<HTMLDivElement, WhisperLedgerProps>(
  function WhisperLedger({ current, history, size = 'hero', 'data-testid': dataTestId }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
        className={WRAP_CLASS}
      >
        {current !== undefined && (
          <p data-testid="whisper-ledger-current" className={CURRENT_CLASS[size]}>
            {current}
          </p>
        )}
        {/* The fixed-height well the ledger grows into — reserved from first
            paint so a settling line never re-centers the column (myth-5ekb5). */}
        <div data-testid="whisper-ledger-well" className={WELL_CLASS[size]}>
          {history.length > 0 && (
            <ul data-testid="whisper-ledger-history" className={LEDGER_CLASS}>
              {history.map((line, i) => (
                <li
                  // Position joins the key: a line can legitimately recur after a
                  // reshuffle, so text alone cannot key; the ledger re-stacks
                  // wholesale on each advance anyway.
                  key={`${String(i)}-${line}`}
                  data-testid="whisper-ledger-line"
                  className={LEDGER_LINE_CLASS[size]}
                >
                  <span
                    aria-hidden="true"
                    data-testid="whisper-ledger-mark"
                    className={cn(MARK_CLASS, AGE_MARK_SIZE[Math.min(i, AGE_MARK_SIZE.length - 1)])}
                  />
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  },
)
