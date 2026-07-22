import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import type {
  CharacterOverlay,
  CuratedSheet,
  GraphEdge,
  GraphNode,
  KnowledgeCache,
  KnowledgeSidebarProps,
  SessionSheetState,
  WorldGenGraphProps,
  WorldWikiProps,
} from '@mythrun/client-core/contract'
import { WIKI_FIXTURE_MODEL } from '../WorldWiki/wiki-fixture.ts'
import { KnowledgeSidebar, coerceTab } from './KnowledgeSidebar.tsx'

// The two HEAVY children are TEST DOUBLES (the reveal.test.tsx pattern): the real
// WorldGenGraph is Canvas-only (no 2D context / no layout under jsdom) and the real
// WorldWiki drives its own navigation — both are pinned by their OWN unit tests +
// the Storybook browser sweep (which renders this sidebar's REAL composition). The
// subject HERE is KnowledgeSidebar's WIRING: the drained-graph recipe, the graph↔wiki
// bridge, the label pass-through, and the null-projection calm lines. Each double
// renders the neutral contract shape the real component exposes — data attributes
// mirroring the props under test + a button per selectable that fires `onSelect`
// (the Canvas tap / wiki row's contract). Tabs + SessionSheet render for REAL.
vi.mock('../WorldWiki/WorldWiki.tsx', async () => {
  const { createElement: h } = await import('react')
  function WorldWikiDouble(props: WorldWikiProps): React.JSX.Element {
    return h(
      'div',
      {
        'data-testid': props['data-testid'],
        'data-group-count': String(props.model.groups.length),
        'data-selected-id': props.selectedId ?? '',
        'data-query': props.query ?? '',
        'data-search-label': props.searchLabel,
      },
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            props.onSelect('wiki-picked')
          },
        },
        'wiki-select',
      ),
    )
  }
  return { WorldWiki: WorldWikiDouble }
})

vi.mock('../WorldGenGraph/WorldGenGraph.tsx', async () => {
  const { createElement: h } = await import('react')
  function GraphDouble(props: WorldGenGraphProps): React.JSX.Element {
    return h(
      'div',
      {
        'data-testid': props['data-testid'],
        'data-shown': String(props.shownEntities),
        'data-total': String(props.totalEntities),
        'data-node-count': String(props.nodes.length),
        'data-interactive': String(props.interactive ?? false),
        'data-forceful-settle': String(props.forcefulSettle ?? false),
        'data-reduced-motion': String(props.reducedMotion ?? false),
        'data-has-force-params': String(props.forceParams !== undefined),
        'data-has-density-params': String(props.densityParams !== undefined),
        'data-node-list-label': props.nodeListLabel ?? '',
        'data-selected-key': props.selectedKey ?? '',
      },
      props.nodes.map((n) =>
        h(
          'button',
          {
            key: n.displayId,
            type: 'button',
            onClick: () => {
              props.onSelect(n.displayId)
            },
          },
          n.name,
        ),
      ),
    )
  }
  return { WorldGenGraph: GraphDouble }
})

// ── Fixtures ────────────────────────────────────────────────────────────────

const NODE_A: GraphNode = { synthKey: 'a', kind: 'npc', name: 'Maeris Vale', displayId: 'n-vale', state: 'finalized', lastEventIndex: -1 }
const NODE_B: GraphNode = { synthKey: 'b', kind: 'location', name: 'Ashfen Reach', displayId: 'l-reach', state: 'finalized', lastEventIndex: -1 }
const EDGE: GraphEdge = { synthKey: 'e1', from: 'n-vale', to: 'l-reach', relationship: 'seated_at', arrivalIndex: -1, sourceStage: 'snap' }

const CACHE: KnowledgeCache = {
  wiki: WIKI_FIXTURE_MODEL,
  graph: { nodes: [NODE_A, NODE_B], edges: [EDGE] },
  index: null,
  loading: false,
  failed: false,
}
const CACHE_NULL: KnowledgeCache = { wiki: null, graph: null, index: null, loading: false, failed: true }

const OVERLAY: CharacterOverlay = { hp: null, maxHp: null, gold: null, conditionLog: [] }
const SHEET: CuratedSheet = {
  name: 'Kessa Vurm',
  identityLine: 'Level 3 · Human Fighter · Toll-clerk of Greenward',
  stats: [
    { label: 'AC', value: '16' },
    { label: 'HP', value: '28 / 28' },
  ],
  abilities: [
    { abbrev: 'STR', score: 16, modifier: 3 },
    { abbrev: 'CON', score: 15, modifier: 2 },
  ],
  prose: ['[placeholder for the sheet prose]'],
  features: [{ name: 'Second Wind' }],
  equipment: [{ name: 'Longsword' }],
}
const SHEET_STATE: SessionSheetState = { sheet: SHEET, overlay: OVERLAY, loading: false, failed: false }
const SHEET_STATE_NULL: SessionSheetState = { sheet: null, overlay: OVERLAY, loading: false, failed: true }

