import { forwardRef } from 'react'
import type { GhostChoiceListProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// A carded "paper" choice list — the flat 1-bit register, brought up to the
// LevelCard standard (ux-run1 myth-occld). The earlier build styled each choice
// as a borderless ghost row split by hairline Dividers, with the ember arrow
// stranded far-right across empty cream: it read as a magazine table-of-contents,
// not a set of choices — nothing (fill/border/box) signalled the row was a target.
// The fix is a BOUNDED SELECTABLE SURFACE per option: each choice is a real
// `<button>` that is a whole card — a 1px interactive `--border-strong` edge on the
// `--surface` fill, comfortable padding, the arrow docked top-right on the title's
// line (ux-run2 myth-ma8yv: a vertically-centred arrow read as a survivor of a
// layout accident, not the card's punctuation), and a decisive hover (edge darkens
// to full ink + the neutral surface token-swap). The whole card is one tab-stop /
// one focus ring. TWO SHAPES (ux-run2 myth-ma8yv, critique 024): the default
// stacked strip list, and a `columns={2}` side-by-side pair of taller cards for a
// true binary fork (two doors, not a stack of bars) that restacks on narrow
// viewports. Static token class strings only (Tailwind v4 scans SOURCE TEXT — a
// template-built class never generates).
const CARD_CLASS = cn(
  'group flex w-full min-w-0 items-start justify-between gap-[var(--space-4)] text-left',
  // The bounded card: square (flat 1-bit) interactive-grade edge + surface fill +
  // breathing padding. The box IS the "this is a target" signal.
  'rounded-none border border-border-strong bg-surface cursor-pointer select-none',
  'p-[var(--space-5)]',
  'transition-[border-color,background-color] duration-[var(--duration-fast)]',
  // Decisive hover/press: the edge darkens to full ink + the neutral surface
  // token-swap (the shipped ghost/LevelCard affordance). No shadow-pop — depth via
  // borders keeps the 1-bit register.
  'hover:border-ink hover:bg-surface-hover active:bg-surface-active',
  // Shared theme-aware focus ring (identical to every other DS control).
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
// The side-by-side (columns=2) card is TALLER — a chunky door, sibling of the
// situation-picker cards, with quiet paper below the copy instead of a letterbox.
const TALL_CARD_CLASS = 'min-h-[10rem]'
// The serif choice headline (the narrative register) over a quiet tertiary-ink
// sub-line; min-w-0 lets a long line wrap instead of overflowing at 375px.
const TEXT_STACK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const TITLE_CLASS = 'font-body text-lg font-semibold leading-[1.4]'
const SUBTITLE_CLASS = 'font-body text-sm text-ink-tertiary leading-[1.4]'
// The trailing ember affordance — the card's "enter" cue (decorative; the title is
// the accessible name). Docked top-right on the title's line (leading matches the
// title's line box) and it nudges right on hover so the whole card reads as
// pressable. `shrink-0` so it never squishes.
const ARROW_CLASS = cn(
  'shrink-0 font-ui text-xl leading-[1.4] text-accent-fg',
  'transition-transform duration-[var(--duration-fast)] group-hover:translate-x-[2px]',
)
// The default stacked strip list vs the side-by-side fork pair (restacks below
// `sm` so 375px keeps the single column).
const LIST_STACKED_CLASS = 'flex flex-col gap-[var(--space-4)]'
const LIST_SPLIT_CLASS = 'grid grid-cols-1 gap-[var(--space-4)] sm:grid-cols-2'

export const GhostChoiceList = forwardRef<HTMLDivElement, GhostChoiceListProps>(
  function GhostChoiceList({ items, columns = 1, ...rest }, ref) {
    return (
      <div ref={ref} className={columns === 2 ? LIST_SPLIT_CLASS : LIST_STACKED_CLASS} {...rest}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onSelect}
            className={cn(CARD_CLASS, columns === 2 && TALL_CARD_CLASS)}
            {...(item.testId !== undefined && { 'data-testid': item.testId })}
          >
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
        ))}
      </div>
    )
  },
)
