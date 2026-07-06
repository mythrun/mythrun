import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { ApiClientProvider, type ApiContext, type WorldGenStream } from '@mythrun/client-core'
import type { WorldSnapshot } from '@mythrun/contract/rest'
import { i18n } from '../../i18n/config.ts'
import { WorldReveal } from './reveal.tsx'

// The WORLD REVEAL (MYT-89 Phase D, D3) — the settled graph BESIDE the browsable
// wiki with SHARED SELECTION. The wiki model is fetched via an injected
// `fetchSnapshot` (default `getWorldSnapshot`); the graph nodes arrive as props.
// These tests inject a resolved snapshot and assert: both surfaces render, a
// selection in EITHER surface highlights the matching entity in the other (BUG
// 2.1: single `displayId` id-space — post-gen a finalized node's `displayId` IS
// its entity id, so no synthKey↔id bridge; the FINALIZED-node fixture keeps
// synthKey ≠ displayId to prove the graph keys selection on displayId, not
// synthKey), and Continue fires its intent. WorldGenGraph's Canvas is a jsdom
// no-op (its meaning lives in the accessible entity list); only that list is
// queried.

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
}

function renderReveal(overrides: RevealOverrides = {}): { fetchSnapshot: () => Promise<WorldSnapshot> } {
  const fetchSnapshot = overrides.fetchSnapshot ?? vi.fn().mockResolvedValue(SNAPSHOT)
  render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <WorldReveal
              campaignId={CAMPAIGN_ID}
              nodes={NODES}
              edges={[]}
              fetchSnapshot={fetchSnapshot}
              {...(overrides.onContinue ? { onContinue: overrides.onContinue } : {})}
            />
          </MemoryRouter>
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
  return { fetchSnapshot }
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
})