const DEFAULT_PROPS: Omit<KnowledgeSidebarProps, 'onSelectEntity' | 'onTabChange' | 'onWikiQuery'> = {
  cache: CACHE,
  sheet: SHEET_STATE,
  activeTab: 'wiki',
  wikiQuery: '',
  reducedMotion: false,
  tabsLabel: 'knowledge tabs',
  wikiTabLabel: 'World Wiki',
  graphTabLabel: 'Relationships',
  sheetTabLabel: 'Character',
  wikiLabels: {
    searchLabel: 'search-the-world',
    searchPlaceholder: 'Search',
    emptyLabel: 'No matches',
    backLabel: 'Back',
    relatedLabel: 'Related',
    emptyBodyLabel: 'Nothing recorded here yet',
    referencesLabel: 'Dig deeper',
    indexLabel: 'Index',
    glossaryLabel: 'Glossary',
  },
  graphNodeListLabel: 'pick a node',
  sheetLabels: { hpLabel: 'Current HP', conditionsLabel: 'Recent changes', emptyLabel: 'Nothing has changed yet.' },
  wikiUnavailableLabel: 'The wiki is unavailable.',
  graphUnavailableLabel: 'The map is unavailable.',
  sheetUnavailableLabel: 'Your sheet is unavailable.',
}

