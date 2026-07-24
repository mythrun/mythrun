import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { snapshotToGraph, toWikiViewModel } from '@mythrun/client-core/worldgen'
import type {
  CharacterOverlay,
  CuratedSheet,
  KnowledgeCache,
  KnowledgeTab,
  SessionSheetState,
} from '@mythrun/client-core/contract'
import { KnowledgeSidebar } from './KnowledgeSidebar.tsx'

// KnowledgeSidebar — the in-session play sidebar: a three-tab panel (World Wiki /
// Relationship Graph / Character Sheet) over ONE world snapshot + the viewer's live
// sheet. These stories render the REAL composition (Tabs + WorldWiki + WorldGenGraph
// mounted DRAINED + SessionSheet). The world below is a single coherent snapshot fed
// through the SAME `toWikiViewModel` / `snapshotToGraph` production uses, so the
// graph↔wiki bridge lines up on shared entity ids. The prose/label samples are
// realistic (stories are lint-exempt); real strings arrive from the composing route.

// ONE coherent world — both projections derive from it, so a graph node tap and a
// wiki row point at the same entity id. Typed off `toWikiViewModel`'s input (the
// strict `entityType` union); it is also assignable to `snapshotToGraph`'s looser
// `GraphSeedSource`, so one literal feeds both projections.
const SNAPSHOT: Parameters<typeof toWikiViewModel>[0] = {
  introduction: {
    title: 'The Ashfen Reaches',
    prose:
      '[placeholder for the first introduction paragraph — how the reach functions at rest, long enough to wrap at rail width and show the prose measure]\n\n[placeholder for the second introduction paragraph — the tensions a newcomer would feel first]',
    references: [
      { entityId: 'f-guild', name: 'The Tallow Guild' },
      { entityId: 'n-vale', name: 'Maeris Vale' },
    ],
  },
  entities: [
    { id: 'f-guild', entityType: 'faction', name: 'The Tallow Guild' },
    { id: 'l-reach', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'l-ward', entityType: 'location', name: 'The Drowned Ward' },
    { id: 'n-vale', entityType: 'npc', name: 'Maeris Vale' },
    { id: 'n-corr', entityType: 'npc', name: 'Corrin Salt' },
  ],
  facts: [
    { id: 'fact-1', entityId: 'f-guild', topic: 'Purpose', content: '[placeholder for the guild purpose]' },
    { id: 'fact-2', entityId: 'l-reach', topic: 'Terrain', content: '[placeholder for the terrain of the reach]' },
    { id: 'fact-3', entityId: 'n-vale', topic: 'Role', content: '[placeholder for what Maeris Vale does]' },
  ],
  entityHierarchy: [{ parentEntityId: 'l-reach', childEntityId: 'l-ward' }],
  relationships: [
    { sourceEntityId: 'f-guild', targetEntityId: 'l-ward', relationshipType: 'seated_at' },
    { sourceEntityId: 'n-vale', targetEntityId: 'f-guild', relationshipType: 'sworn_to' },
    { sourceEntityId: 'n-corr', targetEntityId: 'n-vale', relationshipType: 'serves' },
  ],
  // The world's invented vocabulary — the wiki's Glossary view (MYT-100). Play
  // worlds carry one, so the sidebar exercises the Index/Glossary switch (the
  // segmented control sitting under the outer World/Ties/Sheet tab bar).
  world: {
    vocabularyRegistry: {
      entries: [
        { term: 'tallow-run', definition: '[placeholder for what a tallow-run is in the reach]' },
        { term: 'ashfen', definition: '[placeholder for what the ashfen itself is]' },
      ],
    },
  },
}

const CACHE: KnowledgeCache = {
  wiki: toWikiViewModel(SNAPSHOT),
  // `relationships` is optional on the wiki-input type but required on the graph
  // source — pass it explicitly (the literal always carries it).
  graph: snapshotToGraph({ entities: SNAPSHOT.entities, relationships: SNAPSHOT.relationships ?? [] }),
  index: null,
  loading: false,
  failed: false,
}
const CACHE_EMPTY: KnowledgeCache = { wiki: null, graph: null, index: null, loading: false, failed: true }

const SHEET: CuratedSheet = {
  name: 'Kessa Vurm',
  identityLine: 'Level 3 · Human Fighter · Toll-clerk of Greenward',
  stats: [
    { label: 'AC', value: '16' },
    { label: 'HP', value: '28 / 28' },
    { label: 'Proficiency', value: '+2' },
    { label: 'Speed', value: '30 ft' },
  ],
  abilities: [
    { abbrev: 'STR', score: 16, modifier: 3 },
    { abbrev: 'DEX', score: 13, modifier: 1 },
    { abbrev: 'CON', score: 15, modifier: 2 },
    { abbrev: 'INT', score: 12, modifier: 1 },
    { abbrev: 'WIS', score: 11, modifier: 0 },
    { abbrev: 'CHA', score: 9, modifier: -1 },
  ],
  prose: ['[placeholder for the connection prose — the emotional centre of the sheet]'],
  features: [{ name: 'Second Wind', gloss: 'Catch her breath: recover a burst of HP once per rest.' }],
  equipment: [{ name: 'Longsword', gloss: "Versatile · her father's." }],
}
const OVERLAY_LIVE: CharacterOverlay = {
  hp: 9,
  maxHp: 28,
  gold: null,
  conditionLog: ['A hobgoblin blade opens a gash along her ribs.'],
}
const SHEET_STATE: SessionSheetState = { sheet: SHEET, overlay: OVERLAY_LIVE, loading: false, failed: false }
const SHEET_STATE_EMPTY: SessionSheetState = {
  sheet: null,
  overlay: { hp: null, maxHp: null, gold: null, conditionLog: [] },
  loading: false,
  failed: true,
}

