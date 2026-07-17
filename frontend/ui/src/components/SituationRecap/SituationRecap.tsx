import { forwardRef, useId, useState } from 'react'
import type { SituationRecapProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// SituationRecap (MYT-102) — the quiet paper card that keeps the chosen opening
// situation in view while the player writes their character: a mono eyebrow over
// the situation's serif title + location, then the scene prose. The create
// screens mount it above the freeform prompts so the concept/grounding answers
// are written AGAINST the actual opening scene, not from memory of a screen
// three steps back.
//
// Register (flat 1-bit / paper / SQUARE): `rounded-none`, a 1px `--border`
// hairline edge over the `--surface` fill — QUIET by design (the card is ambient
// context, never the hero; the prompt below it is). No circles/dots/chips; the
// title/location line is serif DATA, the eyebrow the machine-mono register.
// Theme-aware via semantic tokens.
//
// NARROW COLLAPSE: on phone widths a long scene prose would push the actual
// prompt below the fold, so long prose (a deterministic length threshold —
// structural, no cognition) clamps to a few lines below the `sm` step, with a
// quiet disclosure toggle to read it all. Per the contract, the collapse is
// presentation detail the component owns INTERNALLY (no callback); the clamped
// text stays in the DOM, so assistive tech always has the full prose. At `sm`
// and up the clamp never binds and the toggle is hidden.
//
// The toggle's labels are fixed brand chrome, not passed-in copy — the contract
// carries no label props, exactly like FreeformPrompt's fixed "Continue" and
// LevelCard's fixed "Level" eyebrow. The end-of-milestone copy pass owns the
// final wording.
const SHOW_LABEL = 'Show more'
const HIDE_LABEL = 'Show less'

/** Prose at or past this length gets the narrow-viewport clamp + toggle. Short
 *  scene prose renders whole everywhere — no dead toggle. Deterministic and
 *  structural (a length check, not a judgment call). */
const COLLAPSIBLE_MIN_CHARS = 240

const CARD_CLASS = cn(
  'flex w-full min-w-0 flex-col gap-[var(--space-2)]',
  'rounded-none border border-border bg-surface p-[var(--space-4)]',
)
// The machine-register eyebrow — quiet tertiary ink (ambient, not ember).
const EYEBROW_CLASS = 'font-ui text-xs font-medium uppercase tracking-wide text-ink-tertiary'
// The serif title line: strong title, muted italic location.
const TITLE_LINE_CLASS = 'font-body text-base leading-[1.4]'
const TITLE_CLASS = 'font-semibold text-ink'
const LOCATION_CLASS = 'font-normal italic text-ink-secondary'
// The scene prose — quiet secondary-ink serif.
const PROSE_CLASS = 'font-body text-sm leading-[1.5] text-ink-secondary'
// Collapsed long prose clamps ONLY below the `sm` step (the narrow regime).
const PROSE_CLAMP_CLASS = 'max-sm:line-clamp-3'
// The disclosure toggle — the quiet underlined mono link idiom (GuidedBuilder's
// Back/skip affordance), shown only below `sm` where the clamp binds.
const TOGGLE_CLASS = cn(
  'self-start rounded-none bg-transparent cursor-pointer sm:hidden',
  'font-ui text-xs tracking-wide text-ink-tertiary underline underline-offset-2',
  'hover:text-ink transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

export const SituationRecap = forwardRef<HTMLDivElement, SituationRecapProps>(function SituationRecap(
  { eyebrow, title, locationName, prose },
  ref,
) {
  // Internal per the contract: the collapse is a narrow-viewport presentation
  // detail, not flow state — consumers stay prop-pure.
  const [expanded, setExpanded] = useState(false)
  const proseId = useId()
  const collapsible = prose.length >= COLLAPSIBLE_MIN_CHARS
  return (
    <div ref={ref} data-testid="situation-recap" className={CARD_CLASS}>
      <p className={EYEBROW_CLASS}>{eyebrow}</p>
      <p className={TITLE_LINE_CLASS}>
        <span className={TITLE_CLASS}>{title}</span>
        <span className={LOCATION_CLASS}> — {locationName}</span>
      </p>
      <p
        id={proseId}
        data-testid="situation-recap-prose"
        className={cn(PROSE_CLASS, collapsible && !expanded && PROSE_CLAMP_CLASS)}
      >
        {prose}
      </p>
      {collapsible && (
        // WAI-ARIA disclosure wiring on the clamp: aria-expanded + aria-controls
        // point at the (always-rendered, visually clamped) prose region.
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={proseId}
          onClick={() => {
            setExpanded((current) => !current)
          }}
          className={TOGGLE_CLASS}
          data-testid="situation-recap-toggle"
        >
          {expanded ? HIDE_LABEL : SHOW_LABEL}
        </button>
      )}
    </div>
  )
})
