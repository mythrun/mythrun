import { forwardRef } from 'react'
import type { GhostHookListProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// A carded "paper" hook list — the richer sibling of GhostChoiceList, brought up
// to the LevelCard standard (ux-run1 myth-occld). Each item STACKS a serif title
// over an optional quiet place line over a prose paragraph. The earlier build was
// a borderless ghost row split by hairline Dividers with the ember arrow stranded
// ~900px far-right of its title across empty cream, and the prose ran the full
// content width (~140ch): it read as a magazine table-of-contents, not a set of
// choices. The fix is a BOUNDED SELECTABLE SURFACE per hook: a real `<button>`
// that is a whole card — a 1px interactive `--border-strong` edge on `--surface`,
// comfortable padding, the arrow docked and vertically centred against the full
// card height, a decisive hover (edge → full ink + surface token-swap), and the
// prose capped to a readable measure (~62ch) so the line no longer outruns the
// return sweep. The whole card is one tab-stop / one focus ring. Static token
// class strings only (Tailwind v4 scans SOURCE TEXT — a template-built class never
// generates).
const CARD_CLASS = cn(
  'group flex w-full min-w-0 items-center justify-between gap-[var(--space-4)] text-left',
  'rounded-none border border-border-strong bg-surface cursor-pointer select-none',
  'p-[var(--space-5)]',
  'transition-[border-color,background-color] duration-[var(--duration-fast)]',
  'hover:border-ink hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
// The stacked content column: a head block (title + place) then the prose body.
// Capped to a readable measure so the prose does not run the full card width.
const TEXT_STACK_CLASS = 'flex min-w-0 max-w-[62ch] flex-col gap-[var(--space-2)]'
const HEAD_STACK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const TITLE_CLASS = 'font-body text-lg font-semibold leading-[1.4]'
const PLACE_CLASS = 'font-body text-sm text-ink-tertiary leading-[1.4]'
const PROSE_CLASS = 'font-body text-base text-ink-secondary leading-[1.5]'
// The trailing ember affordance — the card's "enter" cue (decorative; the title is
// the accessible name). Docked, vertically centred against the full card height,
// nudging right on hover so the whole card reads as pressable. `shrink-0` so it
// never squishes beside the wrapping content column.
const ARROW_CLASS = cn(
  'shrink-0 self-center font-ui text-lg text-accent-fg',
  'transition-transform duration-[var(--duration-fast)] group-hover:translate-x-[2px]',
)

export const GhostHookList = forwardRef<HTMLDivElement, GhostHookListProps>(
  function GhostHookList({ items, ...rest }, ref) {
    return (
      <div ref={ref} className="flex flex-col gap-[var(--space-4)]" {...rest}>
        {items.map((item) => (
          <button key={item.id} type="button" onClick={item.onSelect} className={CARD_CLASS}>
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
        ))}
      </div>
    )
  },
)
