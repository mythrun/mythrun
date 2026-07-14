// The MYT-94 knowledge-layer contract — the DOM-free prop + shared-type vocabulary
// the @mythrun/ui knowledge components (EntityMention / EntityPopover / SessionSheet
// / KnowledgeSidebar) import their props from (the enforced portability seam, R1).
// Type-only: this module carries no runtime values (the contract barrel asserts the
// whole surface is keyless).
//
// The brain view-models live in `../session` (the client-core brain) — the matcher
// index (Task 3), the knowledge cache (Task 2), the in-session sheet view-model
// (Task 6), and the ledger→character-state overlay (Task 5). This module RE-EXPORTS
// their shapes so a consuming component reads the model off the SAME contract surface
// it reads the props from (mirrors how `world-wiki.ts` re-exports `WikiViewModel` and
// `world-gen-graph.ts` re-exports `GraphNode`/`GraphEdge`). Type-only re-exports are
// erased under `isolatedModules`, so there is no runtime edge from the DS to the brain.
//
// MONOCHROME REGISTER (spec §6 pin): the entity glyph conveys TYPE (npc/location/
// faction) via SHAPE only — no entity-type color is derived anywhere in this surface.

import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'
import type { EntityCard, EntityGlyph } from '../session/entity-index.ts'
import type { KnowledgeCache } from '../session/knowledge-cache.ts'
import type { SessionSheetState } from '../session/use-session-sheet.ts'
import type { CharacterOverlay } from '../session/ledger-reducer.ts'
import type { CuratedSheet } from './character/index.ts'
import type { WorldWikiProps } from './world-wiki.ts'

// The matcher vocabulary (Task 3) — the settled-prose segmentation model + the terse
// popover card + the compiled index. Re-exported so the highlighter (Task 11) and the
// popover (Task 10) read them off this contract surface, not a second brain import.
export type { EntityGlyph, EntityCard, ProseSegment, EntityIndex } from '../session/entity-index.ts'

// The three brain view-models the sidebar composes (Tasks 2/5/6). Re-exported so the
// KnowledgeSidebar / SessionSheet contracts below and their consumers (Tasks 12/13)
// share one canonical shape. `KnowledgeCache.graph` structurally carries the graph
// seed (`GraphNode[]`/`GraphEdge[]` — already on the contract via world-gen-graph.ts),
// so a consumer reads `cache.graph.nodes` without naming the seed here.
export type { KnowledgeCache } from '../session/knowledge-cache.ts'
export type { SessionSheetState } from '../session/use-session-sheet.ts'
export type { CharacterOverlay } from '../session/ledger-reducer.ts'

/** The three sidebar tabs. CONTROLLED (`activeTab`/`onTabChange`) so a chat-highlight
 *  click can force the wiki tab (UX §9's graph↔wiki bridge lands the tap on the page). */
export type KnowledgeTab = 'wiki' | 'graph' | 'sheet'

/**
 * The WorldWiki chrome labels the sidebar forwards to its embedded `WorldWiki` (the
 * wiki's data + navigation callbacks come from the cache + the sidebar's own state, so
 * only the labels pass through). Derived from `WorldWikiProps` via `Pick` so this bundle
 * cannot drift from the wiki's label surface — a renamed WorldWiki label is a compile
 * error here. Optional (each defaults to a `[ph:]` inside WorldWiki); the composing
 * route resolves them from i18n. Spread straight onto `<WorldWiki {...wikiLabels} />`.
 */
export type WikiTabLabels = Pick<
  WorldWikiProps,
  | 'searchLabel'
  | 'searchPlaceholder'
  | 'groupLabels'
  | 'emptyLabel'
  | 'backLabel'
  | 'relatedLabel'
  | 'emptyBodyLabel'
  | 'referencesLabel'
  | 'indexLabel'
>

/**
 * The character-sheet chrome labels the sidebar forwards to its embedded `SessionSheet`.
 * Derived from `SessionSheetPanelProps` via `Pick` (same no-drift discipline as
 * {@link WikiTabLabels}); resolved i18n keys the composing route supplies.
 */