function setup(overrides: Partial<KnowledgeSidebarProps> = {}) {
  const onSelectEntity = vi.fn()
  const onTabChange = vi.fn()
  const onWikiQuery = vi.fn()
  const props: KnowledgeSidebarProps = { ...DEFAULT_PROPS, onSelectEntity, onTabChange, onWikiQuery, ...overrides }
  const utils = render(<KnowledgeSidebar {...props} />)
  return { ...utils, onSelectEntity, onTabChange, onWikiQuery }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('KnowledgeSidebar — structure', () => {
  it('renders a labelled tablist with the three knowledge tabs', () => {
    setup()
    const list = screen.getByRole('tablist')
    expect(list).toHaveAccessibleName('knowledge tabs')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['World Wiki', 'Relationships', 'Character'])
  })

  it('uses a stable default root testid, and honours a supplied one', () => {
    const { unmount } = setup()
    expect(screen.getByTestId('knowledge-sidebar')).toBeInTheDocument()
    unmount()
    setup({ 'data-testid': 'my-sidebar' })
    expect(screen.getByTestId('my-sidebar')).toBeInTheDocument()
  })

  it('shows the panel for the controlled activeTab (others are unmounted)', () => {
    setup({ activeTab: 'graph' })
    expect(screen.getByTestId('knowledge-graph')).toBeInTheDocument()
    // Radix Tabs unmounts the inactive panels — the wiki/sheet doubles are absent.
    expect(screen.queryByTestId('knowledge-wiki')).not.toBeInTheDocument()
    expect(screen.queryByText('Kessa Vurm')).not.toBeInTheDocument()
  })

  it('switching tabs shows the right panel (controlled, real Tabs)', async () => {
    const user = userEvent.setup()
    function Harness(): React.JSX.Element {
      const [tab, setTab] = useState<KnowledgeSidebarProps['activeTab']>('wiki')
      return (
        <KnowledgeSidebar
          {...DEFAULT_PROPS}
          activeTab={tab}
          onTabChange={setTab}
          onSelectEntity={vi.fn()}
          onWikiQuery={vi.fn()}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByTestId('knowledge-wiki')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Relationships' }))
    expect(await screen.findByTestId('knowledge-graph')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Character' }))
    expect(await screen.findByText('Kessa Vurm')).toBeInTheDocument()
  })
})

describe('KnowledgeSidebar — wiki tab', () => {
  it('forwards cache.wiki + the wiki chrome labels + query to WorldWiki', () => {
    setup({ activeTab: 'wiki', wikiQuery: 'salt' })
    const wiki = screen.getByTestId('knowledge-wiki')
    expect(wiki).toHaveAttribute('data-group-count', String(WIKI_FIXTURE_MODEL.groups.length))
    expect(wiki).toHaveAttribute('data-search-label', 'search-the-world')
    expect(wiki).toHaveAttribute('data-query', 'salt')
    // No external selection here → selectedId is not forwarded.
    expect(wiki).toHaveAttribute('data-selected-id', '')
  })

  it('a wiki selection reports through onSelectEntity WITHOUT changing tabs', async () => {
    const user = userEvent.setup()
    const { onSelectEntity, onTabChange } = setup({ activeTab: 'wiki' })
    await user.click(screen.getByRole('button', { name: 'wiki-select' }))
    expect(onSelectEntity).toHaveBeenCalledWith('wiki-picked')
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('renders the calm unavailable line when cache.wiki is null', () => {
    setup({ activeTab: 'wiki', cache: CACHE_NULL })
    expect(screen.queryByTestId('knowledge-wiki')).not.toBeInTheDocument()
    expect(screen.getByTestId('knowledge-wiki-unavailable')).toHaveTextContent('The wiki is unavailable.')
  })
})

describe('KnowledgeSidebar — graph tab (drained mount + bridge)', () => {
  it('mounts the graph DRAINED (shown === total === node count) + interactive, locked params untouched', () => {
    setup({ activeTab: 'graph', reducedMotion: true })
    const graph = screen.getByTestId('knowledge-graph')
    expect(graph).toHaveAttribute('data-shown', '2')
    expect(graph).toHaveAttribute('data-total', '2')
    expect(graph).toHaveAttribute('data-node-count', '2')
    expect(graph).toHaveAttribute('data-interactive', 'true')
    expect(graph).toHaveAttribute('data-forceful-settle', 'true')
    expect(graph).toHaveAttribute('data-reduced-motion', 'true')
    // The LOCKED force/density params are never overridden (the drain is the fog knob).
    expect(graph).toHaveAttribute('data-has-force-params', 'false')
    expect(graph).toHaveAttribute('data-has-density-params', 'false')
    expect(graph).toHaveAttribute('data-node-list-label', 'pick a node')
  })

  it('a graph node tap reports through onSelectEntity AND requests the wiki tab', async () => {
    const user = userEvent.setup()
    const { onSelectEntity, onTabChange } = setup({ activeTab: 'graph' })
    await user.click(screen.getByRole('button', { name: 'Maeris Vale' }))
    expect(onSelectEntity).toHaveBeenCalledWith('n-vale')
    expect(onTabChange).toHaveBeenCalledWith('wiki')
  })

  it('renders the calm unavailable line when cache.graph is null', () => {
    setup({ activeTab: 'graph', cache: CACHE_NULL })
    expect(screen.queryByTestId('knowledge-graph')).not.toBeInTheDocument()
    expect(screen.getByTestId('knowledge-graph-unavailable')).toHaveTextContent('The map is unavailable.')
  })
})

describe('KnowledgeSidebar — selection bridge', () => {
  it('threads selectedEntityId to the wiki as selectedId', () => {
    setup({ activeTab: 'wiki', selectedEntityId: 'n-vale' })
    expect(screen.getByTestId('knowledge-wiki')).toHaveAttribute('data-selected-id', 'n-vale')
  })

  it('threads selectedEntityId to the graph as selectedKey', () => {
    setup({ activeTab: 'graph', selectedEntityId: 'n-vale' })
    expect(screen.getByTestId('knowledge-graph')).toHaveAttribute('data-selected-key', 'n-vale')
  })
})

describe('KnowledgeSidebar — sheet tab', () => {
  it('renders the real SessionSheet from sheet.sheet', () => {
    setup({ activeTab: 'sheet' })
    const sheet = screen.getByTestId('session-sheet')
    expect(within(sheet).getByRole('heading', { name: 'Kessa Vurm' })).toBeInTheDocument()
  })

  it('renders the calm unavailable line when sheet.sheet is null', () => {
    setup({ activeTab: 'sheet', sheet: SHEET_STATE_NULL })
    expect(screen.queryByTestId('session-sheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('knowledge-sheet-unavailable')).toHaveTextContent('Your sheet is unavailable.')
  })
})

describe('coerceTab', () => {
  it('maps each known value to its tab and falls back to wiki for anything else', () => {
    expect(coerceTab('wiki')).toBe('wiki')
    expect(coerceTab('graph')).toBe('graph')
    expect(coerceTab('sheet')).toBe('sheet')
    // The shipped Tabs never emits this — the defensive total fallback.
    expect(coerceTab('bogus')).toBe('wiki')
  })
})

describe('KnowledgeSidebar — a11y', () => {
  it('has no axe violations (sheet tab: real composed content)', async () => {
    const { container } = setup({ activeTab: 'sheet' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
