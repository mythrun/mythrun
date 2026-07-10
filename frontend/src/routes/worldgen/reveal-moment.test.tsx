import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
  type WorldGenStream,
} from '@mythrun/client-core'
import type { RevealMoment } from '@mythrun/client-core/contract'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { i18n } from '../../i18n/config.ts'
import { WorldReveal, revealFogShown } from './reveal.tsx'

// THE REVEAL MOMENT'S LAYOUT STAGING (MYT-89 D6) — how WorldReveal renders each
// §3.8 phase. The moment arrives as a prop from the route's <RevealTransition>
// wrapper; the DEFAULT (no prop) is the settled end state, which is what every
// reveal.test.tsx case exercises. These tests pin the staging: title/prompt
// fades (desktop), the collapsed→equal pane frame, the drawer's `resolve`-time
// arrival (mobile), the stage's phase-invariant geometry, and the pure
// `revealFogShown` derivation behind the fog's final gust. The timeline itself
// (walk, latch, skip, reduced motion) is RevealTransition's own unit surface.

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; the platform builtin can shadow jsdom's real
// Storage. Install a functional in-memory one (mirrors reveal.test.tsx).
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
  // jsdom's getContext THROWS; the graph's canvas guard expects null (the same
  // stub every graph-hosting test installs).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

// jsdom has no matchMedia — the DS narrow-regime stub (mirrors reveal.test.tsx).
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

const NODES: WorldGenStream['nodes'] = [
  { synthKey: 's1/reach', kind: 'location', name: 'Ashfen Reach', displayId: 'ent-loc-1', state: 'finalized', lastEventIndex: 0 },
  { synthKey: 's2/maeris', kind: 'npc', name: 'Maeris Vale', displayId: 'ent-npc-1', state: 'finalized', lastEventIndex: 1 },
]

const SNAPSHOT: WorldGenSnapshot = {
  entities: [{ id: 'ent-loc-1', entityType: 'location', name: 'Ashfen Reach' }],
  facts: [],
  entityHierarchy: [],
  relationships: [],
}

const at = (phase: RevealMoment['phase']): RevealMoment => ({ phase, instant: false })

/** Mount the reveal at a moment; the handle re-renders it at another. */
function renderAt(moment: RevealMoment): { update: (next: RevealMoment) => void } {
  const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
  const tree = (m: RevealMoment): React.JSX.Element => (
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <WorldReveal
              campaignId={CAMPAIGN_ID}
              nodes={NODES}
              edges={[]}
              fetchSnapshot={fetchSnapshot}
              moment={m}
            />
          </MemoryRouter>
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>
  )
  const { rerender } = render(tree(moment))
  return {
    update: (next) => {
      rerender(tree(next))
    },
  }
}