const LABELS = {
  tabsLabel: 'Knowledge',
  wikiTabLabel: 'World',
  graphTabLabel: 'Ties',
  sheetTabLabel: 'Sheet',
  wikiLabels: {
    searchLabel: 'Search the world',
    searchPlaceholder: 'Search',
    emptyLabel: 'Nothing here.',
    backLabel: 'Back',
    relatedLabel: 'Related',
    emptyBodyLabel: 'Nothing recorded here yet.',
    referencesLabel: 'Dig deeper',
    indexLabel: 'Index',
    glossaryLabel: 'Glossary',
    groupLabels: { faction: 'Factions', location: 'Places', npc: 'People', item: 'Things' },
  },
  graphNodeListLabel: 'Pick a place or person',
  sheetLabels: { hpLabel: 'Current HP', conditionsLabel: 'Recent changes', emptyLabel: 'Nothing has changed yet.' },
  wikiUnavailableLabel: 'The wiki is not available right now.',
  graphUnavailableLabel: 'The map of ties is not available right now.',
  sheetUnavailableLabel: 'Your character sheet is not available right now.',
}

/** A controlled harness — the sidebar is fully controlled (tab / query / selection),
 *  so the story owns that state and the tabs, search, and graph↔wiki bridge are all
 *  interactive (a graph node tap flips to the wiki tab on the selected entity). */
function SidebarDemo({
  cache = CACHE,
  sheet = SHEET_STATE,
  initialTab = 'wiki',
  reducedMotion = false,
}: {
  cache?: KnowledgeCache
  sheet?: SessionSheetState
  initialTab?: KnowledgeTab
  reducedMotion?: boolean
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<KnowledgeTab>(initialTab)
  const [wikiQuery, setWikiQuery] = useState('')
  const [selectedEntityId, setSelectedEntityId] = useState<string | undefined>(undefined)
  return (
    <KnowledgeSidebar
      cache={cache}
      sheet={sheet}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      wikiQuery={wikiQuery}
      onWikiQuery={setWikiQuery}
      onSelectEntity={setSelectedEntityId}
      reducedMotion={reducedMotion}
      {...(selectedEntityId !== undefined ? { selectedEntityId } : {})}
      {...LABELS}
    />
  )
}

const meta: Meta<typeof KnowledgeSidebar> = {
  title: 'Session/KnowledgeSidebar',
  component: KnowledgeSidebar,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof KnowledgeSidebar>

// The desktop rail (~30% of the play screen) frames the sidebar throughout.
function Rail({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="h-[42rem] w-full max-w-[24rem] overflow-hidden bg-bg p-[var(--space-4)]">{children}</div>
}

export const WorldWikiTab: Story = {
  name: 'World Wiki tab',
  render: () => (
    <Rail>
      <SidebarDemo initialTab="wiki" />
    </Rail>
  ),
}

// The required DRAINED-graph story: the graph mounts with shown ≥ total, so the fog
// field never paints — only the mono-ink relationship graph over known-tier edges.
export const RelationshipGraphDrained: Story = {
  name: 'Relationship Graph — drained (no fog)',
  render: () => (
    <Rail>
      <SidebarDemo initialTab="graph" />
    </Rail>
  ),
}

export const CharacterSheetTab: Story = {
  name: 'Character Sheet tab — live HP overlay',
  render: () => (
    <Rail>
      <SidebarDemo initialTab="sheet" />
    </Rail>
  ),
}

// The required NULL-projection calm-line story: every tab's projection is null, so
// each renders its quiet unavailable line instead of the tab body (no error flash).
export const EmptyStates: Story = {
  name: 'Empty states — calm unavailable lines',
  render: () => (
    <Rail>
      <SidebarDemo cache={CACHE_EMPTY} sheet={SHEET_STATE_EMPTY} initialTab="wiki" />
    </Rail>
  ),
}

// The same sidebar at ~375px — it mounts identically inside the mobile Drawer (single
// column, min-w-0, no horizontal scroll). Reduced motion keeps the graph static.
export const Mobile: Story = {
  name: 'Mobile — single column (~375px)',
  render: () => (
    <div className="mx-auto h-[40rem] max-w-[375px] overflow-hidden bg-bg p-[var(--space-3)]">
      <SidebarDemo initialTab="graph" reducedMotion />
    </div>
  ),
}
