import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
  type WorldGenStream,
} from '@mythrun/client-core'
import type { StageProgress } from '@mythrun/contract/events'
import { i18n } from '../../i18n/config.ts'
import { WorldReveal } from './reveal.tsx'

// The WORLD REVEAL (MYT-89 Phase D, D5 layout + reveal timing) — the graph
// beside the browsable wiki with SHARED SELECTION; desktop lays them as a true
// 50/50 (`RevealPanes` at its settled state — D6), a narrow viewport gets the
// full-bleed graph with the wiki in the edge-handle Drawer. The wiki model is fetched via an
// injected `fetchSnapshot` (default `getWorldSnapshot` — the RELATIONSHIP-
// bearing `WorldGenSnapshot`, so RELATED cross-links populate); the graph
// nodes arrive as props. These tests inject a resolved snapshot and assert:
// both surfaces render, a selection in EITHER surface highlights the matching
// entity in the other (BUG 2.1: single `displayId` id-space — post-gen a
// finalized node's `displayId` IS its entity id, so no synthKey↔id bridge; the
// FINALIZED-node fixture keeps synthKey ≠ displayId to prove the graph keys
// selection on displayId, not synthKey), a re-tap of the SAME node re-opens
// its page after a wiki back() (the one-shot push signal), Continue fires its
// intent + is GATED until the pipeline completes, and the SILENT UPDATES: a
// completed tail stage in the `stages` prop quietly refetches the wiki
// snapshot (old model stays rendered — no loading takeover — until the fresh
// one resolves). WorldGenGraph's Canvas is a jsdom no-op (its meaning lives in
// the accessible entity list); only that list is queried. The viewport regime
// is driven by a query-aware `matchMedia` stub (`mockViewport`); tests that
// install none run wide (the no-matchMedia default — desktop).

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; the platform builtin can shadow jsdom's real Storage.
// Install a functional in-memory one (mirrors campaign-detail.test.tsx).
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}

const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const CAMPAIGN_ID = 'c1'

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
  // jsdom's getContext THROWS ("Not implemented"); WorldGenGraph's canvas guard
  // expects null. Stub it so the decorative Canvas is a no-op and only the
  // accessible entity list renders (the same stub the graph's own test installs).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Restore the no-matchMedia default (wide) for tests that install no stub.
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

// jsdom has no matchMedia. Install a QUERY-AWARE stub so the DS's one narrow
// regime (`(min-width: 640px)` — useViewportNarrow) resolves to the viewport
// under test; every other query (reduced-motion, pointer) stays non-matching.
function mockViewport({ narrow }: { narrow: boolean }): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(min-width: 640px)' ? !narrow : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

// Finalized nodes whose synthKey ≠ displayId — the post-gen reality: the graph
// selects by `displayId` (= the finalized node's entity id), the wiki by entity
// id, so ONE id feeds both with no bridge. Distinct synthKey/displayId values
// prove selection keys on displayId (a synthKey-keyed graph would never match).
const NODES: WorldGenStream['nodes'] = [
  { synthKey: 's1/reach', kind: 'location', name: 'Ashfen Reach', displayId: 'ent-loc-1', state: 'finalized', lastEventIndex: 0 },
  { synthKey: 's2/maeris', kind: 'npc', name: 'Maeris Vale', displayId: 'ent-npc-1', state: 'finalized', lastEventIndex: 1 },
]

// The snapshot is the RELATIONSHIP-BEARING `WorldGenSnapshot` — what the real
// `getWorldSnapshot` returns (the D2-review re-type: a relationship-less source
// is now a compile error, so the RELATED lists can't silently come up empty).
const SNAPSHOT: WorldGenSnapshot = {
  entities: [
    { id: 'ent-loc-1', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'ent-npc-1', entityType: 'npc', name: 'Maeris Vale' },
  ],
  facts: [
    { id: 'fact-1', entityId: 'ent-npc-1', topic: 'Role', content: 'Harbourmaster of the Reach.' },
  ],
  entityHierarchy: [],
  relationships: [
    {
      sourceEntityId: 'ent-npc-1',
      targetEntityId: 'ent-loc-1',
      relationshipType: 'harbourmaster_of',
    },
  ],
}

interface RevealOverrides {
  fetchSnapshot?: () => Promise<WorldGenSnapshot>
  onContinue?: () => void
  stages?: readonly StageProgress[]
  continueReady?: boolean
}

interface RevealHandle {
  fetchSnapshot: () => Promise<WorldGenSnapshot>
  /** Re-render the SAME mounted reveal with new stages/continueReady — the
   *  route's live-stream updates, as the reveal experiences them. */
  update: (next: Pick<RevealOverrides, 'stages' | 'continueReady'>) => void
}

