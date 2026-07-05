import { forwardRef, Fragment } from 'react'
import type { GhostHookListProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Divider } from '../Divider/Divider.tsx'

// A richer sibling of GhostChoiceList (same borderless flat-1-bit ghost register)
// whose items STACK a serif title over an optional quiet place line over a prose
// paragraph — the narrative body the compact GhostChoiceItem can't hold. Static
// token class strings only (Tailwind v4 scans SOURCE TEXT — a template-built class
// never generates). No border — the hairline Dividers do the dividing, not a box.
// `items-start` (not center) so the trailing ember pins to the TOP of a tall prose
// block; a full-width row makes the whole item the hit target.
const ITEM_CLASS = cn(
  'group flex w-full items-start justify-between gap-[var(--space-4)] text-left',
  'bg-transparent text-ink rounded-none cursor-pointer select-none',
  'px-[var(--space-4)] py-[var(--space-5)]',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
// The stacked content column: a head block (title + place) then the prose body.
const TEXT_STACK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-2)]'
const HEAD_STACK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const TITLE_CLASS = 'font-body text-lg font-semibold leading-[1.4]'
const PLACE_CLASS = 'font-body text-sm text-ink-tertiary leading-[1.4]'
const PROSE_CLASS = 'font-body text-base text-ink-secondary leading-[1.5]'
// The trailing ember affordance — decorative (the title is the accessible name),
// fixed so it never squishes beside the wrapping content column.
const ARROW_CLASS = 'shrink-0 font-ui text-accent-fg'

export const GhostHookList = forwardRef<HTMLDivElement, GhostHookListProps>(
  function GhostHookList({ items, ...rest }, ref) {
    return (
      <div ref={ref} {...rest}>
        {items.map((item) => (
          <Fragment key={item.id}>
            <Divider tone="border" />
            <button type="button" onClick={item.onSelect} className={ITEM_CLASS}>
              <span className={TEXT_STACK_CLASS}>
                <span className={HEAD_STACK_CLASS}>
                  <span className={TITLE_CLASS}>{item.title}</span>
                  {item.place !== undefined && <span className={PLACE_CLASS}>{item.place}</span>}
                </span>
                <span className={PROSE_CLASS}>{item.prose}</span>
              </span>
              <span aria-hidden="true" className={ARROW_CLASS}>
                →
              </span>
            </button>
          </Fragment>
        ))}
        <Divider tone="border" />
      </div>
    )
  },
)
