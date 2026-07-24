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
 * a docked ember "enter" arrow vertically centred against the card, and a decisive
 * hover (edge darkens to full ink + the neutral surface token-swap). The ENTIRE
 * card is the click target — one tab-stop, one focus ring. Cards are separated by
 * a gap (not hairline rules). Single column at every width; flat (`rounded-none`).
 * Used for the campaign-create fork and the character-create path chooser.
 *
 * Platform-neutral (§9): each item's `onSelect` is a neutral callback, never a DOM
 * event; no `className`/`style`/raw DOM events.
 */
export interface GhostChoiceListProps extends BaseProps {
  /** The choices, top to bottom. Each is a real, keyboard-activable button. */
  items: readonly GhostChoiceItem[]
}
