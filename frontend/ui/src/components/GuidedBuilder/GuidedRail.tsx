import { forwardRef } from 'react'
import type { GuidedRailProps, RailStep } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// GuidedRail (MYT-102) — the guided journey's progress rail, extracted from
// GuidedBuilder so the builder-less screens of the SAME journey (the notes and
// grounding prompts) keep the done/now/todo continuity instead of dropping the
// signposting at the exact moment the option grids disappear. GuidedBuilder
// composes this for its option steps (behavior-preserving — it passes its
// historical `guided-builder-rail` testid); guided-path mounts it directly above
// the notes/grounding FreeformPrompts with the rail-only `grounding` rung `now`.
//
// NON-interactive (the rail is a status display; the contract carries no per-rung
// callback) — a semantic ordered list of bordered SQUARE rungs showing the step
// label and, once chosen, its picked value. State recolors the edge through the
// same ember/ink/muted token language the builder established: `now` = ember
// edge+text, `done` = ink edge over the chosen value, `todo` = muted. Flat 1-bit
// paper register: `rounded-none`, token-driven edges, NO circles/dots/chips. The
// rail wraps at narrow widths (flex-wrap), so it holds at ~375px.

// One rung of the progress rail — a bordered square showing the step label and,
// once chosen, its picked value.
const NODE_BASE = cn(
  'inline-flex items-center gap-[var(--space-2)] rounded-none border',
  'px-[var(--space-3)] py-[var(--space-1)]',
)
const NODE_STATE: Record<RailStep['state'], string> = {
  done: 'border-ink bg-surface text-ink-secondary',
  now: 'border-accent bg-surface text-accent-fg',
  todo: 'border-border bg-bg text-ink-tertiary',
}
// The rung's step label — the small mono/machine register.
const NODE_LABEL = 'font-ui text-xs font-medium uppercase tracking-wide'
// The picked value carried on a completed rung — serif, strong ink so it pops past
// the muted label.
const NODE_CHOSEN = 'font-body text-sm font-semibold text-ink'
// The directional separator between rungs — decorative, so it is aria-hidden.
const SEP = 'font-ui text-xs text-ink-tertiary'

export const GuidedRail = forwardRef<HTMLOListElement, GuidedRailProps>(function GuidedRail(
  { rail, 'data-testid': dataTestId = 'guided-rail' },
  ref,
) {
  // Self-describing (label + chosen value), so it needs no landmark label.
  return (
    <ol
      ref={ref}
      data-testid={dataTestId}
      className="flex list-none flex-wrap items-center gap-[var(--space-2)] p-0"
    >
      {rail.map((rung, index) => (
        <li key={rung.step} className="flex items-center gap-[var(--space-2)]">
          {index > 0 && (
            <span aria-hidden="true" className={SEP}>
              →
            </span>
          )}
          <span data-state={rung.state} className={cn(NODE_BASE, NODE_STATE[rung.state])}>
            <span className={NODE_LABEL}>{rung.label}</span>
            {rung.chosen !== undefined && <span className={NODE_CHOSEN}>{rung.chosen}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
})
