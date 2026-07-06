import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  useWorldGenStream,
  getStartingSituations,
  getMyCampaigns,
  type ApiContext,
  type CampaignSummary,
  type WorldGenStream,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CampaignDetailRoute } from './campaign-detail.tsx'

// Mock ONLY the world-gen stream off the client-core barrel; every other export
// (ApiClientProvider, the types) stays real, so the route mounts through the
// actual provider stack. `vi.mock` is hoisted above these imports by vitest, so
// the `useWorldGenStream` binding above is already the mock. The route's branch
// is driven entirely by the hook's `{ status, phase, nodes, edges, retry }`
// return, so a per-case mock return exercises every arm without a live SSE.
// `getWorldSnapshot` is stubbed too: the `complete/world_ready` arm now renders
// the Phase D <WorldReveal>, which fetches the world snapshot for its wiki via the
// barrel's `getWorldSnapshot`. An empty resolved snapshot keeps the reveal's wiki
// panel calm without a live endpoint (the reveal's own test covers the wiki).
vi.mock('@mythrun/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/client-core')>()
  return {
    ...actual,
    useWorldGenStream: vi.fn(),
    getWorldSnapshot: vi
      .fn()
      .mockResolvedValue({ entities: [], facts: [], entityHierarchy: [], relationships: [] }),
    // The post-situation seam: `world_ready` splits reveal-vs-page on the chosen
    // starting-situation flag (see campaign-detail.tsx). Default `chosenIndex: null`
    // → the reveal (pre-situation). `getMyCampaigns` feeds the campaign page's world
    // identity (worldName + worldColors), found by id.
    getStartingSituations: vi.fn().mockResolvedValue({ situations: [], chosenIndex: null }),
    getMyCampaigns: vi.fn().mockResolvedValue({ campaigns: [] }),
    // The ETA history (audit ③): the route fetches it once while generating.
    // Cold-start `[]` → the status card shows the bars with no estimate.
    getStageTimings: vi.fn().mockResolvedValue([]),
  }
})

const mockStream = vi.mocked(useWorldGenStream)
const mockSituations = vi.mocked(getStartingSituations)
const mockCampaigns = vi.mocked(getMyCampaigns)

// One hub-shaped campaign carrying a world identity (name + dither pair) — the
// campaign page finds it by id off `getMyCampaigns` and renders its world name.
const CAMPAIGN: CampaignSummary = {
  id: 'c1',
  worldId: 'w1',
  name: 'The Ashfen Pact',
  status: 'setup',
  language: 'en',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  worldName: 'Emberdeep Hollow',
  worldColors: { from: 'moss-100', to: 'verdigris-800' },
  creator: null,
  party: [],
  sessionCount: 0,
  lastPlayedAt: null,
  cardPhase: 'needs-character',
}

// ENVIRONMENT shim (Node 25 vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; Node 25's non-functional builtin SHADOWS jsdom's real
// Storage. Install a functional in-memory one (mirrors campaign-new.test.tsx).
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

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
  // jsdom's getContext THROWS ("Not implemented") rather than returning null;
  // WorldGenGraph's canvas guard expects a null. Stub it null so the decorative
  // Canvas is a clean no-op and only the accessible entity list renders (the
  // same stub WorldGenGraph's own unit test installs). `clearAllMocks` keeps the
  // implementation, so this holds across every case.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// A modest fixture (2 nodes) — heavy graphs render slowly in jsdom and can
// overrun CI's waitFor default (reference_heavy_svg_render_ci_waitfor_timeout).
const NODES: WorldGenStream['nodes'] = [
  { synthKey: 's1/reach', kind: 'location', name: 'Ashfen Reach', displayId: 's1/reach', state: 'live', lastEventIndex: 0 },
  { synthKey: 's2/maeris', kind: 'npc', name: 'Maeris Vale', displayId: 's2/maeris', state: 'live', lastEventIndex: 1 },
]

function streamValue(overrides: Partial<WorldGenStream>): WorldGenStream {
  return {
    phase: null,
    nodes: [],
    edges: [],
    status: 'generating',
    stages: [],
    costUsd: null,
    retry: vi.fn(),
    ...overrides,
  }
}

