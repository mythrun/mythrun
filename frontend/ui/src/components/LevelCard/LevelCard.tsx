import { forwardRef } from 'react'
import type { LevelCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// LevelCard (MYT-90) — one owner-only starting-level pick (levels 1–5). The
// owner screen renders five of these; picking one sets the whole party's shared
// starting level. Pure/presentational: it renders from props and fires the
// neutral `onSelect` — no flow/network/selection state (that lives in the
// client-core view-model). The card is layout-agnostic: it is `w-full` and fills
// whatever cell its parent gives it (the 5-up grid on desktop, a single-column
// stack on mweb are the PARENT's concern), so its internal composition — mono
// eyebrow, big serif number, gloss over a hairline divider — reads the same at a
// narrow desktop cell and at 375px.
//
// It is a REAL <button>: native click AND keyboard (Enter/Space) both fire
// `onClick` → `onSelect`, satisfying the contract's "fired on click AND keyboard"
// with zero custom key handling. Selection is exposed to AT via `aria-pressed`
// (no hidden label text needed) and to tests/styling via `data-state`.
//
// Register (flat 1-bit / paper / SQUARE): `rounded-none`, a 1px `--border-strong`
// interactive edge, a `--surface` fill, NO circles/dots/chips. SELECTED recolors
// that edge to ember (`border-accent` — the shipped RadioGroup/Switch selection
// idiom) AND adds an inset 2px ember ring (the mockup's `box-shadow: inset …`);
// the border WIDTH is unchanged so selecting never shifts layout. Hover/press use
// the neutral surface token-swap (the shipped ghost/secondary affordance), and
// focus rides the shared theme-aware `outline-accent-fg` ring.
//
// The eyebrow (e.g. "Level") arrives resolved via `eyebrow` — the shell owns i18n
// and passes it in (MYT-100 grew the contract the label prop, exactly as anticipated
// when it was interim brand chrome).

const CARD_CLASS = cn(
  // Reset the native <button> to the paper-card register + fill its cell.
  'group flex w-full min-w-0 cursor-pointer select-none flex-col gap-[var(--space-2)] text-left',
  'rounded-none border border-border-strong bg-surface p-[var(--space-4)]',
  'transition-[box-shadow,border-color,background-color] duration-[var(--duration-fast)]',
  // Hover/press affordance — the neutral surface token-swap (shipped ghost idiom).
  'hover:bg-surface-hover active:bg-surface-active',
  // Shared theme-aware focus ring.
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
  // SELECTED: recolor the edge to ember (same width — no layout shift) + an inset
  // 2px ember ring. `var(--accent)` is a semantic var (flips light/dark), so the
  // arbitrary shadow value is token-driven, not a frozen raw color.
  'data-[state=selected]:border-accent',
  'data-[state=selected]:shadow-[inset_0_0_0_2px_var(--accent)]',
)

// The mono uppercase eyebrow (the machine-register label over the number).
// Muted ink at rest; ember ONLY on the selected card (ux-run2 myth-nyjtl) — with
// the confirm button, accent then means exactly two things: "chosen" and "act".
const EYEBROW_CLASS = cn(
  'font-ui text-xs font-medium uppercase tracking-wide text-ink-tertiary',
  'group-data-[state=selected]:text-accent-fg',
)
// The hero number — big serif, tight leading so it sits close under the eyebrow.
const NUMBER_CLASS = 'font-body text-3xl font-semibold leading-[1]'
// The plain-D&D grant gloss — quiet secondary-ink serif over a hairline top rule.
const GRANT_CLASS = 'border-t border-border pt-[var(--space-2)] font-body text-sm leading-[1.4] text-ink-secondary'

export const LevelCard = forwardRef<HTMLButtonElement, LevelCardProps>(function LevelCard(
  { eyebrow, level, grantGloss, selected, onSelect },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid="level-card"
      data-level={level}
      data-state={selected ? 'selected' : 'default'}
      className={CARD_CLASS}
    >
      {/* The resolved machine-register eyebrow (shell-owned i18n). */}
      <span className={EYEBROW_CLASS}>{eyebrow}</span>
      <span className={NUMBER_CLASS}>{level}</span>
      <span className={GRANT_CLASS}>{grantGloss}</span>
    </button>
  )
})
