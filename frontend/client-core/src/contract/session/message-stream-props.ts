import type { TranscriptItem } from '../../session/transcript-types.ts'
import type { EntityIndex } from '../../session/entity-index.ts'
import type { EntityHighlightLabels } from './dm-message-props.ts'

// MessageStream (MYT-92) — the scroll container that maps each TranscriptItem to its
// renderer: `dm` → DmMessage, `player` → PlayerMessage, and each mechanical kind
// (skill_check / dice_roll / ledger_update / mode_change / combat_*) → a terse
// --font-ui (IBM Plex Mono) system line. `connectionLine` is the quiet reconnect /
// system line pinned when non-null; `reducedMotion` switches auto-follow to INSTANT
// positioning (no smooth-scroll vestibular trigger). Platform-neutral (§9): pure data,
// no DOM types. The item model is read off THIS contract surface (TranscriptItem is
// re-exported by the session barrel), not a second import.
//
// MYT-94 (Task 11) appends the settled-prose entity-highlighting seam — append-only
// optionals threaded straight through to the `dm` arm (DmMessage owns the settle-only
// gating + the once-per-row memoized segmentation). Absent ⇒ plain DM prose (MYT-92
// back-compat). The `dm`/`player` register arms and the mechanical arms are otherwise
// untouched (the mechanical arms are MYT-93's rendering seam).

/** Props for the play-transcript scroll container. */
export interface MessageStreamProps {
  /** The ordered transcript rows to render (DM / player / mechanical). */
  items: readonly TranscriptItem[]
  /** A quiet reconnect / system line pinned when non-null (else nothing). */
  connectionLine: string | null
  /** Honour reduced motion — auto-follow uses instant positioning, no smooth scroll. */
  reducedMotion: boolean
  /** The compiled entity index — forwarded to the `dm` arm so SETTLED DM rows highlight
   *  recognized entity names (Task 11). Absent ⇒ plain DM prose. */
  highlight?: EntityIndex
  /** Fired when a chat mention's "open in wiki" action is chosen (forwarded to the dm arm). */
  onEntityOpen?: (entityId: string) => void
  /** Resolved popover / mention chrome, forwarded to the dm arm alongside `highlight`. */
  highlightLabels?: EntityHighlightLabels
}
