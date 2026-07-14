// ThinkingIndicator (MYT-92) — a quiet --font-ui line: "DM is thinking…" while
// `thinking`, plus player typing from `typingNames` (typing_start / typing_stop).
// Register pin (spec §2): PURELY PRESENTATIONAL — the useSession hook (Task 6) owns the
// CLEAR conditions (the first text_delta / turn_end / turn_error for the open turn), so
// a stuck indicator can't survive a reconnect; this component just renders the current
// booleans/names and announces them via a polite live region. Platform-neutral (§9):
// pure data + resolved [ph:] labels, no DOM types.

/** Props for the thinking / typing indicator. */
export interface ThinkingIndicatorProps {
  /** Whether a DM turn is currently open (the hook keys + clears this, not the component). */
  thinking: boolean
  /** The display names of players currently typing (typing_start minus typing_stop). */
  typingNames: readonly string[]
  /** Resolved [ph:] "DM is thinking…" label. */
  thinkingLabel: string
  /** Resolved [ph:] "… is typing" label template. */
  typingLabel: string
}
