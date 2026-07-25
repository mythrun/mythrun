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
// COLLAPSE: long scene prose pushes the actual prompt — and at 720 the field
// bottom and its Continue — below the fold, so long prose (a deterministic
// length threshold — structural, no cognition) clamps to two lines at EVERY
// width, with a quiet disclosure toggle to read it all (ux-run3 myth-21lpi:
// the grounding step's textarea + submit must sit inside a 1280x720 frame; the
// recap is ambient context and two lines + one click reclaim the fold for the
// input). Per the contract, the collapse is presentation detail the component
// owns INTERNALLY (no callback); the clamped text stays in the DOM, so
// assistive tech always has the full prose.
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

// The card's own margins are one step tighter than a standard paper card
// (space-3, not space-4 — ux-run3 myth-21lpi took BOTH halves of the critic's
// "tighten the recap card's margins OR clamp its body" prescription; the fold
// needed both). Ambient context earns less padding than the prompt it serves.
const CARD_CLASS = cn(
  'flex w-full min-w-0 flex-col gap-[var(--space-2)]',
  'rounded-none border border-border bg-surface p-[var(--space-3)]',
)
// The machine-register eyebrow — quiet tertiary ink (ambient, not ember).
const EYEBROW_CLASS = 'font-ui text-xs font-medium uppercase tracking-wide text-ink-tertiary'
// The serif title line: strong title, muted italic location.
const TITLE_LINE_CLASS = 'font-body text-base leading-[1.4]'
const TITLE_CLASS = 'font-semibold text-ink'
const LOCATION_CLASS = 'font-normal italic text-ink-secondary'
// The scene prose — quiet secondary-ink serif, capped at the reading measure
// (ux-run3 myth-7ceqw: the card's text must not wrap at ~95-100ch).
const PROSE_CLASS = 'max-w-[70ch] font-body text-sm leading-[1.5] text-ink-secondary'
// Collapsed long prose clamps to two lines at every width (myth-21lpi).
const PROSE_CLAMP_CLASS = 'line-clamp-2'
// The disclosure toggle — the quiet underlined mono link idiom (GuidedBuilder's
// skip affordance), shown whenever the prose is long enough to clamp.
const TOGGLE_CLASS = cn(
  'self-start rounded-none bg-transparent cursor-pointer',
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
        {/* eslint-disable-next-line mythrun-ui/no-untranslated-jsx-text -- interpunct separator notation, not translatable copy */}
        <span className={LOCATION_CLASS}> · {locationName}</span>
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
