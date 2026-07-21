import { forwardRef } from 'react'
import type { ThinkingIndicatorProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { Spinner } from '../Spinner/Spinner.tsx'

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
// DM-thinking line carries the design system's Spinner (the locked 12×12 diagonal
// dither wave) as its activity mark — the SAME indeterminate-busy motion the app
// uses everywhere else (Button/IconButton/WorldGenLoading), for one consistent
// "working" language instead of a bespoke pulse. `xs` (12px) tracks the meta line's
// cap height; `accent` paints the brand ember. The Spinner self-freezes to its
// static ~40% dither under prefers-reduced-motion, and the steady prose is the
// non-motion signal (motion is never the only cue).
//
// a11y of the mark: the Spinner is its own `role="status"` live region, so nesting
// it raw inside THIS live region would double-announce (its "Loading" name AND the
// "DM is thinking…" text). We wrap it in an `aria-hidden` span, which removes the
// Spinner subtree — role, name, and all — from the accessibility tree. The mark is
// then purely decorative and the ThinkingIndicator's own text is the SOLE
// announcement, preserving the existing live-region semantics exactly.
//
// Platform-neutral props (§9): booleans + resolved [ph:] labels + display-name
// DATA. `typingLabel` is the resolved presence label; the names are joined in
// front of it (MYT-100 owns the final copy / pluralization).

const LINE_CLASS = TYPE_ROLE_CLASS.meta

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
            {/* The Spinner carries its own role="status"/name; aria-hidden strips
                the whole subtree from the a11y tree so only the line's text is
                announced (no double live region). Decorative activity mark only.
                `inline-flex` shrink-wraps the wrapper to the 12px mark (no inherited
                line-box leading), so `items-center` optically centers it on the
                text instead of letting it ride low on the baseline. */}
            <span
              aria-hidden="true"
              className="inline-flex flex-none"
              data-testid="thinking-indicator-spinner"
            >
              <Spinner size="xs" tone="accent" />
            </span>
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
