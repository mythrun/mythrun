import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
  type WorldGenStream,
} from '@mythrun/client-core'
import type { StageProgress } from '@mythrun/contract/events'
import type { WorldGenGraphProps } from '@mythrun/client-core/contract'
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
// FINALIZED-node fixture keeps synthKey ≠ displayId to prove the route keys
// selection on displayId, not synthKey), a re-tap of the SAME node re-opens
// its page after a wiki back() (the one-shot push signal), Continue is PRESENT
// from first paint but DISABLED with a settling indicator until the pipeline
// completes — then it enables IN PLACE and fires its intent — and the SILENT
// UPDATES: a
// completed tail stage in the `stages` prop quietly refetches the wiki
// snapshot (old model stays rendered — no loading takeover — until the fresh
// one resolves). The viewport regime is driven by a query-aware `matchMedia`
// stub (`mockViewport`); tests that install none run wide (the no-matchMedia
// default — desktop).
//
// THE GRAPH IS A TEST DOUBLE here (MYT-89 audit v3): the real WorldGenGraph is
// Canvas-only — the entity list that used to be its jsdom-drivable surface was
// removed (the wiki is the browse surface), and a Canvas tap cannot be driven
// under jsdom (no 2D context, no layout). These are ROUTE tests: their subject
// is the reveal's WIRING (selection plumbing, the one-shot wiki push, the
// drawer summon, the regime props), so the double renders the same neutral
// contract the real graph exposes — one button per node firing
// `onSelect(displayId)` (the Canvas tap's contract shape) plus data attributes
// mirroring the props under test. The real component's own behavior (tap
// hit-testing, camera gating, layout classes) is pinned by its unit tests in
// @mythrun/ui.
vi.mock('@mythrun/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/ui')>()
  const { createElement: h } = await import('react')
  function GraphDouble(props: WorldGenGraphProps & { 'data-testid'?: string }) {
    return h(
      'div',
      {
        'data-testid': props['data-testid'],
        'data-selected-key': props.selectedKey ?? '',
        'data-pannable': String(props.pannable ?? true),
        'data-fill-host': String(props.fillHost ?? false),
        'data-forceful-settle': String(props.forcefulSettle ?? false),
        'data-legend-hollow': props.legend?.hollow ?? '',
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
  return { ...actual, WorldGenGraph: GraphDouble }
})

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
  // jsdom's getContext THROWS ("Not implemented"); canvas-bearing components'
  // guards expect null (the same stub the graph's own unit tests install). The
  // graph itself is a test double here, but the stub keeps any other canvas
  // (and a future de-mock) inert.
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

// The MOBILE reveal mounts `DrawerBackClose` (Phase E, E2 — the Back-closes-the-drawer
// precedence), which calls react-router's `useBlocker`; that requires a DATA router
// (the app ships `createBrowserRouter`). The `<MemoryRouter>` component above is not
// one, so the narrow tests drive the reveal through `createMemoryRouter` +
// `RouterProvider` instead. The Back precedence's own behavior (POP → close vs leave)
// lives in reveal-back.test.tsx; these tests only need a data router to render.
function renderRevealMobile(overrides: RevealOverrides = {}): RevealHandle {
  const fetchSnapshot = overrides.fetchSnapshot ?? vi.fn().mockResolvedValue(SNAPSHOT)
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <ThemeProvider>
            <ApiClientProvider value={testCtx}>
              <I18nextProvider i18n={i18n}>
                <WorldReveal
                  campaignId={CAMPAIGN_ID}
                  nodes={NODES}
                  edges={[]}
                  fetchSnapshot={fetchSnapshot}
                  {...(overrides.stages ? { stages: overrides.stages } : {})}
                  {...(overrides.continueReady !== undefined ? { continueReady: overrides.continueReady } : {})}
                  {...(overrides.onContinue ? { onContinue: overrides.onContinue } : {})}
                />
              </I18nextProvider>
            </ApiClientProvider>
          </ThemeProvider>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  // A data router bakes its element — these tests don't re-render with new props.
  return {
    fetchSnapshot,
    update: () => {
      throw new Error('renderRevealMobile does not support update()')
    },
  }
}

describe('WorldReveal — settled graph beside the wiki', () => {
  it('renders the graph pane (fed the folded nodes) and the wiki groups', async () => {
    renderReveal()
    const graph = screen.getByTestId('reveal-graph')
    expect(within(graph).getByRole('button', { name: /Ashfen Reach/i })).toBeDefined()
    expect(within(graph).getByRole('button', { name: /Maeris Vale/i })).toBeDefined()
    // The wiki loads its groups once the injected snapshot resolves.
    const wiki = await screen.findByTestId('reveal-wiki')
    expect(within(wiki).getByRole('heading', { name: i18n.t('worldReveal.group.location') })).toBeDefined()
    expect(within(wiki).getByRole('heading', { name: i18n.t('worldReveal.group.npc') })).toBeDefined()
  })

  it('opens the wiki on the world INTRODUCTION when the snapshot carries one — no extra fetch', async () => {
    // The intro arrives WITH the first snapshot (the reveal boundary
    // guarantees it for every post-migration world): the wiki's home is the
    // front door — title, prose, dig-deeper references — from one fetch.
    // The bare SNAPSHOT elsewhere in this file pins the OLD-world fallback:
    // the same panel opens on the browse home when `introduction` is absent.
    const withIntro: WorldGenSnapshot = {
      ...SNAPSHOT,
      introduction: {
        title: 'The Ashfen Reaches',
        prose: 'A tidewater world of salt and tallow.\n\nIts powers keep uneasy ledgers.',
        references: [{ entityId: 'ent-npc-1', name: 'Maeris Vale' }],
      },
    }
    const fetchSnapshot = vi.fn().mockResolvedValue(withIntro)
    renderReveal({ fetchSnapshot })
    const wiki = await screen.findByTestId('reveal-wiki')
    expect(within(wiki).getByRole('heading', { name: 'The Ashfen Reaches' })).toBeDefined()
    expect(within(wiki).getByText('A tidewater world of salt and tallow.')).toBeDefined()
    expect(within(wiki).getByText(i18n.t('worldReveal.wikiDigDeeper'))).toBeDefined()
    // The reference row: the wire name annotated with its kind label (the group label).
    expect(
      within(wiki).getByRole('button', { name: `Maeris Vale ${i18n.t('worldReveal.group.npc')}` }),
    ).toBeDefined()
    // The browse index rides the same surface (search + groups reachable).
    expect(within(wiki).getByText(i18n.t('worldReveal.wikiIndex'))).toBeDefined()
    expect(within(wiki).getByRole('heading', { name: i18n.t('worldReveal.group.location') })).toBeDefined()
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('shows a calm loading placeholder before the snapshot resolves', () => {
    // A never-resolving fetch keeps the wiki panel in its loading state.
    const pending = new Promise<WorldGenSnapshot>(() => {
      /* deliberately never resolves */
    })
    renderReveal({ fetchSnapshot: vi.fn(() => pending) })
    expect(screen.getByText(i18n.t('worldReveal.loading'))).toBeDefined()
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

describe('WorldReveal — wiki home is the guaranteed keyboard path to every entity (Phase E, E2)', () => {
  // The graph canvas is aria-hidden; the roving hidden node list (WorldGenGraph E2)
  // is one keyboard path, and the wiki HOME browse is the guaranteed one — every
  // entity of every kind is a NATIVE button (Enter/Space-activatable, in the tab
  // order by construction), reachable against the CURRENT intro-as-home surface.
  it('renders every snapshot entity as a keyboard-activatable button that opens its page', async () => {
    renderReveal()
    const wiki = await screen.findByTestId('reveal-wiki')
    // Both kinds present in the browse index: a location and an npc.
    for (const name of ['Ashfen Reach', 'Maeris Vale']) {
      const row = within(wiki).getByRole('button', { name })
      expect(row.tagName).toBe('BUTTON') // native — keyboard activation is inherent
    }
    // Activating a home row opens that entity's page (the keyboard path lands).
    fireEvent.click(within(wiki).getByRole('button', { name: 'Maeris Vale' }))
    expect(within(wiki).getByRole('heading', { name: 'Maeris Vale' })).toBeDefined()
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

  it('desktop graph: camera gated OFF, pane fills its half, forceful settle ON (regime props)', () => {
    // The desktop reveal must FILL, never pan: pannable={false} zeroes the
    // camera's seat; fillHost lets the pane take the RevealPanes row height.
    // The settled world INSISTS on its shape (audit v4): forcefulSettle runs
    // the reveal force profile + drag releases snap back.
    renderReveal()
    const graph = screen.getByTestId('reveal-graph')
    expect(graph.getAttribute('data-pannable')).toBe('false')
    expect(graph.getAttribute('data-fill-host')).toBe('true')
    expect(graph.getAttribute('data-forceful-settle')).toBe('true')
  })
})

describe('WorldReveal — mobile layout (full-bleed graph + wiki drawer)', () => {
  it('renders the graph in a full-bleed stage and the wiki in a CLOSED drawer', async () => {
    mockViewport({ narrow: true })
    renderRevealMobile()
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
    renderRevealMobile()
    const sheet = screen.getByTestId('reveal-drawer')
    await within(sheet).findByTestId('reveal-wiki')
    fireEvent.click(
      within(screen.getByTestId('reveal-graph')).getByRole('button', { name: /Maeris Vale/i }),
    )
    // Page push AND summon are both synchronous now (myth-cwhdk moved the
    // armed-dismiss guard into the Drawer, retiring D5's macrotask defer here).
    expect(within(sheet).getByRole('heading', { name: 'Maeris Vale' })).toBeDefined()
    expect(sheet.getAttribute('data-state')).toBe('open')
  })

  // myth-1k9qt — the wiki is the SCROLLER inside the sheet, not the sheet body:
  // it takes the sheet's height (`Box grow` → flex-1 min-h-0) so its own scroll
  // container actually moves. While the body was the only scroller the wiki's
  // per-page scroll capture read 0 every time and restore was inert on mobile.
  it('hands the wiki the sheet height so it owns the scrolling (scroll memory is live)', async () => {
    mockViewport({ narrow: true })
    renderRevealMobile()
    const sheet = screen.getByTestId('reveal-drawer')
    const wiki = await within(sheet).findByTestId('reveal-wiki')
    const sheetBody = sheet.querySelector('[data-mythrun-drawer-body]')
    expect(sheetBody).not.toBeNull()
    expect(sheetBody?.contains(wiki)).toBe(true)
    // Every box between the body and the wiki is a fill, so the height reaches it.
    for (let el = wiki.parentElement; el !== null && el !== sheetBody; el = el.parentElement) {
      expect(el.className).toMatch(/\bgrow\b|\bflex-1\b/)
    }
  })

  it('mobile graph: the pannable camera stays, host-fill + forceful settle ON (regime props)', () => {
    // Audit v4: the mobile reveal pane must reach the FOLD. The stage already
    // fills the viewport below the header (the generating act's geometry); the
    // graph must FILL it — v3's `!narrow` gate left the pane on its own 62dvh
    // clamp, stopping two-thirds down the screen (the height-gap screenshot).
    // The pannable camera stays (the exploration surface), and the forceful
    // settle regime is on here too (both breakpoints).
    mockViewport({ narrow: true })
    renderRevealMobile()
    const graph = screen.getByTestId('reveal-graph')
    expect(graph.getAttribute('data-pannable')).toBe('true')
    expect(graph.getAttribute('data-fill-host')).toBe('true')
    expect(graph.getAttribute('data-forceful-settle')).toBe('true')
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
    // Choose Maeris Vale in the WIKI: entity id ent-npc-1 = graph node displayId
    // — the route hands it straight to the graph's selectedKey (the double
    // mirrors the prop; the real Canvas raises + pins the matching glyph).
    fireEvent.click(within(wiki).getByRole('button', { name: 'Maeris Vale' }))
    expect(graph.getAttribute('data-selected-key')).toBe('ent-npc-1')
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
  it('fires the continue intent when an ENABLED Continue is pressed', () => {
    const onContinue = vi.fn()
    renderReveal({ onContinue })
    fireEvent.click(screen.getByTestId('reveal-continue'))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('offers Continue ENABLED, no settling indicator, by default (a settled world)', () => {
    renderReveal()
    expect(screen.getByTestId('reveal-continue').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('reveal-continue-pending')).toBeNull()
  })

  it('keeps Continue PRESENT but DISABLED with a settling indicator while the tail runs', () => {
    // The affordance EXISTS from first paint (no dead-end): the button is here,
    // just not pressable yet, with the quiet settling line beside it explaining
    // why — the honest replacement for the old `null` gate that hid it entirely.
    const onContinue = vi.fn()
    renderReveal({ onContinue, continueReady: false })
    const button = screen.getByTestId('reveal-continue')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('reveal-continue-pending')).toBeDefined()
    expect(screen.getByText(i18n.t('worldReveal.settling'))).toBeDefined()
    // A disabled press is inert — the gated intent never fires.
    fireEvent.click(button)
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('ENABLES Continue IN PLACE when the pipeline completes — the settling indicator goes', async () => {
    const onContinue = vi.fn()
    const handle = renderReveal({ onContinue, continueReady: false })
    expect(screen.getByTestId('reveal-continue').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('reveal-continue-pending')).toBeDefined()
    handle.update({ continueReady: true })
    // The SAME button (present all along) flips to enabled; the settling line is gone.
    const after = screen.getByTestId('reveal-continue')
    expect(after.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('reveal-continue-pending')).toBeNull()
    // Now pressable — the intent fires.
    fireEvent.click(after)
    expect(onContinue).toHaveBeenCalledOnce()
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
    expect(screen.queryByText(i18n.t('worldReveal.loading'))).toBeNull()
    expect(within(wiki).getByRole('heading', { name: i18n.t('worldReveal.group.npc') })).toBeDefined()
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

describe('WorldReveal — the panel is the document; the left slot is a quiet eyebrow (ux-run3)', () => {
  // Run-3 found the world's name TWICE at the same register — the left page
  // title and the wiki panel's header, identical size/weight on one baseline.
  // The PANEL is the document and keeps the name; the left slot demotes to a
  // static "Your world" eyebrow (the codebase's uppercase ui-label register).
  // The H1 stays in the outline — visually hidden, still the world's name
  // (myth-8ozsw's a11y intent survives the visual demotion).
  const withIntro: WorldGenSnapshot = {
    ...SNAPSHOT,
    introduction: {
      title: 'The Ashfen Reaches',
      prose: 'A tidewater world of salt and tallow.',
      references: [],
    },
  }

  it('shows the world name ONCE visibly — the panel header; the page H1 is visually hidden', async () => {
    renderReveal({ fetchSnapshot: vi.fn().mockResolvedValue(withIntro) })
    const wiki = await screen.findByTestId('reveal-wiki')
    const named = screen.getAllByRole('heading', { name: 'The Ashfen Reaches' })
    // Exactly two carriers: the panel's visible header + the sr-only outline H1.
    expect(named).toHaveLength(2)
    const panelHeader = named.find((el) => wiki.contains(el))
    const outlineH1 = named.find((el) => !wiki.contains(el))
    expect(panelHeader).toBeDefined()
    expect(outlineH1?.tagName).toBe('H1')
    // The H1 rides the VisuallyHidden clip wrapper — in the outline, off the glass.
    expect(outlineH1?.parentElement?.style.position).toBe('absolute')
  })

  it('demotes the left slot to the static eyebrow — never a second full-size title', async () => {
    renderReveal({ fetchSnapshot: vi.fn().mockResolvedValue(withIntro) })
    await screen.findByTestId('reveal-wiki')
    // The eyebrow: the generic "Your world" register, NOT a heading, in the
    // small uppercase ui-label class the codebase's other eyebrows wear.
    const eyebrow = screen.getByText(i18n.t('worldReveal.title'))
    expect(eyebrow.tagName).not.toMatch(/^H[1-6]$/)
    expect(eyebrow.className).toContain('uppercase')
    expect(screen.queryByRole('heading', { name: i18n.t('worldReveal.title') })).toBeNull()
  })

  it('keeps the outline H1 on the generic title while the name is unknown (pre-intro snapshot)', async () => {
    renderReveal()
    await screen.findByTestId('reveal-wiki')
    // The SNAPSHOT fixture has no introduction — the outline keeps a real H1.
    expect(screen.getByRole('heading', { level: 1, name: i18n.t('worldReveal.title') })).toBeDefined()
  })
})

describe('WorldReveal — the legend documents the hollow marks (ux-run3)', () => {
  it('feeds the graph legend the resolved hollow label (the DS owns no copy)', () => {
    renderReveal()
    // The route resolves the copy; the DS receives it through the legend map's
    // reserved `hollow` seat (the GraphDouble mirrors the prop).
    expect(screen.getByTestId('reveal-graph').getAttribute('data-legend-hollow')).toBe(
      i18n.t('worldReveal.legendHollow'),
    )
  })
})