const stageAt = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

function renderReveal(overrides: RevealOverrides = {}): RevealHandle {
  const fetchSnapshot = overrides.fetchSnapshot ?? vi.fn().mockResolvedValue(SNAPSHOT)
  const tree = (opts: Pick<RevealOverrides, 'stages' | 'continueReady'>): React.JSX.Element => (
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <WorldReveal
              campaignId={CAMPAIGN_ID}
              nodes={NODES}
              edges={[]}
              fetchSnapshot={fetchSnapshot}
              {...(opts.stages ? { stages: opts.stages } : {})}
              {...(opts.continueReady !== undefined ? { continueReady: opts.continueReady } : {})}
              {...(overrides.onContinue ? { onContinue: overrides.onContinue } : {})}
            />
          </MemoryRouter>
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>
  )
  const { rerender } = render(
    tree({
      ...(overrides.stages ? { stages: overrides.stages } : {}),
      ...(overrides.continueReady !== undefined
        ? { continueReady: overrides.continueReady }
        : {}),
    }),
  )
  return {
    fetchSnapshot,
    update: (next) => {
      rerender(tree(next))
    },
  }
}

describe('WorldReveal — settled graph beside the wiki', () => {
  it('renders the graph entity list and the wiki groups', async () => {
    renderReveal()
    const graph = screen.getByTestId('reveal-graph')
    expect(within(graph).getByRole('button', { name: /Ashfen Reach/i })).toBeDefined()
    expect(within(graph).getByRole('button', { name: /Maeris Vale/i })).toBeDefined()
    // The wiki loads its groups once the injected snapshot resolves.
    const wiki = await screen.findByTestId('reveal-wiki')
    expect(within(wiki).getByRole('heading', { name: '[ph: places]' })).toBeDefined()
    expect(within(wiki).getByRole('heading', { name: '[ph: people]' })).toBeDefined()
  })

  it('shows a calm loading placeholder before the snapshot resolves', () => {
    // A never-resolving fetch keeps the wiki panel in its loading state.
    const pending = new Promise<WorldGenSnapshot>(() => {
      /* deliberately never resolves */
    })
    renderReveal({ fetchSnapshot: vi.fn(() => pending) })
    expect(screen.getByText('[ph: settling your world]')).toBeDefined()
    expect(screen.queryByTestId('reveal-wiki')).toBeNull()
  })

  it('shows the honest UNAVAILABLE line when the snapshot fetch fails (never an error flash)', async () => {
    // The owner-only endpoint 403s for a member (myth-0xwos) and any fetch can
    // fail transiently — the panel settles to a calm unavailable line, distinct
    // from "your world is empty", and never throws into the route.
    renderReveal({ fetchSnapshot: vi.fn().mockRejectedValue(new Error('403 forbidden')) })
    expect(await screen.findByText(i18n.t('worldReveal.unavailable'))).toBeDefined()
    expect(screen.queryByTestId('reveal-wiki')).toBeNull()
  })
})

describe('WorldReveal — desktop layout (true 50/50)', () => {
  it('lays graph and wiki as a FIXED two-pane 50/50 (no auto-fill empty tracks)', async () => {
    renderReveal()
    const panes = screen.getByTestId('reveal-panes')
    // The settled RevealPanes frame (D6): two equal-grow min-width-0 cells and
    // the `--space-4` gutter — the same track behavior the old `Grid columns={2}`
    // template produced (two panes stretching to fill the full width).
    expect(panes.style.columnGap).toBe('var(--space-4)')
    const cells = Array.from(panes.children) as HTMLElement[]
    expect(cells).toHaveLength(2)
    expect(cells[0]?.className).toContain('min-w-0')
    expect(cells[1]?.className).toContain('min-w-0')
    expect(cells[1]?.style.flexGrow).toBe('1')
    expect(within(panes).getByTestId('reveal-graph')).toBeDefined()
    expect(await within(panes).findByTestId('reveal-wiki')).toBeDefined()
  })

  it('renders NO drawer on a wide viewport (the pane carries the wiki)', async () => {
    renderReveal()
    await screen.findByTestId('reveal-wiki')
    expect(screen.queryByTestId('reveal-drawer')).toBeNull()
  })
})

