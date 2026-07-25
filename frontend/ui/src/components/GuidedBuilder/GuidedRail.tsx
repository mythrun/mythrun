import { forwardRef, useState } from 'react'
import type { GuidedRailProps, RailStep } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// GuidedRail (MYT-102) — the guided journey's progress rail, extracted from
// GuidedBuilder so the builder-less screens of the SAME journey (the notes and
// grounding prompts) keep the done/now/todo continuity instead of dropping the
// signposting at the exact moment the option grids disappear. GuidedBuilder
// composes this for its option steps (behavior-preserving — it passes its
// historical `guided-builder-rail` testid); guided-path mounts it directly above
// the notes/grounding FreeformPrompts with the rail-only `grounding` rung `now`.
//
// The rail is a RECEIPT (ux-run2 myth-udhp3): a completed rung collapses to its
// chosen value — "Cleric · Life Domain → Human → Hermit" — the choices become the
// path (the category label stays for assistive tech, visually hidden). The
// current rung keeps its label (the prompt context) and is the STRONGEST element
// (ember edge + inset ring — the shipped selection idiom); upcoming rungs stay
// muted. An optional `counter` ("Step 2 of 5") rides the row's trailing edge.
//
// NON-navigational (the contract carries no per-rung callback) — but a rung
// whose chosen value runs long (the free-text NOTES) clamps to a one-line
// ellipsis token and gains a local disclosure toggle (a real <button>,
// aria-expanded) so the full text is one click away without the breadcrumb ever
// out-shouting the current step. Flat 1-bit paper register: `rounded-none`,
// token-driven edges, NO circles/dots/chips. The rail wraps at narrow widths
// (flex-wrap), so it holds at ~375px.

// One rung of the progress rail — a bordered square showing the step label and,
// once chosen, its picked value.
const NODE_BASE = cn(
  'inline-flex items-center gap-[var(--space-2)] rounded-none border',
  'px-[var(--space-3)] py-[var(--space-1)]',
)
const NODE_STATE: Record<RailStep['state'], string> = {
  done: 'border-ink bg-surface text-ink-secondary',
  // The current rung is the strongest element on the rail (ux-run2 myth-udhp3):
  // the ember edge doubled by the inset ring — the LevelCard selection idiom.
  now: 'border-accent bg-surface text-accent-fg shadow-[inset_0_0_0_1px_var(--accent)]',
  todo: 'border-border bg-bg text-ink-tertiary',
}
// The rung's step label — the small mono/machine register.
const NODE_LABEL = 'font-ui text-xs font-medium uppercase tracking-wide'
// The picked value carried on a completed rung — serif, strong ink so it pops past
// the muted label.
const NODE_CHOSEN = 'font-body text-sm font-semibold text-ink'
// The clamped long value — a one-line ellipsis token (ux-run2 myth-udhp3: the
// breadcrumb is a record of the past; it never out-shouts the current step).
const NODE_CHOSEN_CLAMPED = 'inline-block max-w-[24ch] truncate align-bottom'
// The directional separator between rungs — decorative, so it is aria-hidden.
const SEP = 'font-ui text-xs text-ink-tertiary'
// The quiet trailing step counter — machine register, oriented not emphasized.
const COUNTER = 'ml-auto font-ui text-xs uppercase tracking-wide text-ink-tertiary'

/** A chosen value long enough to clamp to a one-line token (the free-text NOTES;
 *  a structural length check, not a semantic read). */
const CLAMP_CHARS = 28

/** One rung's content: the label (visually hidden on a completed rung, where the
 *  chosen value IS the label) and the chosen value (clamped when long). */
function RungContent({ rung, clamped }: { rung: RailStep; clamped: boolean }): React.JSX.Element {
  const collapseLabel = rung.state === 'done' && rung.chosen !== undefined
  return (
    <>
      {collapseLabel ? (
        <VisuallyHidden>{rung.label}</VisuallyHidden>
      ) : (
        <span className={NODE_LABEL}>{rung.label}</span>
      )}
      {rung.chosen !== undefined && (
        <span className={cn(NODE_CHOSEN, clamped && NODE_CHOSEN_CLAMPED)}>{rung.chosen}</span>
      )}
    </>
  )
}

export const GuidedRail = forwardRef<HTMLOListElement, GuidedRailProps>(function GuidedRail(
  { rail, counter, 'data-testid': dataTestId = 'guided-rail' },
  ref,
) {
  // The long-value disclosure (per rung, local — the rail stays non-navigational;
  // this only reveals text already carried in props).
  const [expandedSteps, setExpandedSteps] = useState<readonly string[]>([])
  const toggle = (step: string): void => {
    setExpandedSteps((steps) =>
      steps.includes(step) ? steps.filter((s) => s !== step) : [...steps, step],
    )
  }
  // Self-describing (label + chosen value), so it needs no landmark label.
  return (
    <ol
      ref={ref}
      data-testid={dataTestId}
      className="flex list-none flex-wrap items-center gap-[var(--space-2)] p-0"
    >
      {rail.map((rung, index) => {
        const clampable = (rung.chosen?.length ?? 0) > CLAMP_CHARS
        const expanded = expandedSteps.includes(rung.step)
        return (
          <li key={rung.step} className="flex min-w-0 items-center gap-[var(--space-2)]">
            {index > 0 && (
              <span aria-hidden="true" className={SEP}>
                →
              </span>
            )}
            {clampable ? (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  toggle(rung.step)
                }}
                data-state={rung.state}
                className={cn(
                  NODE_BASE,
                  NODE_STATE[rung.state],
                  'min-w-0 cursor-pointer text-left',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
                )}
              >
                <RungContent rung={rung} clamped={!expanded} />
              </button>
            ) : (
              <span data-state={rung.state} className={cn(NODE_BASE, NODE_STATE[rung.state])}>
                <RungContent rung={rung} clamped={false} />
              </span>
            )}
          </li>
        )
      })}
      {counter !== undefined && (
        <li data-testid="guided-rail-counter" className={COUNTER}>
          {counter}
        </li>
      )}
    </ol>
  )
})
