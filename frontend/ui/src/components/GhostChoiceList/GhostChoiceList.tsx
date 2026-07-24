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
// `--surface` fill, comfortable padding, the arrow docked and vertically centred
// against the full card height, and a decisive hover (edge darkens to full ink +
// the neutral surface token-swap). The whole card is one tab-stop / one focus ring.
// Static token class strings only (Tailwind v4 scans SOURCE TEXT — a template-built
// class never generates).
const CARD_CLASS = cn(
  'group flex w-full min-w-0 items-center justify-between gap-[var(--space-4)] text-left',
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
// The serif choice headline (the narrative register) over a quiet tertiary-ink
// sub-line; min-w-0 lets a long line wrap instead of overflowing at 375px.
const TEXT_STACK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-1)]'
const TITLE_CLASS = 'font-body text-lg font-semibold leading-[1.4]'
const SUBTITLE_CLASS = 'font-body text-sm text-ink-tertiary leading-[1.4]'
// The trailing ember affordance — the card's "enter" cue (decorative; the title is
// the accessible name). Docked to the card, vertically centred, and it nudges right
// on hover so the whole card reads as pressable. `shrink-0` so it never squishes.
const ARROW_CLASS = cn(
  'shrink-0 self-center font-ui text-lg text-accent-fg',
  'transition-transform duration-[var(--duration-fast)] group-hover:translate-x-[2px]',
)

export const GhostChoiceList = forwardRef<HTMLDivElement, GhostChoiceListProps>(
  function GhostChoiceList({ items, ...rest }, ref) {
    return (
      <div ref={ref} className="flex flex-col gap-[var(--space-4)]" {...rest}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onSelect}
            className={CARD_CLASS}
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
