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
  hero: 'font-body text-xl text-ink-secondary leading-[1.4] max-w-[28rem]',
  sub: 'font-body text-sm text-ink-secondary leading-[1.4] max-w-[24rem]',
}

const LEDGER_CLASS = 'flex list-none flex-col items-center gap-[var(--space-1)] p-0'
const LEDGER_LINE_CLASS: Record<WhisperSize, string> = {
  hero: 'font-body text-sm text-ink-tertiary leading-[1.4] max-w-[28rem]',
  sub: 'font-body text-xs text-ink-tertiary leading-[1.4] max-w-[24rem]',
}
// The age fade — index 0 is the most recently settled line. Decorative
// (aria-hidden) texture; the terminal opacity keeps the oldest line a ghost.
const AGE_OPACITY = ['opacity-80', 'opacity-60', 'opacity-40', 'opacity-25'] as const

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
        {history.length > 0 && (
          <ul data-testid="whisper-ledger-history" className={LEDGER_CLASS}>
            {history.map((line, i) => (
              <li
                // Position joins the key: a line can legitimately recur after a
                // reshuffle, so text alone cannot key; the ledger re-stacks
                // wholesale on each advance anyway.
                key={`${String(i)}-${line}`}
                data-testid="whisper-ledger-line"
                className={cn(
                  LEDGER_LINE_CLASS[size],
                  AGE_OPACITY[Math.min(i, AGE_OPACITY.length - 1)],
                )}
              >
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  },
)
