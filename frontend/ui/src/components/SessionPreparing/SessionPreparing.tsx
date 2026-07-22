import { forwardRef } from 'react'
import type { SessionPreparingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { BeatFigure } from '../BeatFigure/BeatFigure.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// SessionPreparing (myth-ep74g) — the calm BETWEEN-SESSIONS hold. When a session has just
// ended and the next one isn't startable yet (the server answers prep_not_ready /
// reconcile_pending / session_ending), the play route sits here while the start-flow hook
// backoff-polls in the background. It replaces the old prep beat's SSE-driven immediate
// re-`start()` that stormed the endpoint into a 429 — this surface renders nothing but a quiet,
// unhurried "the DM is preparing the next session" beat; the waiting cadence lives in the hook.
//
// It is deliberately SEPARATE from SessionStartBeat (the two-phase FIRST-token start beat): this
// is an open-ended wait with NO progress and no itinerary — one atmospheric line over a
// breathing figure. Same 1-bit register though, so the two beats read as one family.
//
// THE FIGURE: the shared BeatFigure in INDETERMINATE mode (mode="breathe") — a full-width band
// of hard binary Bayer cells whose interior density swells and ebbs as a traveling wave (a
// diagonal breath, ~3s, asymmetric inhale/exhale, re-seeded each cycle so consecutive breaths
// differ). There is NO opacity fade and no progress: the calm is carried purely by the moving
// density. Frozen-paper tone (theme-invariant 1-bit relic). `reducedMotion` freezes it to a
// legible still frame. Decoration → aria-hidden (the BeatFigure sets it).
//
// a11y: `aria-busy` while mounted (the route unmounts it when play begins); the figure is
// decoration, so an SR-only polite live region carries the `label` as the single AT source of
// truth (motion is never the sole signal). `label` / `detail` are resolved chrome the
// consumer passes (the DS component stays i18n-agnostic).

// The centred hold — a quiet column: the breathing figure over the atmospheric line(s). min-w-0
// so the text wraps rather than spilling at ~375px.
const WRAP_CLASS = 'flex min-w-0 flex-col items-center gap-[var(--space-4)] text-center'

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
      {/* The single AT source of truth: the figure is decoration, so a polite live region
          carries the atmospheric label. */}
      <VisuallyHidden>
        <span role="status" aria-live="polite" data-testid="session-preparing-live">
          {label}
        </span>
      </VisuallyHidden>

      {/* The breathing 1-bit field — decorative; still under reduced motion. */}
      <BeatFigure mode="breathe" reducedMotion={reducedMotion} data-testid="session-preparing-figure" />

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
