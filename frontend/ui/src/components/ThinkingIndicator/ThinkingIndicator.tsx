import { forwardRef } from 'react'
import type { ThinkingIndicatorProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// ThinkingIndicator (MYT-92) — the quiet between-turns liveness line under the
// live-play transcript: "DM is thinking…" while a DM turn is open, plus
// player-typing presence. PURELY PRESENTATIONAL (contract §2): the useSession hook
// (Task 6) owns the CLEAR conditions — the first text_delta / turn_end / turn_error
// settles `thinking`, so a stuck indicator can't outlive a reconnect. This
// component only renders the booleans/names it is handed.
//
// a11y: the ROOT is a polite live region that is ALWAYS mounted (even idle), so a
// later thinking/typing change is announced rather than swallowed by a
// freshly-mounted region. Idle renders no visible line — the empty region reserves
// no height.
//
// Register: two quiet `--font-ui` (IBM Plex Mono) `meta` lines, stacked. The
// DM-thinking line carries a small SQUARE ember mark (no circles/dots — the paper
// square register) that pulses on the brand's ONLY sanctioned motion (an opacity
// fade — the same idiom as StreamingProse's caret / WorldGenStatusCard's running
// cell); the global base.css `prefers-reduced-motion` reset freezes it, and the
// steady prose is the non-motion signal (motion is never the only cue). The mark
// is decorative (`aria-hidden`); the text stays full-contrast (the pulse never
// dims the words).
//
// Platform-neutral props (§9): booleans + resolved [ph:] labels + display-name
// DATA. `typingLabel` is the resolved presence label; the names are joined in
// front of it (MYT-100 owns the final copy / pluralization).

const LINE_CLASS = TYPE_ROLE_CLASS.meta
// The pulsing activity mark: a small square ember chip, em-sized so it tracks the
// line's type. Decorative. `animate-pulse` is the sanctioned opacity fade; the
// global reduced-motion reset holds it steady.
const PULSE_CLASS = 'inline-block h-[0.5em] w-[0.5em] flex-none bg-accent animate-pulse'

export const ThinkingIndicator = forwardRef<HTMLDivElement, ThinkingIndicatorProps>(
  function ThinkingIndicator({ thinking, typingNames, thinkingLabel, typingLabel }, ref) {
    const typing = typingNames.length > 0
    return (
      <div
        ref={ref}
        data-testid="thinking-indicator"
        role="status"
        aria-live="polite"
        className="flex flex-col gap-[var(--space-1)]"
      >
        {thinking ? (
          <p
            data-testid="thinking-indicator-thinking"
            className={cn(LINE_CLASS, 'flex items-center gap-[var(--space-2)]')}
          >
            <span aria-hidden="true" data-testid="thinking-indicator-pulse" className={PULSE_CLASS} />
            {thinkingLabel}
          </p>
        ) : null}
        {typing ? (
          <p data-testid="thinking-indicator-typing" className={LINE_CLASS}>
            {typingNames.join(', ')} {typingLabel}
          </p>
        ) : null}
      </div>
    )
  },
)
