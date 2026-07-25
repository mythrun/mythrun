import type { CuratedSheet, FullSheet } from './types.ts'

// CharacterSheetReveal (MYT-90) — the "Meet your character" reveal: the curated
// field-guide sheet a new player meets their character through, with an opt-in
// expansion to the full mechanical detail, then confirm (into the party) or start
// over. CONTROLLED expansion: the parent owns `expanded`. Platform-neutral (§9):
// the toggle/confirm/start-over callbacks are plain functions — never DOM events.

/** The reveal's resolved chrome labels (the shell resolves i18n and passes them). */
export interface CharacterSheetRevealLabels {
  /** The confirm-into-the-party CTA (e.g. "This is me"). */
  confirm: string
  /** The expand-to-full-sheet toggle in its collapsed state (e.g. "See full sheet"). */
  seeFull: string
  /** The same toggle in its expanded state (e.g. "Hide full sheet"). */
  hideFull: string
  /** The discard-and-restart control (e.g. "Start over" — zero shared morphology
   *  with the confirm verb; ux-run2 myth-fca4y). */
  startOver: string
  /** The start-over confirm prompt (e.g. "Start over? This discards this character."). */
  startOverPrompt: string
  /** The start-over confirm verb (e.g. "Yes, start over"). */
  startOverConfirm: string
  /** The start-over dismiss verb (e.g. "Keep them"). */
  startOverKeep: string
  /** The curated "what they can do" panel title. */
  panelFeatures: string
  /** The curated "what they carry" panel title. */
  panelEquipment: string
  /** The curated "what they can cast" panel title. */
  panelSpells: string
}

/** Props for the character-sheet reveal. */
export interface CharacterSheetRevealProps {
  /** The resolved chrome labels (the shell resolves i18n and passes them). */
  labels: CharacterSheetRevealLabels
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
  /** The start-over confirm's CONTROLLED disclosure state (ux-run2 myth-fca4y):
   *  `true` renders the inline confirm (prompt + confirm/dismiss verbs) in place
   *  of the start-over control. The parent owns it — the reveal stays fully
   *  controlled; the destructive act fires only from `onStartOver`. */
  startOverConfirming: boolean
  /** Ask to start over — the parent arms the inline confirm. */
  onRequestStartOver: () => void
  /** Dismiss the start-over confirm, keeping the character. */
  onCancelStartOver: () => void
  /** Discard and restart character creation (fired from the confirm verb only). */
  onStartOver: () => void
}
