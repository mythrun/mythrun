import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import type { StageProgress } from '@mythrun/contract/events'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  useWorldGenStream,
  getStartingSituations,
  getMyCampaigns,
  getCharacterCreationProgress,
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
    getStartingSituations: vi.fn().mockResolvedValue({ situations: [], chosenIndex: null, startingLevel: null }),
    getMyCampaigns: vi.fn().mockResolvedValue({ campaigns: [] }),
    // The ETA history (audit ③): the route fetches it once while generating.
    // Cold-start `[]` → the status card shows the bars with no estimate.
    getStageTimings: vi.fn().mockResolvedValue([]),
    // MYT-90 D8: once campaign-detail delegates to CampaignPage, the mounted
    // character surface reads the viewer (getMe) + their concept row
    // (getCharacterCreationProgress). A default `integrated` concept lands the
    // surface on the non-navigating play entry so route-campaign-detail stays
    // mounted; per-test overrides drive the other branches (e.g. the failure
    // interception below).
    getMe: vi.fn().mockResolvedValue({ user: { id: 'u1', username: 'u1', displayName: 'You' } }),
    getCharacterCreationProgress: vi.fn().mockResolvedValue({
      campaignId: 'c1',
      totalMembers: 1,
      concepts: [
        {
          userId: 'u1',
          displayName: 'You',
          status: 'integrated',
          submittedAt: '2026-01-01T00:00:00.000Z',
          confirmedAt: null,
          characterId: null,
        },
      ],
      missing: [],
    }),
  }
})

const mockStream = vi.mocked(useWorldGenStream)
const mockSituations = vi.mocked(getStartingSituations)
const mockCampaigns = vi.mocked(getMyCampaigns)
const mockProgress = vi.mocked(getCharacterCreationProgress)

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

// A one-member progress board for the viewer (u1) at a given concept status — used
// by the CampaignPage-reaching tests to land the mounted surface on a stable,
// non-navigating beat (integrated → play; failed → the character-context failure).
function soloProgress(status: string): {
  campaignId: string
  totalMembers: number
  concepts: {
    userId: string
    displayName: string
    status: string
    submittedAt: string
    confirmedAt: string | null
    characterId: string | null
  }[]
  missing: never[]
} {
  return {
    campaignId: 'c1',
    totalMembers: 1,
    concepts: [
      {
        userId: 'u1',
        displayName: 'You',
        status,
        submittedAt: '2026-01-01T00:00:00.000Z',
        confirmedAt: null,
        characterId: null,
      },
    ],
    missing: [],
  }
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
  // Restore the no-matchMedia default for tests that install no stub (the
  // reduced-motion case below installs one).
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

// jsdom has no matchMedia. A QUERY-AWARE stub so one media condition can be
// forced (reduced motion below); every other query stays non-matching.
function mockMedia(matching: string): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === matching,
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
    resumedMidGen: false,
    retry: vi.fn(),
    ...overrides,
  }
}

const st = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

// The stream mid-tail: the introduction page is WRITTEN (world_introduction, the
// reveal boundary — myth-zaqxh moved it here from entity_relationships), the
// silent tail underway, worlds.status still 'generating' — the wiki-reveal window
// (MYT-89 reveal timing).
const CONNECTIONS_DONE_STAGES: readonly StageProgress[] = [
  st('world_and_factions', 'completed'),
  st('locations_and_npcs', 'completed'),
  st('entity_relationships', 'completed'),
  st('world_introduction', 'completed'),
  st('entity_consolidation', 'running'),
]

/** Renders the route; the returned `rerender` re-renders the SAME mounted route
 *  IN PLACE (the mocked stream is re-read on each render, so
 *  `mockStream.mockReturnValue(...)` + `rerender()` simulates a live SSE
 *  phase/stage advance without a remount). The re-render is driven from INSIDE
 *  a wrapper's state: React Router caches the route element, so an outer
 *  `rerender(tree)` would bail out before ever reaching the route component. */
