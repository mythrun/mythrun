import { forwardRef } from 'react'
import type { KnowledgeSidebarProps, KnowledgeTab } from '@mythrun/client-core/contract'
import { Tabs } from '../Tabs/Tabs.tsx'
import { Text } from '../Text/Text.tsx'
import { WorldWiki } from '../WorldWiki/WorldWiki.tsx'
import { WorldGenGraph } from '../WorldGenGraph/WorldGenGraph.tsx'
import { SessionSheet } from '../SessionSheet/SessionSheet.tsx'

// KnowledgeSidebar (MYT-94, spec §6 / UX §9) — the in-session play sidebar: a three-tab
// panel (World Wiki / Relationship Graph / Character Sheet) over ONE fetched world
// snapshot (`cache`) plus the viewer's live sheet (`sheet`). It composes the shipped
// primitives and owns no data of its own — the composing route (Task 14) owns the
// cache/sheet hooks and the tab/query/selection state; this component is pure wiring.
// (Default-OPEN, the desktop ~30% rail, and the mobile Drawer are the ROUTE's concern;
// the SAME component mounts inside both.)
//
// THE TABS (shipped `Tabs`, controlled): one panel each.
//   • World Wiki — the shipped `WorldWiki` over `cache.wiki` (client-side search; stat
//     blocks are structurally absent — `WorldSnapshotSchema` strips prose kernels +
//     stat blocks, so `WikiViewModel` carries only name + facts + related + intro).
//   • Relationship Graph — the shipped `WorldGenGraph` mounted DRAINED (known-tier edges
//     only). The DRAIN is `shownEntities ≥ totalEntities` (both = `nodes.length`), so the
//     fog field empties and never paints (the shipped spawn-drain floor — there is NO
//     fog-off prop). `interactive` wires node selection; the LOCKED force/density params
//     are left untouched (no `forceParams`/`densityParams`).
//   • Character Sheet — the committed `SessionSheet` over `sheet.sheet`/`sheet.overlay`.
//
// THE GRAPH↔WIKI BRIDGE (a first-class shipped seam). `selectedEntityId` feeds BOTH the
// wiki (`selectedId`) and the graph (`selectedKey`), so a pick on either side highlights
// the other. A WIKI selection reports straight through `onSelectEntity` (you are already
// on the wiki). A GRAPH node tap reports through `onSelectEntity` AND requests the wiki
// tab (`onTabChange('wiki')`) so the tap lands on that entity's wiki page (UX §9).
//
// A NULL projection (the 409 `snapshot_not_ready` race → the calm empty cache, or a
// member with no finalized character) renders the matching quiet unavailable line
// (a resolved label prop) instead of the tab body — never an error flash.
//
// Register: square (`rounded-none`, no circles/dots/chips), two typefaces only. Holds
// desktop AND ~375px by construction — a single `min-w-0` column so the mobile Drawer
// never forces a horizontal scroll. `reducedMotion` threads to the graph (static mount).
//
// GRAPH HEIGHT — a deviation from the plan's literal `fillHost` recipe: the shipped
// `Tabs` renders each panel inside a plain (non-flex, height-auto) `RadixTabs.Content`,
// so a `fillHost` graph — which needs a DEFINITE host height — would collapse to zero
// height. We instead let the graph use its own designed default (`clamp(18rem,62dvh,
// 46rem)`), which is exactly the intrinsic-height case that default is for. The DRAIN
// recipe + `interactive` + the locked params (the load-bearing pins) are unchanged.

/** The three sidebar tab values, in display order. */
const WIKI_TAB: KnowledgeTab = 'wiki'
const GRAPH_TAB: KnowledgeTab = 'graph'
const SHEET_TAB: KnowledgeTab = 'sheet'

