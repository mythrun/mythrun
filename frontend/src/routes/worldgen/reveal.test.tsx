import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { ApiClientProvider, type ApiContext, type WorldGenStream } from '@mythrun/client-core'
import type { StageProgress } from '@mythrun/contract/events'
import type { WorldSnapshot } from '@mythrun/contract/rest'
import { i18n } from '../../i18n/config.ts'
import { WorldReveal } from './reveal.tsx'

// The WORLD REVEAL (MYT-89 Phase D, D3 + reveal timing) — the graph BESIDE the
// browsable wiki with SHARED SELECTION. The wiki model is fetched via an
// injected `fetchSnapshot` (default `getWorldSnapshot`); the graph nodes arrive
// as props. These tests inject a resolved snapshot and assert: both surfaces
// render, a selection in EITHER surface highlights the matching entity in the
// other (BUG 2.1: single `displayId` id-space — post-gen a finalized node's
// `displayId` IS its entity id, so no synthKey↔id bridge; the FINALIZED-node
// fixture keeps synthKey ≠ displayId to prove the graph keys selection on
// displayId, not synthKey), Continue fires its intent + is GATED until the
// pipeline completes, and the SILENT UPDATES: a completed tail stage in the
// `stages` prop quietly refetches the wiki snapshot (old model stays rendered —
// no loading takeover — until the fresh one resolves). WorldGenGraph's Canvas
// is a jsdom no-op (its meaning lives in the accessible entity list); only that
// list is queried.

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
})

// Finalized nodes whose synthKey ≠ displayId — the post-gen reality: the graph
// selects by `displayId` (= the finalized node's entity id), the wiki by entity
// id, so ONE id feeds both with no bridge. Distinct synthKey/displayId values
// prove selection keys on displayId (a synthKey-keyed graph would never match).
const NODES: WorldGenStream['nodes'] = [
  { synthKey: 's1/reach', kind: 'location', name: 'Ashfen Reach', displayId: 'ent-loc-1', state: 'finalized', lastEventIndex: 0 },
  { synthKey: 's2/maeris', kind: 'npc', name: 'Maeris Vale', displayId: 'ent-npc-1', state: 'finalized', lastEventIndex: 1 },
]

const SNAPSHOT: WorldSnapshot = {
  entities: [
    { id: 'ent-loc-1', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'ent-npc-1', entityType: 'npc', name: 'Maeris Vale' },
  ],
  facts: [
    { id: 'fact-1', entityId: 'ent-npc-1', topic: 'Role', content: 'Harbourmaster of the Reach.' },
  ],
  entityHierarchy: [],
}

interface RevealOverrides {
  fetchSnapshot?: () => Promise<WorldSnapshot>
  onContinue?: () => void
  stages?: readonly StageProgress[]
  continueReady?: boolean
}

interface RevealHandle {
  fetchSnapshot: () => Promise<WorldSnapshot>
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
    const pending = new Promise<WorldSnapshot>(() => {
      /* deliberately never resolves */
    })
    renderReveal({ fetchSnapshot: vi.fn(() => pending) })
    expect(screen.getByText('[ph: settling your world]')).toBeDefined()
    expect(screen.queryByTestId('reveal-wiki')).toBeNull()
  })
})

describe('WorldReveal — shared selection (graph ↔ wiki)', () => {
  it('choosing a graph entity highlights the matching wiki entity (displayId = id)', async () => {
    renderReveal()
    const wiki = await screen.findByTestId('reveal-wiki')
    const graph = screen.getByTestId('reveal-graph')
    // Choose Maeris Vale in the GRAPH: its displayId ent-npc-1 IS the entity id.
    fireEvent.click(within(graph).getByRole('button', { name: /Maeris Vale/i }))
    // The WIKI entity ent-npc-1 becomes current and opens to its fact.
    const wikiBtn = within(wiki).getByRole('button', { name: 'Maeris Vale' })
    expect(wikiBtn.getAttribute('aria-current')).toBe('true')
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
  const RECONCILED: WorldSnapshot = {
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
    const pendingForever = new Promise<WorldSnapshot>(() => {
      /* deliberately never resolves */
    })
    const fetchSnapshot = vi.fn((): Promise<WorldSnapshot> => {
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
