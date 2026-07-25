import type { BaseProps } from './index.ts'

/**
 * One choice in a {@link GhostChoiceListProps} list. `title`/`subtitle` are
 * already-resolved display strings (the consumer resolves any i18n key). Choosing
 * it fires the item's own neutral {@link GhostChoiceItem.onSelect} — no DOM event (§9).
 */
export interface GhostChoiceItem {
  /** Stable id — the React key and the caller's identity for the choice. */
  id: string
  /** The choice's serif headline (resolved display string). */
  title: string
  /** Optional quiet sub-line under the title (resolved display string). */
  subtitle?: string
  /**
   * Optional cost-of-path line (resolved display string) — the quiet mono third
   * line seated at the card's FOOT ("About a minute." / "Five short steps."):
   * the real decision criterion between two doors, and the content that earns a
   * tall fork card its height instead of leaving the lower half as dead air
   * (ux-run3 myth-t6pxy). In the stacked strip shape it simply follows the
   * subtitle.
   */
  meta?: string
  /** Neutral activation callback — fired on click AND keyboard (Enter/Space). */
  onSelect: () => void
  /** Optional test hook rendered as `data-testid` on the choice's `<button>` —
   *  lets a consuming route address one option (the character-create chooser
   *  paths) without reaching for its accessible name. Never rendered to the user. */
  testId?: string
}

/**
 * A carded "paper" choice list — the flat 1-bit register, brought up to the
 * LevelCard standard (ux-run1 myth-occld). Renders each item as a real `<button>`
 * (native keyboard activation + a11y) that is a whole SELECTABLE CARD: a 1px
 * interactive `--border-strong` edge on the `--surface` fill, comfortable padding,
 * a docked ember "enter" arrow on the title's line, and a decisive
 * hover (edge darkens to full ink + the neutral surface token-swap). The ENTIRE
 * card is the click target — one tab-stop, one focus ring. Cards are separated by
 * a gap (not hairline rules); flat (`rounded-none`).
 * Used for the campaign-create fork and the character-create path chooser.
 *
 * Platform-neutral (§9): each item's `onSelect` is a neutral callback, never a DOM
 * event; no `className`/`style`/raw DOM events.
 */
export interface GhostChoiceListProps extends BaseProps {
  /** The choices, top to bottom. Each is a real, keyboard-activable button. */
  items: readonly GhostChoiceItem[]
  /**
   * Column count at comfortable widths. Default `1` — the stacked strip list.
   * `2` seats the choices SIDE BY SIDE as two taller, chunkier cards (a true
   * binary fork reads as two doors, not a stack of bars — ux-run2 myth-ma8yv,
   * critique 024); collapses back to one column on narrow viewports.
   */
  columns?: 1 | 2
}