/** Narrow the shipped `Tabs`' plain-string `onChange` value back to the tab union — a
 *  TOTAL coercion (an unknown value, which the shipped Tabs never emits, falls back to
 *  the wiki tab) so the handler stays branch- and assertion-free. Exported for a direct
 *  unit test of every arm (the shipped Tabs only ever emits our own three values). */
export function coerceTab(value: string): KnowledgeTab {
  if (value === GRAPH_TAB) return GRAPH_TAB
  if (value === SHEET_TAB) return SHEET_TAB
  return WIKI_TAB
}

/** A calm unavailable line — the quiet `ui-caption` a null projection shows in
 *  place of the tab body (mirrors the reveal wiki panel's calm line). */
function UnavailableLine({ label, testid }: { label: string; testid: string }): React.JSX.Element {
  return (
    <Text role="ui-caption" as="p" data-testid={testid}>
      {label}
    </Text>
  )
}

export const KnowledgeSidebar = forwardRef<HTMLDivElement, KnowledgeSidebarProps>(function KnowledgeSidebar(
  {
    cache,
    sheet,
    selectedEntityId,
    onSelectEntity,
    activeTab,
    onTabChange,
    wikiQuery,
    onWikiQuery,
    reducedMotion,
    tabsLabel,
    wikiTabLabel,
    graphTabLabel,
    sheetTabLabel,
    wikiLabels,
    graphNodeListLabel,
    sheetLabels,
    wikiUnavailableLabel,
    graphUnavailableLabel,
    sheetUnavailableLabel,
    'data-testid': dataTestId,
  },
  ref,
) {
  // A graph node tap: highlight the entity everywhere AND land the tap on its wiki page.
  const handleGraphSelect = (entityId: string): void => {
    onSelectEntity(entityId)
    onTabChange(WIKI_TAB)
  }

  const handleTabChange = (value: string): void => {
    onTabChange(coerceTab(value))
  }

  const wikiPanel =
    cache.wiki === null ? (
      <UnavailableLine label={wikiUnavailableLabel} testid="knowledge-wiki-unavailable" />
    ) : (
      <WorldWiki
        data-testid="knowledge-wiki"
        model={cache.wiki}
        onSelect={onSelectEntity}
        query={wikiQuery}
        onQuery={onWikiQuery}
        {...wikiLabels}
        {...(selectedEntityId !== undefined ? { selectedId: selectedEntityId } : {})}
      />
    )

  const graphPanel =
    cache.graph === null ? (
      <UnavailableLine label={graphUnavailableLabel} testid="knowledge-graph-unavailable" />
    ) : (
      <WorldGenGraph
        data-testid="knowledge-graph"
        nodes={cache.graph.nodes}
        edges={cache.graph.edges}
        interactive
        forcefulSettle
        showLabels
        reducedMotion={reducedMotion}
        onSelect={handleGraphSelect}
        nodeListLabel={graphNodeListLabel}
        // DRAINED mount: shown ≥ total empties the fog field (both = node count).
        shownEntities={cache.graph.nodes.length}
        totalEntities={cache.graph.nodes.length}
        {...(selectedEntityId !== undefined ? { selectedKey: selectedEntityId } : {})}
      />
    )

  const sheetPanel =
    sheet.sheet === null ? (
      <UnavailableLine label={sheetUnavailableLabel} testid="knowledge-sheet-unavailable" />
    ) : (
      <SessionSheet sheet={sheet.sheet} overlay={sheet.overlay} {...sheetLabels} />
    )

  return (
    <div ref={ref} data-testid={dataTestId ?? 'knowledge-sidebar'} className="flex min-h-0 min-w-0 flex-col">
      <Tabs
        label={tabsLabel}
        value={activeTab}
        onChange={handleTabChange}
        items={[
          { value: WIKI_TAB, label: wikiTabLabel, content: wikiPanel },
          { value: GRAPH_TAB, label: graphTabLabel, content: graphPanel },
          { value: SHEET_TAB, label: sheetTabLabel, content: sheetPanel },
        ]}
      />
    </div>
  )
})
