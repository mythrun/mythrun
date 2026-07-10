import type { BaseProps } from './index.ts'
import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiViewModel } from '../worldgen/wiki-view-model.ts'

// Re-export the wiki MODEL types so a consumer reads the model shape off the same
// contract surface it reads the props from (the model lives in the DOM-free brain,
// `../worldgen`, but the render contract lives here — mirrors world-gen-graph.ts).
export type {
  WikiViewModel,
  WikiGroup,
  WikiEntity,
  WikiFact,
  WikiRelatedLink,
  WikiIntroduction,
  WikiIntroReference,
} from '../worldgen/wiki-view-model.ts'

/**
 * WorldWiki (MYT-89 Phase D, D4; intro-as-home myth-b9bap) — the browsable
 * wiki the owner explores their newly-generated world through, rebuilt as real
 * PAGES: a home landing and per-entity pages (kind tag + serif name, the
 * composed fact body or a calm empty state, a RELATED footer carrying
 * cross-navigation, and a back button with per-page scroll memory). When the
 * model carries an `introduction`, home IS the world's introduction — the
 * world-name title, the grounding prose, the dig-deeper references — with the
 * search + browse-by-kind index one scroll below; without one (a pre-migration
 * world) home is the browse landing alone. Navigation state is the D3
 * `useWikiNavigation` stack, owned INTERNALLY — the component's outer surface
 * stays the same plain-data props the reveal already passes.
 *
 * Platform-neutral (§9): `model` is plain data (the D2 `WikiViewModel`),
 * `onSelect`/`onQuery` are neutral value callbacks (never DOM events),
 * `selectedId`/`query` are plain controlled values. No className/style/raw DOM
 * events. `selectedId` is the graph↔wiki bridge: an EXTERNAL selection change
 * (a graph tap) pushes that entity's page; internal navigation reports the
 * entity landed on through `onSelect` so the graph highlight keeps step.
 *
 * The DS owns no copy (§ components-live-in-the-design-system): the search
 * label/placeholder, the per-kind group headings, the empty-states, and the
 * back/related labels all arrive as `[ph: …]`-defaulted props the consuming app
 * resolves from i18n. Entity names + facts are DATA (from the model), so they
 * render as-is.
 */
export interface WorldWikiProps extends Omit<BaseProps, 'children'> {
  /** The browsable model — groups of entities (a nested location carries
   *  `children`), each entity carrying its facts + `related` links + `hasBody`.
   *  Produced by `toWikiViewModel` (D2). */
  model: WikiViewModel
  /** The externally-selected entity, if any (the graph tap). A CHANGE pushes that
   *  entity's wiki page (a re-push of the page in view is a no-op); on home the
   *  matching row is marked. Prop-driven so the reveal shares it with the graph. */
  selectedId?: string
  /** Fired with the entity id whenever internal navigation LANDS on an entity page
   *  (a home row, a related-link hop) — the graph-highlight side of the bridge.
   *  Neutral — carries the entity id, never a DOM event. */
  onSelect: (id: string) => void
  /** The current search query (controlled). Empty/absent shows the full groups. */
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
  /** Note shown when the (filtered) home groups are empty — an i18n key. Defaults
   *  to `[ph: …]`. */
  emptyLabel?: string
  /** The page's back-affordance label — an i18n key. Defaults to `[ph: …]`. */
  backLabel?: string
  /** The RELATED section label on a page — an i18n key. Defaults to `[ph: …]`. */
  relatedLabel?: string
  /** Note shown on an entity page whose known-tier body is empty — an i18n key.
   *  Defaults to `[ph: …]`. */
  emptyBodyLabel?: string
  /** Section label over the introduction's dig-deeper reference links — an
   *  i18n key. Defaults to `[ph: …]`. Rendered only on the intro home. */
  referencesLabel?: string
  /** Quiet section label over the search + browse index below the introduction
   *  — an i18n key. Defaults to `[ph: …]`. Rendered only on the intro home. */
  indexLabel?: string
}