export type SessionSheetLabels = Pick<SessionSheetPanelProps, 'hpLabel' | 'conditionsLabel' | 'emptyLabel'>

/**
 * EntityMention (Task 9) — an inline, focusable trigger rendered INSIDE settled DM
 * serif prose: the recognized entity name with a subtle resting underline; hover/focus
 * changes the underline style and reveals a small leading type glyph (`glyph`). MONOCHROME
 * — no entity-type color. The name TEXT is DATA (from the model); `label` is the resolved
 * a11y name ("entity: <name>", the name interpolated as data). The popover (Task 10) wraps
 * this trigger, so `EntityMention` itself owns no open state. Platform-neutral (§9): no
 * className/style/raw DOM events; activation is keyboard + pointer via the wrapping popover.
 */
export interface EntityMentionProps extends Omit<BaseProps, 'children'> {
  /** The recognized entity name, rendered verbatim in-prose (DATA, not a key). */
  text: string
  /** The leading type glyph shown on hover/focus (npc/location/faction; `other` = no glyph). */
  glyph: EntityGlyph
  /** The resolved accessible name for the trigger — the entity name interpolated into an
   *  i18n'd "entity: <name>" role string. */
  label: string
}

/**
 * EntityPopover (Task 10) — the terse one-tap knowledge card wrapping an `EntityMention`
 * trigger. Composes the shipped `Popover` (focus trap + return). Content is terse (spec
 * §6): the entity name (serif) + the leading type glyph + `typeLabel` (mono) + the
 * `card.leadLine` (one line, omitted when empty) + an "open in wiki" action. Nothing else
 * — the rich knowledge is one tap away in the wiki tab. Platform-neutral (§9): controlled
 * `open`/`onOpenChange`, neutral `onOpenInWiki`, i18n-key labels, no DOM events.
 */
export interface EntityPopoverProps extends Omit<BaseProps, 'children'> {
  /** The resolved popover content — name + glyph + `leadLine` (empty ⇒ the line is omitted). */
  card: EntityCard
  /** Whether the popover is open (controlled). */
  open: boolean
  /** Fired with the next open state (§9 — never a DOM event). */
  onOpenChange: (open: boolean) => void
  /** Fired when the "open in wiki" action is chosen — the route opens the sidebar's wiki
   *  tab to this entity (Task 14 wires it to `onEntityOpen(entityId)`). */
  onOpenInWiki: () => void
  /** The popover's accessible name — a resolved i18n key. */
  label: string
  /** The entity-type label beside the glyph (npc/location/faction) — a resolved i18n key. */
  typeLabel: string
  /** The "open in wiki" action label — a resolved i18n key. */
  openInWikiLabel: string
  /** The trigger — the `EntityMention` span the popover anchors to. */
  children: ReactNode
}

/**
 * SessionSheet (Task 12) — the in-session variant of the member's curated sheet. Renders
 * the read-only `CuratedSheet` body (identity, stat stripe, ability tiles, prose, features,
 * equipment, spells) WITHOUT the creation-flow reveal chrome (no confirm/start-over/expand),
 * and overlays the live `CharacterOverlay`: when `overlay.hp` is non-null the HP stat shows
 * `hp/maxHp` (live) over the base sheet's static HP, and a quiet conditions line renders
 * `overlay.conditionLog` when non-empty. Square register; scrolls inside the tab panel.
 * Platform-neutral (§9): plain data + resolved i18n-key labels, no DOM events.
 */
export interface SessionSheetPanelProps extends Omit<BaseProps, 'children'> {
  /** The base curated sheet (the member's own character). */
  sheet: CuratedSheet
  /** The live character-state overlay folded from `ledger_update` frames (Task 5). */
  overlay: CharacterOverlay
  /** Label for the live HP stat — a resolved i18n key. */
  hpLabel: string
  /** Label over the quiet recent-conditions line (`overlay.conditionLog`) — a resolved i18n key. */
  conditionsLabel: string
  /** The calm empty-state line shown when there are no live overlay changes to surface —
   *  a resolved i18n key. */
  emptyLabel: string
}

