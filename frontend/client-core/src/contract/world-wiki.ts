import type { BaseProps } from './index.ts'
import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiViewModel } from '../worldgen/wiki-view-model.ts'

// Re-export the wiki MODEL types so a consumer reads the model shape off the same
// contract surface it reads the props from (the model lives in the DOM-free brain,
// `../worldgen`, but the render contract lives here — mirrors world-gen-graph.ts).
export type { WikiViewModel, WikiGroup, WikiEntity, WikiFact } from '../worldgen/wiki-view-model.ts'

/**
 * WorldWiki (MYT-89 Phase D, D2) — the browsable wiki the owner explores their
 * newly-generated world through. A grouped tree (factions / locations / npcs /
 * items) with nested locations, each entity opening to its facts, over a
 * borderless search field that filters the tree by entity name.
 *
 * Platform-neutral (§9): `model` is plain data (the D1 `WikiViewModel`),
 * `onSelect`/`onQuery` are neutral value callbacks (never DOM events),
 * `selectedId`/`query` are plain controlled values. No className/style/raw DOM
 * events. Selection is PROP-DRIVEN (`selectedId` + `onSelect`, no internal-only
 * state) so D3 can wire the graph↔wiki SHARED selection through the same prop.
 *
 * The DS owns no copy (§ components-live-in-the-design-system): the search
 * label/placeholder, the per-kind group headings, and the empty-state note all
 * arrive as `[ph: …]`-defaulted props the consuming app resolves from i18n.
 * Entity names + facts are DATA (from the model), so they render as-is.
 */
export interface WorldWikiProps extends Omit<BaseProps, 'children'> {
  /** The browsable model — groups of entities (a nested location carries
   *  `children`), each entity carrying its facts. Produced by `toWikiViewModel` (D1). */
  model: WikiViewModel
  /** The id of the currently-selected entity, if any — marked in the tree, and (when
   *  set) the entity whose facts open. Prop-driven so D3 shares it with the graph. */
  selectedId?: string
  /** Fired when an entity is chosen. Neutral — carries the entity id, never a DOM event. */
  onSelect: (id: string) => void
  /** The current search query (controlled). Empty/absent shows the full tree. */
  query?: string
  /** Fired on each search keystroke with the new query string (§9 — never a DOM event). */
  onQuery: (query: string) => void
  /** Accessible label for the search field (SeamlessInput's required label) — an
   *  i18n key the consumer resolves. Defaults to a `[ph: …]` placeholder. */
  searchLabel?: string
  /** Faint placeholder hint in the search field — an i18n key. Defaults to `[ph: …]`. */
  searchPlaceholder?: string
  /** Per-kind group-heading copy — an i18n key per world-lore kind. A kind absent
   *  from the map falls back to a `[ph: <kind>]` placeholder. */
  groupLabels?: Partial<Record<EntityKind, string>>
  /** Note shown when the (filtered) tree is empty — an i18n key. Defaults to `[ph: …]`. */
  emptyLabel?: string
}
