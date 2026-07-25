import type { BaseProps } from './index.ts'
import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiViewModel } from '../worldgen/wiki-view-model.ts'
import type { WikiNavigation } from '../worldgen/use-wiki-navigation.ts'

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
// The page stack a consumer supplies when it needs to SEE the wiki's history
// (see `WorldWikiProps.navigation`), re-exported for the same reason.
export type { WikiNavigation, WikiLocation } from '../worldgen/use-wiki-navigation.ts'

/**
 * The index's PRESENCE split (ux-run3 myth-ry14g). An alphabetized index treats
 * the scene's antagonist and a session-one shopkeeper as equals; the live
 * transcript knows better, so the play sidebar hands the wiki the entity ids the
 * session has already named and the two quiet sub-labels that head the halves.
 * A group splits only when BOTH halves are non-empty (no lonely heading), and a
 * root counts as present when a nested child is the one named — the containing
 * place travels with the person met there. Absent (the world reveal, where
 * nothing has been played yet) ⇒ the plain alphabetized index, unchanged.
 */
export interface WikiPresence {
  /** Entity ids the live session has named — order irrelevant (membership only). */
  ids: readonly string[]
  /** Quiet mono sub-label over the named half — a resolved i18n string. */
  presentLabel: string
  /** Quiet mono sub-label over the remainder — a resolved i18n string. */
  elsewhereLabel: string
}

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
 * back/related labels all arrive as resolved i18n strings the consuming app passes
 * in (MYT-100 made them required — no in-component defaults). Entity names + facts
 * are DATA (from the model), so they render as-is.
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
  /** Accessible label for the search field (SeamlessInput's required label) — a
   *  resolved i18n string the consumer passes. */
  searchLabel: string
  /** Faint placeholder hint in the search field — a resolved i18n string. */
  searchPlaceholder: string
  /** Per-kind group-heading copy — a resolved string per world-lore kind. A kind
   *  absent from the map falls back to an empty label (the DS invents no copy). */
  groupLabels?: Partial<Record<EntityKind, string>>
  /** Note shown when the (filtered) home groups are empty — a resolved i18n string. */
  emptyLabel: string
  /** The page's back-affordance label — a resolved i18n string. */
  backLabel: string
  /** The RELATED section label on a page — a resolved i18n string. */
  relatedLabel: string
  /** Note shown on an entity page whose known-tier body is empty — a resolved i18n string. */
  emptyBodyLabel: string
  /** Section label over the introduction's dig-deeper reference links — a resolved
   *  i18n string. Rendered only on the intro home. */
  referencesLabel: string
  /** Quiet section label over the search + browse index below the introduction
   *  — a resolved i18n string. Rendered only on the intro home. */
  indexLabel: string
  /** Section label over the world-glossary rows closing the home index (MYT-102) —
   *  a resolved i18n string the consumer passes (migrated into the contract by
   *  MYT-100). */
  glossaryLabel: string
  /** The active creation step's topic (ux-run2 myth-ehcf4) — what makes the
   *  panel STEP-AWARE instead of a static poster. A SHORT display string (the
   *  step's topic word or the selected card's name — e.g. "Cleric"), owned and
   *  resolved by the consumer. The panel renders it verbatim as a quiet eyebrow
   *  AND runs it through the same mechanical name/term filter the search field
   *  uses, surfacing matching glossary definitions (open, in the world's voice)
   *  and entity rows at the top of the index view. No matches → the strip
   *  renders nothing and the home is exactly the step-less panel; a non-empty
   *  user search also stands the strip down. Absent → the pre-step behaviour. */
  stepContext?: string
  /** The index's presence split (ux-run3 myth-ry14g) — see {@link WikiPresence}.
   *  Absent ⇒ the plain alphabetized index (the reveal's behaviour, unchanged). */
  presence?: WikiPresence
  /** The page stack, LIFTED (myth-g7kg6). Omitted (the default) the wiki owns
   *  its own `useWikiNavigation` and history is entirely in-surface. A consumer
   *  that must SEE the stack passes its own — the mobile reveal does, because
   *  a hardware Back has to pop the reader's wiki page before the drawer
   *  disappears out from under them, and `back()` reports nothing outward.
   *  Supplying it changes nothing about how the wiki navigates; it only moves
   *  where the state lives (the Drawer's `open`/`defaultOpen` pattern). */
  navigation?: WikiNavigation
}