/**
 * KnowledgeSidebar (Task 13) — the three-tab play sidebar (World Wiki / Relationship
 * Graph / Character Sheet), composing the shipped `Tabs` + `WorldWiki` + `WorldGenGraph`
 * (mounted DRAINED, known-tier edges only) + `SessionSheet`. All three tabs derive from
 * ONE fetched snapshot (`cache`); the sheet tab derives from `sheet`.
 *
 * The graph↔wiki bridge is a first-class seam: `selectedEntityId` feeds BOTH the wiki
 * (`selectedId`) and the graph (`selectedKey`) so a selection on either highlights the
 * other, and both report selections through `onSelectEntity`. A graph node tap ALSO
 * requests the wiki tab (via `onTabChange('wiki')`) so the tap lands on the entity page.
 * CONTROLLED tab + query + selection so the composing route (Task 14) can force the wiki
 * tab from a chat-highlight click. Platform-neutral (§9): plain data + neutral callbacks
 * + resolved i18n-key labels, no DOM events.
 */
export interface KnowledgeSidebarProps extends Omit<BaseProps, 'children'> {
  /** The one-snapshot cache — `wiki` (wiki tab) + `graph` (graph tab) + `index`
   *  (unused here; the shell uses it for chat highlighting). Null projections render
   *  the matching calm unavailable line. */
  cache: KnowledgeCache
  /** The in-session sheet state — `sheet.sheet` (the `CuratedSheet`) + `sheet.overlay`
   *  (the live overlay). A null `sheet.sheet` renders `sheetUnavailableLabel`. */
  sheet: SessionSheetState
  /** The bridged selection — fed to the wiki (`selectedId`) AND the graph (`selectedKey`)
   *  so a pick on either side highlights the other. */
  selectedEntityId?: string
  /** Fired when an entity is selected on EITHER side of the bridge (a wiki row / a graph
   *  node tap) — carries the entity id, never a DOM event. */
  onSelectEntity: (entityId: string) => void
  /** The active tab (controlled) — a chat-highlight click can force `'wiki'`. */
  activeTab: KnowledgeTab
  /** Fired with the next tab. A graph node tap requests `'wiki'` through this. */
  onTabChange: (tab: KnowledgeTab) => void
  /** The wiki search query (controlled — forwarded to `WorldWiki.query`). */
  wikiQuery: string
  /** Fired on each wiki search keystroke (§9 — never a DOM event). */
  onWikiQuery: (query: string) => void
  /** Honour reduced motion — forwarded to the graph (static mount, no churn loop). */
  reducedMotion: boolean
  /** The `Tabs` list accessible label — a resolved i18n key. */
  tabsLabel: string
  /** The World Wiki tab label — a resolved i18n key. */
  wikiTabLabel: string
  /** The Relationship Graph tab label — a resolved i18n key. */
  graphTabLabel: string
  /** The Character Sheet tab label — a resolved i18n key. */
  sheetTabLabel: string
  /** The WorldWiki chrome labels forwarded to the embedded wiki. */
  wikiLabels: WikiTabLabels
  /** The graph's SR-only roving node-list a11y label (the keyboard node-selection path —
   *  the canvas is `aria-hidden`) — a resolved i18n key. Forwarded to `WorldGenGraph.nodeListLabel`. */
  graphNodeListLabel: string
  /** The SessionSheet chrome labels forwarded to the embedded sheet. */
  sheetLabels: SessionSheetLabels
  /** The calm line shown when `cache.wiki === null` — a resolved i18n key. */
  wikiUnavailableLabel: string
  /** The calm line shown when `cache.graph === null` — a resolved i18n key. */
  graphUnavailableLabel: string
  /** The calm line shown when `sheet.sheet === null` — a resolved i18n key. */
  sheetUnavailableLabel: string
}