function renderDetail(): { rerender: () => void } {
  let bump: (() => void) | null = null
  function LiveRoute(): React.JSX.Element {
    const [, setVersion] = useState(0)
    bump = () => {
      setVersion((v) => v + 1)
    }
    return <CampaignDetailRoute />
  }
  const router = createMemoryRouter(
    [{ path: '/campaigns/:id', element: <LiveRoute /> }],
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
  return {
    rerender: () => {
      act(() => {
        bump?.()
      })
    },
  }
}

describe('CampaignDetailRoute — phase-aware world-gen routing', () => {
  it('renders the two-act streaming world-gen view while generating', () => {
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_gen',
        nodes: NODES,
        // The two-act flow: the route lands on the generic loading screen (act
        // one); entities already exist in this fixture, so the reveal beat is
        // offered. The act-two graph/status-card details are covered in
        // generating.test.tsx.
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
    expect(screen.getByTestId('worldgen-loading')).toBeDefined()
    // Nodes exist → the "watch your world be born" button is offered (act one
    // holds until the player presses it — a deliberate beat, never automatic).
    expect(screen.getByRole('button', { name: i18n.t('worldGen.watch') })).toBeDefined()
  })

  it('stays on the generating view while entity_relationships is still RUNNING', () => {
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_gen',
        nodes: NODES,
        stages: [
          st('world_and_factions', 'completed'),
          st('locations_and_npcs', 'completed'),
          st('entity_relationships', 'running'),
        ],
      }),
    )
    renderDetail()
    // The connections are not woven yet — NO reveal, the wait continues.
    expect(screen.getByTestId('worldgen-generating')).toBeDefined()
    expect(screen.queryByTestId('worldgen-reveal')).toBeNull()
  })

  it('fires the wiki reveal the MOMENT world_introduction completes — mid-generation', async () => {
    // The tail (consolidation → embed) is still running and worlds.status is
    // still 'generating': the reveal shows anyway (MYT-89 reveal timing —
    // embed_world completion is NOT required).
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_snapshot_ready',
        nodes: NODES,
        stages: CONNECTIONS_DONE_STAGES,
      }),
    )
    renderDetail()
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    expect(screen.queryByTestId('worldgen-generating')).toBeNull()
    // Continue is GATED until the pipeline completes (the situation POST needs a
    // complete world) — the explore prompt is the whole call to action for now.
    expect(screen.queryByTestId('reveal-continue')).toBeNull()
  })

  it('keeps the reveal mounted through the world_ready flip — no settling flash, Continue appears', async () => {
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_snapshot_ready',
        nodes: NODES,
        stages: CONNECTIONS_DONE_STAGES,
      }),
    )
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: null, startingLevel: null })
    const { rerender } = renderDetail()
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    // The tail finishes: the stream advances to world_ready. The owner is
    // mid-exploration — the reveal must hold (no settling interposition), and
    // Continue grows in quietly now that the pipeline is complete.
    mockStream.mockReturnValue(
      streamValue({ status: 'complete', phase: 'world_ready', nodes: NODES }),
    )
    rerender()
    expect(screen.getByTestId('worldgen-reveal')).toBeDefined()
    expect(screen.queryByTestId('campaign-settling')).toBeNull()
    expect(screen.getByTestId('reveal-continue')).toBeDefined()
    // Flush the chosen-flag fetch: still the reveal (nothing was picked).
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    expect(screen.queryByTestId('campaign-settling')).toBeNull()
  })

  it('PLAYS the reveal moment on the mid-gen swap — the watcher gets the beat (D6)', async () => {
    // The generating→reveal swap mounts the reveal inside a playing
    // <RevealTransition>: the walk begins at `hold` (the swap breath). The
    // moment belongs to the player who watched — this render IS that swap.
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_snapshot_ready',
        nodes: NODES,
        stages: CONNECTIONS_DONE_STAGES,
      }),
    )
    renderDetail()
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    expect(screen.getByTestId('reveal-moment').getAttribute('data-reveal-phase')).toBe('hold')
  })

  it('does NOT play the moment for the late arriver (first mount on a complete world)', async () => {
    mockStream.mockReturnValue(
      streamValue({ status: 'complete', phase: 'world_ready', nodes: NODES }),
    )
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: null, startingLevel: null })
    renderDetail()
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    // The final state, instantly — no walk for someone who didn't watch.
    expect(screen.getByTestId('reveal-moment').getAttribute('data-reveal-phase')).toBe('done')
  })

  it('collapses the moment under reduced motion: layout final from the first frame', async () => {
    mockMedia('(prefers-reduced-motion: reduce)')
    mockStream.mockReturnValue(
      streamValue({
        status: 'generating',
        phase: 'world_snapshot_ready',
        nodes: NODES,
        stages: CONNECTIONS_DONE_STAGES,
      }),
    )
    renderDetail()
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    // The §3.8 reduced path: no walk — done immediately (the ~300ms surface
    // fade is the only motion, and base.css collapses even that for real OS
    // preferences). Continue stays gated by the tail exactly as before.
    expect(screen.getByTestId('reveal-moment').getAttribute('data-reveal-phase')).toBe('done')
    expect(screen.queryByTestId('reveal-continue')).toBeNull()
  })

  it('renders a Retry that calls retry() on a retryable failure', () => {
    const retry = vi.fn()
    mockStream.mockReturnValue(streamValue({ status: 'failed', phase: 'world_gen_failed', retry }))
    renderDetail()
    fireEvent.click(screen.getByTestId('worldgen-retry'))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('renders the terminal state with NO retry affordance (a genuine world-gen terminal)', () => {
    // The world-gen dead end: a resume-capped failure — override 'terminal' while
    // the phase stays 'world_gen_failed' (NOT the character-context 'failed', which
    // routes past this to the campaign page — see the interception test below).
    mockStream.mockReturnValue(streamValue({ status: 'terminal', phase: 'world_gen_failed' }))
    renderDetail()
    expect(screen.getByTestId('worldgen-terminal')).toBeDefined()
    expect(screen.queryByTestId('worldgen-retry')).toBeNull()
  })

  it('routes a character-creation failure (phase failed) to the campaign page, NOT the world-gen terminal', async () => {
    // MYT-90 D8 interception: a per-player concept failed → derivePhase returns a
    // party-wide 'failed' that the stream collapses to a coarse 'terminal'. That
    // failure happened after the world completed, so it must reach CampaignPage's
    // character surface (a character-context retry), never the world-gen terminal.
    mockStream.mockReturnValue(streamValue({ status: 'terminal', phase: 'failed' }))
    mockCampaigns.mockResolvedValue({ campaigns: [CAMPAIGN] })
    // Situation + level already set (the concept failed AFTER setup), so the surface
    // routes on the concept, not the owner setup redirects.
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: 0, startingLevel: 1 })
    mockProgress.mockResolvedValue({
      campaignId: 'c1',
      totalMembers: 1,
      concepts: [
        {
          userId: 'u1',
          displayName: 'You',
          status: 'failed',
          submittedAt: '2026-01-01T00:00:00.000Z',
          confirmedAt: null,
          characterId: null,
        },
      ],
      missing: [],
    })
    renderDetail()
    // The campaign page mounts (its outer testid) — NOT the world-gen terminal.
    expect(await screen.findByTestId('route-campaign-detail')).toBeDefined()
    expect(screen.queryByTestId('worldgen-terminal')).toBeNull()
    expect(screen.queryByTestId('worldgen-failed')).toBeNull()
    // The surface routes the failed concept to the character-context failure+retry.
    expect(await screen.findByTestId('character-failure')).toBeDefined()
  })

  it('renders the Phase D world reveal at world_ready before a situation is chosen', async () => {
    mockStream.mockReturnValue(
      streamValue({ status: 'complete', phase: 'world_ready', nodes: NODES }),
    )
    // No situation chosen yet → the one-time reveal.
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: null, startingLevel: null })
    renderDetail()
    // The reveal mounts after the settling gate resolves; findBy flushes that.
    expect(await screen.findByTestId('worldgen-reveal')).toBeDefined()
    // The settled world's CONTENT reached the reveal: the graph pane renders
    // only once the folded nodes arrive (the first-fold gate — reveal.tsx holds
    // it null at nodes=[]), so its presence proves the stream's entities landed.
    // (The entity list this used to read names from was removed in audit v3;
    // the Canvas carries the names now, unobservable under jsdom.)
    expect(screen.getByTestId('reveal-graph')).toBeDefined()
    // The pipeline is complete → Continue is offered (the settled-world default).
    expect(screen.getByTestId('reveal-continue')).toBeDefined()
  })

  it('shows the settling line (NOT the reveal) on a fresh world_ready load', () => {
    // A fresh mount at world_ready (no mid-gen reveal was ever shown): the
    // chosen-flag resolve window keeps today's settling gate, so an owner who
    // already picked never sees a reveal flash.
    mockStream.mockReturnValue(streamValue({ status: 'complete', phase: 'world_ready' }))
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: 1, startingLevel: null })
    renderDetail()
    expect(screen.getByTestId('campaign-settling')).toBeDefined()
    expect(screen.queryByTestId('worldgen-reveal')).toBeNull()
  })

  it('renders the campaign page at world_ready once a situation is chosen', async () => {
    mockStream.mockReturnValue(
      streamValue({ status: 'complete', phase: 'world_ready', nodes: NODES }),
    )
    // A chosen situation → the reveal is done; the campaign page (D5) lands.
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: 1, startingLevel: 1 })
    mockCampaigns.mockResolvedValue({ campaigns: [CAMPAIGN] })
    // An integrated concept lands the surface on the (non-navigating) play entry.
    mockProgress.mockResolvedValue(soloProgress('integrated'))
    renderDetail()
    // The campaign page: world identity + both MYT-89 boundary seams. The world
    // name renders only after the async campaigns fetch resolves, so await it
    // (findBy) before the synchronous sibling assertions — a bare getByTestId here
    // races the fetch and flakes under full-suite load.
    expect(await screen.findByTestId('route-campaign-detail')).toBeDefined()
    expect((await screen.findByTestId('campaign-world-name')).textContent).toBe('Emberdeep Hollow')
    expect(screen.getByTestId('seam-invite')).toBeDefined()
    // The character region is now the real surface (the integrated-concept default
    // lands it on the play entry); the old character stub seam is gone.
    expect(await screen.findByTestId('character-play')).toBeDefined()
    expect(screen.queryByTestId('seam-character')).toBeNull()
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
    mockCampaigns.mockResolvedValue({ campaigns: [{ ...CAMPAIGN, status: 'active' }] })
    // Reset the situations mock (a prior test leaves it rejecting; clearAllMocks
    // keeps implementations) so the surface's parallel fetch resolves → play entry.
    mockSituations.mockResolvedValue({ situations: [], chosenIndex: 0, startingLevel: 1 })
    mockProgress.mockResolvedValue(soloProgress('integrated'))
    renderDetail()
    // A later phase already has a situation → straight to the campaign page (D5).
    expect(await screen.findByTestId('route-campaign-detail')).toBeDefined()
    expect(screen.getByTestId('seam-invite')).toBeDefined()
    // The character surface (integrated concept → play entry) supersedes the stub seam.
    expect(await screen.findByTestId('character-play')).toBeDefined()
    expect(screen.queryByTestId('seam-character')).toBeNull()
  })
})