function renderDetail(): void {
  const router = createMemoryRouter(
    [{ path: '/campaigns/:id', element: <CampaignDetailRoute /> }],
    { initialEntries: ['/campaigns/c1'] },
  )
  render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
}

describe('CampaignDetailRoute — phase-aware world-gen routing', () => {
  it('renders the gated streaming world-gen view while generating', () => {
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_gen',
        nodes: NODES,
        // C7: the generation graph is GATED (no entity list); the status card,
        // fed the stream's stages, narrates the running stage instead.
        stages: [
          {
            stage: 'concept_intake',
            status: 'running',
            userId: null,
            costUsd: 0,
            startedAt: null,
            completedAt: null,
          },
        ],
      }),
    )
    renderDetail()
    expect(screen.getByTestId('worldgen-generating')).toBeDefined()
    // The status card resolves the running stage id → its i18n friendly label.
    expect(screen.getByText(i18n.t('worldGen.stage.concept_intake'))).toBeDefined()
  })

  it('renders a Retry that calls retry() on a retryable failure', () => {
    const retry = vi.fn()
    mockStream.mockReturnValue(streamValue({ status: 'failed', phase: 'world_gen_failed', retry }))
    renderDetail()
    fireEvent.click(screen.getByTestId('worldgen-retry'))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('renders the terminal state with NO retry affordance', () => {
    mockStream.mockReturnValue(streamValue({ status: 'terminal', phase: 'failed' }))
    renderDetail()
    expect(screen.getByTestId('worldgen-terminal')).toBeDefined()
    expect(screen.queryByTestId('worldgen-retry')).toBeNull()
  })

  it('renders the Phase D world reveal at world_ready before a situation is chosen', async () => {
    mockStream.mockReturnValue(
      streamValue({ status: 'complete', phase: 'world_ready', nodes: NODES }),
    )
    // No situation chosen yet → the one-time reveal.
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: null })
    renderDetail()
    // The reveal mounts after the settling gate resolves; findBy flushes that.
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    // The settled graph's accessible entity list carries the node names.
    expect(screen.getByText('Ashfen Reach')).toBeDefined()
  })

  it('renders the campaign page at world_ready once a situation is chosen', async () => {
    mockStream.mockReturnValue(
      streamValue({ status: 'complete', phase: 'world_ready', nodes: NODES }),
    )
    // A chosen situation → the reveal is done; the campaign page (D5) lands.
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: 1 })
    mockCampaigns.mockResolvedValue({ campaigns: [CAMPAIGN] })
    renderDetail()
    // The campaign page: world identity + both MYT-89 boundary seams. The world
    // name renders only after the async campaigns fetch resolves, so await it
    // (findBy) before the synchronous sibling assertions — a bare getByTestId here
    // races the fetch and flakes under full-suite load.
    expect(await screen.findByTestId('route-campaign-detail')).toBeDefined()
    expect((await screen.findByTestId('campaign-world-name')).textContent).toBe('Emberdeep Hollow')
    expect(screen.getByTestId('seam-invite')).toBeDefined()
    expect(screen.getByTestId('seam-character')).toBeDefined()
    // The reveal must NOT show once the situation is chosen.
    expect(screen.queryByTestId('worldgen-reveal')).toBeNull()
  })

  it('falls back to the reveal when the chosen-situation fetch fails', async () => {
    mockStream.mockReturnValue(streamValue({ status: 'complete', phase: 'world_ready' }))
    mockSituations.mockRejectedValue(new Error('boom'))
    renderDetail()
    // A transient failure defaults to the pre-situation reveal (re-pick is idempotent).
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
  })

  it('renders the campaign page for an already-active campaign (phase complete)', async () => {
    mockStream.mockReturnValue(streamValue({ status: 'complete', phase: 'complete' }))
    mockCampaigns.mockResolvedValue({ campaigns: [CAMPAIGN] })
    renderDetail()
    // A later phase already has a situation → straight to the campaign page (D5).
    expect(await screen.findByTestId('route-campaign-detail')).toBeDefined()
    expect(screen.getByTestId('seam-invite')).toBeDefined()
    expect(screen.getByTestId('seam-character')).toBeDefined()
  })
})
