import { forwardRef } from 'react'
import type { SessionPreparingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { Dither } from '../Dither/Dither.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// SessionPreparing (myth-ep74g) — the calm BETWEEN-SESSIONS hold. When a session has
// just ended and the next one isn't startable yet (the server answers prep_not_ready /
// reconcile_pending / session_ending), the play route sits here while the start-flow
// hook backoff-polls in the background. It replaces the old prep beat's SSE-driven
// immediate re-`start()` that stormed the endpoint into a 429 — this surface renders
// nothing but a quiet, unhurried "the DM is preparing the next session" beat; the
// waiting cadence lives entirely in the hook.
//
// It is deliberately SEPARATE from SessionStartBeat (the two-phase FIRST-token start
// beat): this is an open-ended wait with no itinerary — one atmospheric line, not a
// prep→connecting sequence. Same 1-bit register though (paper / ordered-Bayer figure),
// so the two beats read as one family.
//
// THE FIGURE: a fixed square 1-bit ink-on-paper tile holding the shipped `Dither`
// band (the brand's only sanctioned gradient), theme-INVARIANT by design (the frozen
// `--color-paper-*` ramp, like SessionStartBeat / Divider's ink line). Decoration →
// `aria-hidden`. A slow breathing pulse is the only sign of life (the wait can run a
// minute or two); `reducedMotion` drops it to a still figure — no churn.
//
// a11y: `aria-busy` while mounted (the route unmounts it when play begins); the figure
// is decoration, so an SR-only polite live region carries the `label` as the single
// AT source of truth (motion is never the sole signal). `label` / `detail` are resolved
// [ph:] chrome the consumer passes (the DS component stays i18n-agnostic).

// The centred hold — a quiet column: the figure over the atmospheric line(s). min-w-0
// so the text wraps rather than spilling at ~375px.
const WRAP_CLASS = 'flex min-w-0 flex-col items-center gap-[var(--space-4)] text-center'

// The figure box — a fixed 96×96 1-bit tile. `overflow-hidden` clips the Dither band
// to the frame; ink-on-paper via the FROZEN ramp utilities so it reads identically in
// light + dark.
const FIG_CLASS = 'relative block h-[96px] w-[96px] flex-none overflow-hidden border-[1.5px] border-paper-900 bg-paper-50'
// A slow breathing pulse — the sole sign of life on an open-ended wait; dropped under
// reducedMotion (the route threads the resolved prefers-reduced-motion preference).
const FIG_PULSE_CLASS = 'animate-pulse'
// The Dither band, pinned to the figure base and centred over the narrow tile (the
// band's cross-axis min-width exceeds 96px; the surplus is clipped).
const DITHER_WRAP_CLASS = 'absolute inset-x-0 bottom-0 left-1/2 -translate-x-1/2'

// The atmospheric line + an optional quiet sub-line.
const TEXT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
// The label reads as unhurried narrative (serif title), not a machine status line.
const LABEL_CLASS = cn(TYPE_ROLE_CLASS.title, 'text-ink')
const DETAIL_CLASS = cn(TYPE_ROLE_CLASS.meta, 'break-words')

export const SessionPreparing = forwardRef<HTMLDivElement, SessionPreparingProps>(function SessionPreparing(
  { label, detail, reducedMotion },
  ref,
) {
  return (
    <div ref={ref} data-testid="session-preparing" data-reduced-motion={reducedMotion} aria-busy={true} className={WRAP_CLASS}>
      {/* The single AT source of truth: the figure is decoration, so a polite live
          region carries the atmospheric label. */}
      <VisuallyHidden>
        <span role="status" aria-live="polite" data-testid="session-preparing-live">
          {label}
        </span>
      </VisuallyHidden>

      {/* The 1-bit figure — decorative; breathing unless reduced motion. */}
      <div
        data-testid="session-preparing-figure"
        aria-hidden="true"
        className={cn(FIG_CLASS, !reducedMotion && FIG_PULSE_CLASS)}
      >
        <div className={DITHER_WRAP_CLASS}>
          <Dither from="paper-100" to="paper-900" direction="vertical" scale="preview" />
        </div>
      </div>

      <div className={TEXT_CLASS}>
        <p aria-hidden="true" className={LABEL_CLASS}>
          {label}
        </p>
        {detail !== undefined ? (
          <p aria-hidden="true" className={DETAIL_CLASS}>
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  )
})
