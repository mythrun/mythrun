// DmMessage (MYT-92) — the DM's narrative register: Source Serif 4 prose composed over
// the shipped StreamingProse (append-only text node + the brand caret while `streaming`,
// zero-reflow handoff to static text on settle). A thin wrapper that fixes the DM
// register (serif, paper) — it does NOT re-implement the caret. `text` is DATA (LLM
// prose), never an i18n key. Platform-neutral (§9): pure data, no DOM types.
//
// MYT-94 (Task 11) appends the SETTLED-prose entity-highlighting seam — append-only
// optionals, so every MYT-92 caller is unaffected. When `highlight` (the compiled
// entity index) and `highlightLabels` are present AND the turn is SETTLED, recognized
// entity names are highlighted (a mention → a terse knowledge popover). Highlighting is
// NEVER applied while `streaming` (spec §6: no mid-stream reflow) — the streaming path is
// byte-identical with or without these props.

import type { EntityIndex, EntityGlyph } from '../../session/entity-index.ts'

/**
 * Resolved chrome for the entity mention + popover (MYT-94). The composing route owns
 * i18n, so these are RESOLVED strings / resolvers. The entity NAME is DATA (from the
 * model), interpolated into the accessible name via {@link EntityHighlightLabels.mentionLabelFor}.
 * Bundled (rather than spread as loose props) so the seam stays a single append-only field
 * on both DmMessage and MessageStream; supplied alongside `highlight`.
 */
export interface EntityHighlightLabels {
  /** Build the mention + popover accessible name from the (data) entity name — e.g.
   *  `t('session.entity.mention', { name })`. */
  mentionLabelFor: (name: string) => string
  /** The entity-type label beside the glyph (npc / location / faction) — a resolved i18n key. */
  typeLabelFor: (glyph: EntityGlyph) => string
  /** The "open in wiki" action label — a resolved i18n key. */
  openInWikiLabel: string
}

/** Props for one DM prose row. */
export interface DmMessageProps {
  /** The DM prose to render (LLM output — DATA, not an i18n key). */
  text: string
  /** Whether the turn is still streaming (drives the writing caret). */
  streaming: boolean
  /** Optional resolved [ph:] screen-reader annotation announced while writing. */
  writingLabel?: string
  /** The compiled entity index (Task 3). When present AND the turn is SETTLED, recognized
   *  entity names highlight (mention → popover). NEVER applied while `streaming` (spec §6:
   *  no mid-stream reflow). Absent ⇒ plain prose (MYT-92 back-compat). */
  highlight?: EntityIndex
  /** Fired when a mention's "open in wiki" action is chosen — the route opens the sidebar's
   *  wiki tab to this entity (Task 14). */
  onEntityOpen?: (entityId: string) => void
  /** Resolved popover / mention chrome — supplied alongside `highlight` (highlighting is
   *  skipped if this is absent, so the pair is effectively required together). */
  highlightLabels?: EntityHighlightLabels
}
