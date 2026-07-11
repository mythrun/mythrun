import type { CuratedSheet, FullSheet } from './types.ts'

// CharacterSheetReveal (MYT-90) — the "Meet your character" reveal: the curated
// field-guide sheet a new player meets their character through, with an opt-in
// expansion to the full mechanical detail, then confirm (into the party) or start
// over. CONTROLLED expansion: the parent owns `expanded`. Platform-neutral (§9):
// the toggle/confirm/start-over callbacks are plain functions — never DOM events.

/** Props for the character-sheet reveal. */
export interface CharacterSheetRevealProps {
  /** The curated field-guide sheet (the default, prose-forward view). */
  curated: CuratedSheet
  /** The expanded mechanical sheet (shown when `expanded`). */
  full: FullSheet
  /** Whether the full mechanical detail is currently shown (controlled). */
  expanded: boolean
  /** Toggle the expanded detail. */
  onToggleExpand: () => void
  /** Confirm this character and move to the party roster. */
  onConfirm: () => void
  /** Discard and restart character creation. */
  onStartOver: () => void
}
