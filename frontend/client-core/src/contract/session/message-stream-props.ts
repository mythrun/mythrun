import type { TranscriptItem } from '../../session/transcript-types.ts'

// MessageStream (MYT-92) — the scroll container that maps each TranscriptItem to its
// renderer: `dm` → DmMessage, `player` → PlayerMessage, and each mechanical kind
// (skill_check / dice_roll / ledger_update / mode_change / combat_*) → a terse
// --font-ui (IBM Plex Mono) system line. `connectionLine` is the quiet reconnect /
// system line pinned when non-null; `reducedMotion` switches auto-follow to INSTANT
// positioning (no smooth-scroll vestibular trigger). Platform-neutral (§9): pure data,
// no DOM types. The item model is read off THIS contract surface (TranscriptItem is
// re-exported by the session barrel), not a second import.

/** Props for the play-transcript scroll container. */
export interface MessageStreamProps {
  /** The ordered transcript rows to render (DM / player / mechanical). */
  items: readonly TranscriptItem[]
  /** A quiet reconnect / system line pinned when non-null (else nothing). */
  connectionLine: string | null
  /** Honour reduced motion — auto-follow uses instant positioning, no smooth scroll. */
  reducedMotion: boolean
}