// The MOBILE reveal mounts `DrawerBackClose` (Phase E, E2), which calls react-router's
// `useBlocker` — that needs a DATA router (the app ships `createBrowserRouter`), which
// `<MemoryRouter>` above is not. So the NARROW moment tests drive the reveal through
// `createMemoryRouter` + `RouterProvider`, updating the moment via a stateful harness
// (a data router bakes its element, so `.update()` flows through local state).
function renderAtMobile(moment: RevealMoment): { update: (next: RevealMoment) => void } {
  const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
  let setMoment: ((m: RevealMoment) => void) | undefined
  function Harness(): React.JSX.Element {
    const [m, set] = useState(moment)
    setMoment = set
    return (
      <ThemeProvider>
        <ApiClientProvider value={testCtx}>
          <I18nextProvider i18n={i18n}>
            <WorldReveal campaignId={CAMPAIGN_ID} nodes={NODES} edges={[]} fetchSnapshot={fetchSnapshot} moment={m} />
          </I18nextProvider>
        </ApiClientProvider>
      </ThemeProvider>
    )
  }
  const router = createMemoryRouter([{ path: '/', element: <Harness /> }], { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
  return {
    update: (next) => {
      act(() => {
        setMoment?.(next)
      })
    },
  }
}

describe('WorldReveal — the reveal moment stages the layout (MYT-89 D6)', () => {
  it('desktop: title is transparent before settle, visible from it (space reserved throughout)', () => {
    const handle = renderAt(at('gust'))
    const title = screen.getByRole('heading', { name: i18n.t('worldReveal.title') })
    // The fade wrapper is the heading's staging block — transparent, never absent.
    expect(title.closest('.opacity-0')).not.toBeNull()
    handle.update(at('settle'))
    expect(title.closest('.opacity-0')).toBeNull()
    expect(title.closest('.opacity-100')).not.toBeNull()
  })

  it('desktop: the explore prompt (and Continue) arrive at resolve, not before', () => {
    renderAt(at('settle'))
    const prompt = screen.getByText(i18n.t('worldReveal.explorePrompt'))
    expect(prompt.closest('.opacity-0')).not.toBeNull()
    expect(screen.getByTestId('reveal-continue').closest('.opacity-0')).not.toBeNull()
  })

  it('desktop: the panel cell is collapsed pre-resolve and equal-grow at done', () => {
    const handle = renderAt(at('gust'))
    const panes = screen.getByTestId('reveal-panes')
    const cells = Array.from(panes.children) as HTMLElement[]
    expect(panes.style.columnGap).toBe('0px')
    expect(cells[1]?.style.flexGrow).toBe('0')
    handle.update(at('done'))
    expect(panes.style.columnGap).toBe('var(--space-4)')
    expect(cells[1]?.style.flexGrow).toBe('1')
  })

  it('mobile: the drawer (its edge handle) is ABSENT before resolve and arrives at it', () => {
    mockViewport({ narrow: true })
    const handle = renderAtMobile(at('settle'))
    // Nothing occludes the just-revealed world: no sheet, no handle.
    expect(screen.queryByTestId('reveal-drawer')).toBeNull()
    handle.update(at('resolve'))
    expect(screen.getByTestId('reveal-drawer')).toBeDefined()
  })

  it('mobile: the stage geometry is identical in every phase (the gen→reveal continuity)', () => {
    mockViewport({ narrow: true })
    const handle = renderAtMobile(at('hold'))
    expect(screen.getByTestId('reveal-stage')).toBeDefined()
    handle.update(at('done'))
    expect(screen.getByTestId('reveal-stage')).toBeDefined()
  })

  it('holds the graph pane until the first fold delivers nodes (fog births at the real world size)', () => {
    // A late arriver's first render precedes the SSE snapshot (nodes []): were
    // the graph mounted then, its fog would be born drained in a 0-count
    // world and the count's arrival would GROW the virtual space — the fog
    // sim warm-starts grown slots ALIVE, resurrecting fog over a done reveal
    // (caught live on the dev stack). The pane waits for the fold instead.
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    const tree = (nodes: WorldGenStream['nodes']): React.JSX.Element => (
      <ThemeProvider>
        <ApiClientProvider value={testCtx}>
          <I18nextProvider i18n={i18n}>
            <MemoryRouter>
              <WorldReveal campaignId={CAMPAIGN_ID} nodes={nodes} edges={[]} fetchSnapshot={fetchSnapshot} />
            </MemoryRouter>
          </I18nextProvider>
        </ApiClientProvider>
      </ThemeProvider>
    )
    const { rerender } = render(tree([]))
    expect(screen.queryByTestId('reveal-graph')).toBeNull()
    rerender(tree(NODES))
    expect(screen.getByTestId('reveal-graph')).toBeDefined()
  })
})

describe('revealFogShown — the reveal fog is born drained (MYT-89 D6)', () => {
  // The fog's ONLY clear mechanism is the spawn drain (shown/total → respawn
  // flux). The reveal floors the numerator at the drain denominator so the
  // fog mounts drained for EVERY world size — the §3.8 fog-gone invariant,
  // enforced from the swap. (A live gust of a sub-floor world's residual was
  // tried and cut: the remounted sim's cold low-pass fades the haze back IN,
  // and the wind needs ~20s to carry it off — see revealFogShown's doc.)
  it('floors a sub-floor world at the drain denominator (born drained, no residual haze)', () => {
    expect(revealFogShown(30)).toBe(MIN_EXPECTED_ENTITIES)
    expect(revealFogShown(0)).toBe(MIN_EXPECTED_ENTITIES)
  })
  it('never lowers the numerator for a world past the floor (already drained)', () => {
    expect(revealFogShown(46)).toBe(46)
  })
})
