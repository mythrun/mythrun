import { forwardRef, Fragment } from 'react'
import type { GhostChoiceListProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Divider } from '../Divider/Divider.tsx'

// Static token class strings only (Tailwind v4 scans SOURCE TEXT — a
// template-built class never generates). The ghost treatment mirrors Button's
// `variant="ghost"` (transparent fill, neutral surface hover/active token-swap)
// plus the shared theme-aware focus ring; NO border — the hairline Dividers do
// the dividing, not a box. Generous padding + a full-width row so the rules span
// the whole content column and the whole row is the hit target.
const ITEM_CLASS = cn(
  'group flex w-full items-center justify-between gap-[var(--space-4)] text-left',
  'bg-transparent text-ink rounded-none cursor-pointer select-none',
  'px-[var(--space-4)] py-[var(--space-5)]',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
// The serif choice headline (the narrative register) over a quiet tertiary-ink
// sub-line; min-w-0 lets a long line wrap instead of overflowing at 375px.
const TEXT_STACK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const TITLE_CLASS = 'font-body text-lg font-semibold leading-[1.4]'
const SUBTITLE_CLASS = 'font-body text-sm text-ink-tertiary leading-[1.4]'
// The trailing ember affordance — decorative (the title is the accessible name),
// fixed so it never squishes beside a wrapping title.
const ARROW_CLASS = 'shrink-0 font-ui text-accent-fg'

export const GhostChoiceList = forwardRef<HTMLDivElement, GhostChoiceListProps>(
  function GhostChoiceList({ items, ...rest }, ref) {
    return (
      <div ref={ref} {...rest}>
        {items.map((item) => (
          <Fragment key={item.id}>
            <Divider tone="border" />
            <button type="button" onClick={item.onSelect} className={ITEM_CLASS}>
              <span className={TEXT_STACK_CLASS}>
                <span className={TITLE_CLASS}>{item.title}</span>
                {item.subtitle !== undefined && (
                  <span className={SUBTITLE_CLASS}>{item.subtitle}</span>
                )}
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