describe('WorldReveal — mobile layout (full-bleed graph + wiki drawer)', () => {
  it('renders the graph in a full-bleed stage and the wiki in a CLOSED drawer', async () => {
    mockViewport({ narrow: true })
    renderReveal()
    // The graph owns the glass: the FullBleedStage mechanism (the generating
    // act's), not the desktop grid.
    expect(within(screen.getByTestId('reveal-stage')).getByTestId('reveal-graph')).toBeDefined()
    expect(screen.queryByTestId('reveal-panes')).toBeNull()
    // The drawer sheet is closed (transform + inert — the Drawer contract) but
    // its wiki child is MOUNTED, so reader state survives close→open.
    const sheet = screen.getByTestId('reveal-drawer')
    expect(sheet.getAttribute('data-state')).toBe('closed')
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(await within(sheet).findByTestId('reveal-wiki')).toBeDefined()
  })

  it('opens the drawer onto the entity page when a graph node is chosen', async () => {
    mockViewport({ narrow: true })
    renderReveal()
    const sheet = screen.getByTestId('reveal-drawer')
    await within(sheet).findByTestId('reveal-wiki')
    fireEvent.click(
      within(screen.getByTestId('reveal-graph')).getByRole('button', { name: /Maeris Vale/i }),
    )
    // The page pushes synchronously; the summon is deferred ONE macrotask past
    // the tapping gesture (see handleGraphSelect — the Radix armed-dismiss
    // interplay), so the open state needs a beat.
    expect(within(sheet).getByRole('heading', { name: 'Maeris Vale' })).toBeDefined()
    await waitFor(() => {
      expect(sheet.getAttribute('data-state')).toBe('open')
    })
  })
})

describe('WorldReveal — shared selection (graph ↔ wiki)', () => {
  it('choosing a graph entity opens the matching wiki page (displayId = id)', async () => {
    renderReveal()
    const wiki = await screen.findByTestId('reveal-wiki')
    const graph = screen.getByTestId('reveal-graph')
    // Choose Maeris Vale in the GRAPH: its displayId ent-npc-1 IS the entity id.
    fireEvent.click(within(graph).getByRole('button', { name: /Maeris Vale/i }))
    // The WIKI pushes ent-npc-1's PAGE (the D4 rebuild): its name as the title,
    // its fact as the body.
    expect(within(wiki).getByRole('heading', { name: 'Maeris Vale' })).toBeDefined()
    expect(within(wiki).getByText('Harbourmaster of the Reach.')).toBeDefined()
  })

  it('choosing a wiki entity highlights the matching graph node (id = displayId)', async () => {
    renderReveal()
    const wiki = await screen.findByTestId('reveal-wiki')
    const graph = screen.getByTestId('reveal-graph')
    // Choose Maeris Vale in the WIKI: entity id ent-npc-1 = graph node displayId.
    fireEvent.click(within(wiki).getByRole('button', { name: 'Maeris Vale' }))
    const graphBtn = within(graph).getByRole('button', { name: /Maeris Vale/i })
    expect(graphBtn.getAttribute('aria-current')).toBe('true')
  })

  it('re-opens the SAME page after backing out (tap → back → tap the same node)', async () => {
    // `back()` reports nothing outward, so the push signal must be ONE-SHOT:
    // a re-tap of the unchanged selection has to read as a fresh change or the
    // wiki stays inert on home (the D4-review re-tap bug).
    renderReveal()
    const wiki = await screen.findByTestId('reveal-wiki')
    const graph = screen.getByTestId('reveal-graph')
    const tapMaeris = (): void => {
      fireEvent.click(within(graph).getByRole('button', { name: /Maeris Vale/i }))
    }
    tapMaeris()
    expect(within(wiki).getByRole('heading', { name: 'Maeris Vale' })).toBeDefined()
    // Back out to home (the i18n-wired back label — obligation 2's wiring).
    fireEvent.click(within(wiki).getByRole('button', { name: i18n.t('worldReveal.wikiBack') }))
    expect(within(wiki).queryByRole('heading', { name: 'Maeris Vale' })).toBeNull()
    tapMaeris()
    expect(within(wiki).getByRole('heading', { name: 'Maeris Vale' })).toBeDefined()
  })
})

describe('WorldReveal — RELATED cross-links (relationship-bearing snapshot)', () => {
  it('populates RELATED from the snapshot relationships and hops on activation', async () => {
    renderReveal()
    const wiki = await screen.findByTestId('reveal-wiki')
    fireEvent.click(within(wiki).getByRole('button', { name: 'Maeris Vale' }))
    // The i18n-wired RELATED section label (obligation 2), then the other
    // endpoint's name with the de-snaked relationship label.
    expect(within(wiki).getByText(i18n.t('worldReveal.wikiRelated'))).toBeDefined()
    const link = within(wiki).getByRole('button', { name: /Ashfen Reach/i })
    expect(link.textContent).toContain('harbourmaster of')
    fireEvent.click(link)
    // The hop lands on Ashfen Reach — a factless entity, so the page shows the
    // i18n-wired empty-body note (obligation 2's third label).
    expect(within(wiki).getByRole('heading', { name: 'Ashfen Reach' })).toBeDefined()
    expect(within(wiki).getByText(i18n.t('worldReveal.wikiEmptyBody'))).toBeDefined()
  })
})

