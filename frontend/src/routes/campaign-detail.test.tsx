import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  useWorldGenStream,
  type ApiContext,
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
vi.mock('@mythrun/client-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/client-core')>()
  return { ...actual, useWorldGenStream: vi.fn() }
})

const mockStream = vi.mocked(useWorldGenStream)

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
  return { phase: null, nodes: [], edges: [], status: 'generating', retry: vi.fn(), ...overrides }
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
  it('renders the streaming world-gen graph while generating', () => {
    mockStream.mockReturnValue(
      streamValue({ status: 'generating', phase: 'world_gen', nodes: NODES }),
    )
    renderDetail()
    // The accessible entity list (WorldGenGraph's a11y surface) carries a node name.
    expect(screen.getByText('Ashfen Reach')).toBeDefined()
    expect(screen.getByTestId('worldgen-generating')).toBeDefined()
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

  it('renders the completion handoff placeholder when world-gen just finished', () => {
    mockStream.mockReturnValue(streamValue({ status: 'complete', phase: 'world_ready' }))
    renderDetail()
    expect(screen.getByTestId('worldgen-complete')).toBeDefined()
  })

  it('falls through to the existing detail content for an already-active campaign', () => {
    mockStream.mockReturnValue(streamValue({ status: 'complete', phase: 'complete' }))
    renderDetail()
    expect(screen.getByTestId('route-campaign-detail')).toBeDefined()
  })
})
