import type { TranscriptItem } from '../../session/transcript-types.ts'
import type { EntityIndex } from '../../session/entity-index.ts'
import type { EntityHighlightLabels } from './dm-message-props.ts'
import type { RollRevealView } from '../../session/roll-reveal.ts'
import type { RollCardLabels } from './roll-card.ts'

// MessageStream (MYT-92) — the scroll container that maps each TranscriptItem to its
// renderer: `dm` → DmMessage, `player` → PlayerMessage, and each mechanical kind
// (skill_check / dice_roll / ledger_update / mode_change / combat_*) → a terse
// --font-ui (IBM Plex Mono) system line. `connectionLine` is the quiet reconnect /
// system line pinned when non-null; `reducedMotion` switches auto-follow to INSTANT
// positioning (no smooth-scroll vestibular trigger). Platform-neutral (§9): pure data,
// no DOM types. The item model is read off THIS contract surface (TranscriptItem is
// re-exported by the session barrel), not a second import.
//
// MYT-93 (spec §5) APPENDS the dice-moment reveal seam: `skill_check` / `dice_roll`
// items now dispatch to a RollCard whose phase comes from `rollReveal.phaseByKey`, and
// a `dm` item whose turnId ∈ `rollReveal.gatedTurnIds` renders NOTHING (the post-check
// prose buffer, released on Continue). The reveal view + labels are computed route-side
// by client-core selectors and passed as plain data, so MessageStream stays presentational
// (no client-core runtime import — R1).
//
// MYT-94 (Task 11) appends the settled-prose entity-highlighting seam — append-only
// optionals threaded straight through to the `dm` arm (DmMessage owns the settle-only
// gating + the once-per-row memoized segmentation). Absent ⇒ plain DM prose (MYT-92
// back-compat). The two extensions union cleanly (distinct field names).

/** Props for the play-transcript scroll container. */
export interface MessageStreamProps {
  /** The ordered transcript rows to render (DM / player / mechanical). */
  items: readonly TranscriptItem[]
  /** A quiet reconnect / system line pinned when non-null (else nothing). */
  connectionLine: string | null
  /** Honour reduced motion — auto-follow uses instant positioning, no smooth scroll. */
  reducedMotion: boolean
  /** Derived reveal data (per-card phase + the set of prose-gated turnIds) — MYT-93. */
  rollReveal: RollRevealView
  /** Resolved [ph:] label bundle threaded to each RollCard — MYT-93. */
  rollLabels: RollCardLabels
  /** Commit a card's roll, keyed by item key (neutral callback) — MYT-93. */
  onRoll: (key: string) => void
  /** Release a card's buffered prose (Continue), keyed by item key — MYT-93. */
  onContinue: (key: string) => void
  /** The compiled entity index — forwarded to the `dm` arm so SETTLED DM rows highlight
   *  recognized entity names (Task 11). Absent ⇒ plain DM prose. */
  highlight?: EntityIndex
  /** Fired when a chat mention's "open in wiki" action is chosen (forwarded to the dm arm). */
  onEntityOpen?: (entityId: string) => void
  /** Resolved popover / mention chrome, forwarded to the dm arm alongside `highlight`. */
  highlightLabels?: EntityHighlightLabels
}
