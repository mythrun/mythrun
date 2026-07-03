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
}

/**
 * A borderless "paper" choice list — the flat 1-bit register. Renders each item
 * as a real `<button>` (native keyboard activation + a11y), styled as a ghost
 * (`bg-transparent`, hover token-swap, NO border/box/glyph-mark), with the whole
 * list framed AND separated by quiet `Divider` hairlines (a rule above the first
 * item, between each, and below the last). Single column at every width; flat
 * (`rounded-none`). Used for the campaign-create fork.
 *
 * Platform-neutral (§9): each item's `onSelect` is a neutral callback, never a DOM
 * event; no `className`/`style`/raw DOM events.
 */
export interface GhostChoiceListProps extends BaseProps {
  /** The choices, top to bottom. Each is a real, keyboard-activable button. */
  items: readonly GhostChoiceItem[]
}
