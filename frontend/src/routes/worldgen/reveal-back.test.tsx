import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor, fireEvent, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
  type WorldGenStream,
} from '@mythrun/client-core'
import type { RevealMoment, WorldGenGraphProps } from '@mythrun/client-core/contract'
import { i18n } from '../../i18n/config.ts'
import { WorldReveal } from './reveal.tsx'

// MOBILE BACK PRECEDENCE (MYT-89 Phase E, E2) — a browser/hardware Back (a POP
// navigation) while the reveal's wiki DRAWER is open CLOSES the drawer instead of
// leaving the route; a second Back (drawer now closed) leaves as normal. This is the
// close-drawer → leave-route layer, wired through react-router's own history
// integration (useBlocker), which requires a DATA router — so this file drives the
// reveal through `createMemoryRouter` + `RouterProvider` (not the `<MemoryRouter>`
// component the other route tests use) and pops with `router.navigate(-1)`.
//
// The graph is the same neutral test double the other reveal tests use (the real
// WorldGenGraph is canvas-only); the subject here is the drawer↔history wiring.
vi.mock('@mythrun/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/ui')>()
  const { createElement: h } = await import('react')
  function GraphDouble(props: WorldGenGraphProps & { 'data-testid'?: string }) {
    return h(
      'div',
      { 'data-testid': props['data-testid'] },
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
  return { ...actual, WorldGenGraph: GraphDouble }
})

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

const testCtx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }
const CAMPAIGN_ID = 'c1'

const NODES: WorldGenStream['nodes'] = [
  { synthKey: 's1/reach', kind: 'location', name: 'Ashfen Reach', displayId: 'ent-loc-1', state: 'finalized', lastEventIndex: 0 },
]
const SNAPSHOT: WorldGenSnapshot = {
  entities: [{ id: 'ent-loc-1', entityType: 'location', name: 'Ashfen Reach' }],
  facts: [],
  entityHierarchy: [],
  relationships: [],
}
const DONE: RevealMoment = { phase: 'done', instant: true }

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemStorage(), configurable: true, writable: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

// The narrow regime so the reveal renders MobileReveal (the drawer path).
function mockNarrow(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(min-width: 640px)' ? false : false,
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

/** Mount the reveal at `/campaigns/:id` in a DATA router, behind a prior entry, so
 *  a POP (Back) either closes the drawer or lands on the prior page. */
function renderMobileReveal() {
  const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
  const router = createMemoryRouter(
    [
      { path: '/prev', element: <div data-testid="prev-page" /> },
      {
        path: '/campaigns/:id',
        element: (
          <ThemeProvider>
            <ApiClientProvider value={testCtx}>
              <I18nextProvider i18n={i18n}>
                <WorldReveal
                  campaignId={CAMPAIGN_ID}
                  nodes={NODES}
                  edges={[]}
                  fetchSnapshot={fetchSnapshot}
                  moment={DONE}
                />
              </I18nextProvider>
            </ApiClientProvider>
          </ThemeProvider>
        ),
      },
    ],
    { initialEntries: ['/prev', '/campaigns/c1'], initialIndex: 1 },
  )
  render(<RouterProvider router={router} />)
  return { router }
}

async function back(router: ReturnType<typeof renderMobileReveal>['router']): Promise<void> {
  await act(async () => {
    await router.navigate(-1)
  })
}

describe('WorldReveal — mobile Back precedence (close-drawer → leave-route)', () => {
  it('Back CLOSES an open drawer and stays on the reveal route (does not leave)', async () => {
    mockNarrow()
    const { router } = renderMobileReveal()
    // Open the wiki drawer from its edge handle.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('worldReveal.wikiOpen') }))
    const sheet = await screen.findByTestId('reveal-drawer')
    await waitFor(() => {
      expect(sheet.getAttribute('data-state')).toBe('open')
    })
    // Hardware Back: the drawer closes, the reveal route is untouched.
    await back(router)
    await waitFor(() => {
      expect(screen.getByTestId('reveal-drawer').getAttribute('data-state')).toBe('closed')
    })
    expect(screen.queryByTestId('prev-page')).toBeNull()
    expect(screen.getByTestId('reveal-stage')).toBeDefined()
  })

  // myth-g7kg6 — the FULL precedence: a reader three pages deep into the wiki
  // expects Back to walk back OUT of the wiki before the sheet disappears from
  // under them. Page-back first, then close-drawer, then leave-route.
  it('Back POPS the wiki PAGE before closing the drawer, then leaves the route', async () => {
    mockNarrow()
    const { router } = renderMobileReveal()
    // A graph tap opens the drawer ONTO that entity's page.
    fireEvent.click(screen.getByRole('button', { name: 'Ashfen Reach' }))
    const sheet = await screen.findByTestId('reveal-drawer')
    await waitFor(() => {
      expect(sheet.getAttribute('data-state')).toBe('open')
    })
    const backLabel = i18n.t('worldReveal.wikiBack')
    // The page's own back affordance is the marker for "a page is in view".
    await waitFor(() => {
      expect(within(sheet).getByRole('button', { name: backLabel })).toBeDefined()
    })

    // Back #1 — pops the wiki page. The drawer is STILL OPEN, on wiki home.
    await back(router)
    await waitFor(() => {
      expect(within(sheet).queryByRole('button', { name: backLabel })).toBeNull()
    })
    expect(sheet.getAttribute('data-state')).toBe('open')
    expect(screen.queryByTestId('prev-page')).toBeNull()

    // Back #2 — nothing left in the wiki stack, so the drawer closes.
    await back(router)
    await waitFor(() => {
      expect(sheet.getAttribute('data-state')).toBe('closed')
    })
    expect(screen.queryByTestId('prev-page')).toBeNull()

    // Back #3 — leaves the route.
    await back(router)
    expect(await screen.findByTestId('prev-page')).toBeDefined()
  })

  it('Back LEAVES the route when the drawer is already closed', async () => {
    mockNarrow()
    const { router } = renderMobileReveal()
    await screen.findByTestId('reveal-drawer') // mounted, closed
    await back(router)
    expect(await screen.findByTestId('prev-page')).toBeDefined()
  })
})
