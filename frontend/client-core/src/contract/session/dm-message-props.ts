// DmMessage (MYT-92) — the DM's narrative register: Source Serif 4 prose composed over
// the shipped StreamingProse (append-only text node + the brand caret while `streaming`,
// zero-reflow handoff to static text on settle). A thin wrapper that fixes the DM
// register (serif, paper) — it does NOT re-implement the caret. `text` is DATA (LLM
// prose), never an i18n key. Platform-neutral (§9): pure data, no DOM types.

/** Props for one DM prose row. */
export interface DmMessageProps {
  /** The DM prose to render (LLM output — DATA, not an i18n key). */
  text: string
  /** Whether the turn is still streaming (drives the writing caret). */
  streaming: boolean
  /** Optional resolved [ph:] screen-reader annotation announced while writing. */
  writingLabel?: string
}