describe('WorldReveal — continue', () => {
  it('fires the continue intent when Continue is pressed', () => {
    const onContinue = vi.fn()
    renderReveal({ onContinue })
    fireEvent.click(screen.getByTestId('reveal-continue'))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('offers Continue by default (a settled world)', () => {
    renderReveal()
    expect(screen.getByTestId('reveal-continue')).toBeDefined()
  })

  it('hides Continue while the tail is still running (continueReady={false})', () => {
    renderReveal({ continueReady: false })
    expect(screen.queryByTestId('reveal-continue')).toBeNull()
  })

  it('grows Continue quietly when the pipeline completes (continueReady flips true)', async () => {
    const handle = renderReveal({ continueReady: false })
    expect(screen.queryByTestId('reveal-continue')).toBeNull()
    handle.update({ continueReady: true })
    expect(screen.getByTestId('reveal-continue')).toBeDefined()
    // The rest of the reveal is untouched by the flip — the wiki stays put.
    expect(await screen.findByTestId('reveal-wiki')).toBeDefined()
  })
})

describe('WorldReveal — silent updates while the tail runs (MYT-89 reveal timing)', () => {
  // The reconciled world: the refetch returns an EXTRA fact (what a
  // coherence-pass patch or a consolidated ghost looks like from here).
  const RECONCILED: WorldGenSnapshot = {
    ...SNAPSHOT,
    facts: [
      ...SNAPSHOT.facts,
      {
        id: 'fact-2',
        entityId: 'ent-npc-1',
        topic: 'Standing',
        content: 'Owes the Bell-Wardens a favor.',
      },
    ],
  }

  it('refetches the snapshot when a tail stage COMPLETES — the reconciled data appears', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(SNAPSHOT)
      .mockResolvedValueOnce(RECONCILED)
    const handle = renderReveal({
      fetchSnapshot,
      continueReady: false,
      stages: [stageAt('entity_relationships', 'completed')],
    })
    await screen.findByTestId('reveal-wiki')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    // A silent tail stage lands → the token bumps → ONE quiet refetch.
    handle.update({
      continueReady: false,
      stages: [
        stageAt('entity_relationships', 'completed'),
        stageAt('entity_consolidation', 'completed'),
      ],
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    // The reconciled fact surfaces once the refetch resolves — open the entity.
    const wiki = await screen.findByTestId('reveal-wiki')
    fireEvent.click(within(wiki).getByRole('button', { name: 'Maeris Vale' }))
    expect(await within(wiki).findByText('Owes the Bell-Wardens a favor.')).toBeDefined()
  })

  it('refetches QUIETLY — the old model stays rendered, never the loading line', async () => {
    // The refetch never resolves: the reveal must keep showing the ORIGINAL
    // wiki (no spinner takeover, no loading placeholder, no empty state).
    let first = true
    const pendingForever = new Promise<WorldGenSnapshot>(() => {
      /* deliberately never resolves */
    })
    const fetchSnapshot = vi.fn((): Promise<WorldGenSnapshot> => {
      if (first) {
        first = false
        return Promise.resolve(SNAPSHOT)
      }
      return pendingForever
    })
    const handle = renderReveal({
      fetchSnapshot,
      continueReady: false,
      stages: [stageAt('entity_relationships', 'completed')],
    })
    const wiki = await screen.findByTestId('reveal-wiki')
    handle.update({
      continueReady: false,
      stages: [
        stageAt('entity_relationships', 'completed'),
        stageAt('coherence_pass', 'completed'),
      ],
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    // Still the browsable wiki with the original content — quiet by construction.
    expect(screen.getByTestId('reveal-wiki')).toBe(wiki)
    expect(screen.queryByText('[ph: settling your world]')).toBeNull()
    expect(within(wiki).getByRole('heading', { name: '[ph: people]' })).toBeDefined()
  })

  it('does NOT refetch while a tail stage is merely RUNNING (completions only)', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    const handle = renderReveal({
      fetchSnapshot,
      continueReady: false,
      stages: [stageAt('entity_relationships', 'completed')],
    })
    await screen.findByTestId('reveal-wiki')
    handle.update({
      continueReady: false,
      stages: [
        stageAt('entity_relationships', 'completed'),
        stageAt('entity_consolidation', 'running'),
      ],
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
  })
})
