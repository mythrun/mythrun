// PlayerMessage (MYT-92) — the humans at the table in --font-ui (IBM Plex Mono), the
// mechanical register that IS the DM/player distinction. Register pin (spec §2): NO
// avatar, NO chat-bubble idiom, no circles / status dots — `pending` renders a quiet
// dimmed in-flight treatment (a tint), never a spinner. `text` is DATA (player input),
// never an i18n key. Platform-neutral (§9): pure data, no DOM types.

/** Props for one player-message row. */
export interface PlayerMessageProps {
  /** The player's display name (the human at the table). */
  displayName: string
  /** The player's character name (the persona in the fiction). */
  characterName: string
  /** The message text (player input — DATA, not an i18n key). */
  text: string
  /** In-flight own message awaiting server echo — a quiet dimmed treatment (no spinner). */
  pending: boolean
}
