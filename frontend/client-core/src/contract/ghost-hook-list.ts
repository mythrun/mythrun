import type { BaseProps } from './index.ts'

/**
 * One hook in a {@link GhostHookListProps} list — a richer sibling of
 * {@link import('./ghost-choice-list.ts').GhostChoiceItem}: a headline PLUS an
 * optional place tag AND a prose paragraph (the narrative body the compact
 * `title`/`subtitle` GhostChoiceItem can't hold). `title`/`place`/`prose` are
 * already-resolved display strings (DATA the consumer supplies, not i18n keys —
 * these carry LLM-authored content). Choosing it fires the item's own neutral
 * {@link GhostHookItem.onSelect} — no DOM event (§9).
 */
export interface GhostHookItem {
  /** Stable id — the React key and the caller's identity for the hook. */
  id: string
  /** The hook's serif headline (resolved display string). */
  title: string
  /** Optional quiet place / where sub-line under the title (resolved display string). */
  place?: string
  /** The hook's prose paragraph (resolved display string). */
  prose: string
  /** Neutral activation callback — fired on click AND keyboard (Enter/Space). */
  onSelect: () => void
}

/**
 * A borderless "paper" hook list — the flat 1-bit register, a richer sibling of
 * GhostChoiceList. Each item is a real `<button>` styled as a ghost
 * (`bg-transparent`, hover token-swap, NO border/box/glyph-mark), STACKING a serif
 * title over an optional quiet place line over a prose paragraph, with the whole
 * list framed AND separated by quiet `Divider` hairlines (a rule above the first
 * item, between each, and below the last). Single column at every width; flat
 * (`rounded-none`). Used for the starting-situation pick (three opening hooks).
 *
 * Platform-neutral (§9): each item's `onSelect` is a neutral callback, never a DOM
 * event; no `className`/`style`/raw DOM events.
 */
export interface GhostHookListProps extends BaseProps {
  /** The hooks, top to bottom. Each is a real, keyboard-activable button. */
  items: readonly GhostHookItem[]
}
