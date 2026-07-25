import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  createSseStatusClient,
  type ApiContext,
  type CampaignSummary,
  type CharacterCreationProgress,
  type CharacterFull,
  type SseStatusClient,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CharacterSurface, type CharacterSurfaceDeps } from './character-surface.tsx'

// MYT-90 D8 — the character surface: the §3.3 routing table + the character-context
// failure. The surface reads THREE signals (campaign status/role via the `campaign`
// prop, owner situation/level via getStartingSituations, the viewer's own concept
// via getMe + getCharacterCreationProgress) and mounts the right beat. Everything is
// driven through the injected `deps` seams — no live SSE/endpoint.

const VIEWER = 'viewer-1'
const CID = 'c1'

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads localStorage.
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
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const CAMPAIGN: CampaignSummary = {
  id: 'c1',
  worldId: 'w1',
  name: 'The Ashfen Pact',
  status: 'setup',
  language: 'en',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  worldName: 'Emberdeep Hollow',
  worldColors: null,
  creator: null, // owner
  party: [],
  sessionCount: 0,
  lastPlayedAt: null,
  cardPhase: 'needs-character',
}

const meOk = (): Promise<{ user: { id: string } }> => Promise.resolve({ user: { id: VIEWER } })

function situations(
  chosenIndex: number | null,
  startingLevel: number | null,
): StartingSituationsResponse {
  return { situations: [], chosenIndex, startingLevel }
}

type Concept = CharacterCreationProgress['concepts'][number]

function myConcept(over: Partial<Concept> = {}): Concept {
  return {
    userId: VIEWER,
    displayName: 'You',
    status: 'processing',
    submittedAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: null,
    characterId: null,
    ...over,
  }
}

function progress(concepts: readonly Concept[]): CharacterCreationProgress {
  return { campaignId: 'c1', totalMembers: concepts.length, concepts: [...concepts], missing: [] }
}

const pending = <T,>(): Promise<T> => new Promise<T>(() => undefined)

// A never-opened SSE client + a never-resolving progress fetch, so the mounted
// loading beat's stream AND its durable poll (myth-qkjdq) both hang harmlessly —
// no real network, no live backoff timer scheduled (the first poll never settles).
const stubLoadingDeps = {
  createClient: (ctx: ApiContext): SseStatusClient => {
    const { connectionState } = createSseStatusClient(ctx)
    return {
      open: () => undefined,
      onEvent: () => () => undefined,
      onSnapshot: () => () => undefined,
      connectionState,
      close: () => undefined,
    }
  },
  fetchProgress: (): Promise<CharacterCreationProgress> => pending(),
}

// A finished martial sheet — enough for the reveal to render its "Begin again" action.
const SHEET: CharacterFull = {
  character: {
    id: 'char-1',
    user_id: VIEWER,
    entity_id: null,
    name: 'Kessa Vurm',
    level: 3,
    class: 'Fighter',
    species: 'Human',
    background: 'Toll-clerk',
    str: 16,
    dex: 13,
    con: 15,
    int: 12,
    wis: 11,
    cha: 9,
    hit_points: 28,
    max_hit_points: 28,
    armor_class: 16,
    proficiency_bonus: 2,
    gold: 9,
    hit_die: 10,
    hit_dice_remaining: 3,
    spellcasting_progression: 'none',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  skills: [{ skill_name: 'Athletics', proficiency_level: 'proficient' }],
  features: [{ feature_name: 'Second Wind', feature_source: 'Fighter', description: 'Recover HP.' }],
  equipment: [{ item_name: 'Longsword', quantity: 1, equipped: true }],
  spells: [],
}

/** Base deps: identity + situations + progress resolvers, plus non-networking child
 *  seams so the loading/reveal/staging beats mount without a live connection. */
function baseDeps(over: Partial<CharacterSurfaceDeps> = {}): CharacterSurfaceDeps {
  return {
    fetchMe: meOk,
    fetchSituations: () => Promise.resolve(situations(0, 1)),
    fetchProgress: () => Promise.resolve(progress([myConcept()])),
    loading: stubLoadingDeps,
    reveal: { getCharacter: () => pending() },
    staging: {
      getProgress: () => pending(),
      getCampaigns: () => pending(),
      createClient: stubLoadingDeps.createClient,
    },
    ...over,
  }
}

function renderSurface(
  campaign: CampaignSummary | null,
  deps?: CharacterSurfaceDeps,
): { unmount: () => void } {
  const surface =
    deps === undefined ? (
      <CharacterSurface campaign={campaign} campaignId={CID} />
    ) : (
      <CharacterSurface campaign={campaign} campaignId={CID} deps={deps} />
    )
  const router = createMemoryRouter(
    [
      { path: '/campaigns/:id', element: surface },
      { path: '/campaigns/:id/situation', element: <div data-testid="route-situation" /> },
      { path: '/campaigns/:id/level', element: <div data-testid="route-level" /> },
      { path: '/campaigns/:id/character/new', element: <div data-testid="route-create" /> },
      { path: '/campaigns/:id/play', element: <div data-testid="route-play" /> },
    ],
    { initialEntries: ['/campaigns/c1'] },
  )
  const { unmount } = render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
  return { unmount }
}

// ---------------------------------------------------------------------------
// The mounted surface. (The pure §3.3 routing decision is covered exhaustively
// in character-route.test.ts.)
// ---------------------------------------------------------------------------

describe('CharacterSurface — mounted routing', () => {
  it('campaign null (identity still loading) → the calm surface-loading line', () => {
    renderSurface(null, baseDeps())
    expect(screen.getByTestId('character-surface-loading')).toBeDefined()
  })

  it('mounts with no injected deps at all (deps defaults to {})', () => {
    // Exercises the `deps ?? {}` default; campaign null short-circuits to the calm
    // loading line before the (real, un-injected) reads matter.
    renderSurface(null)
    expect(screen.getByTestId('character-surface-loading')).toBeDefined()
  })

  it('drops a late signal resolve after unmount (the cleanup guard)', async () => {
    let resolveMe: (v: { user: { id: string } }) => void = () => undefined
    const gated = new Promise<{ user: { id: string } }>((r) => {
      resolveMe = r
    })
    const { unmount } = renderSurface(CAMPAIGN, baseDeps({ fetchMe: () => gated }))
    unmount()
    // Resolving after unmount hits the `!active` guard — no setState-after-unmount.
    resolveMe({ user: { id: VIEWER } })
    await gated
  })

  it('owner, situation not chosen → redirects to the situation pick', async () => {
    renderSurface(CAMPAIGN, baseDeps({ fetchSituations: () => Promise.resolve(situations(null, null)) }))
    expect(await screen.findByTestId('route-situation')).toBeDefined()
  })

  it('member, situation not chosen → the "setting up the table" hold', async () => {
    renderSurface(
      { ...CAMPAIGN, creator: 'Host' },
      baseDeps({ fetchSituations: () => Promise.resolve(situations(null, null)) }),
    )
    expect(await screen.findByTestId('character-hold')).toBeDefined()
  })

  it('routes with the DEFAULT child seams (no injected loading/reveal/staging deps)', async () => {
    // A hold routes without mounting a child, so the un-injected child-seam
    // defaults are exercised (the conditional-spread else arms) without a live SSE.
    renderSurface(
      { ...CAMPAIGN, creator: 'Host' },
      {
        fetchMe: meOk,
        fetchSituations: () => Promise.resolve(situations(null, null)),
        fetchProgress: () => Promise.resolve(progress([])),
      },
    )
    expect(await screen.findByTestId('character-hold')).toBeDefined()
  })

  it('falls back to the default getMe when fetchMe is not injected (real read rejects → error)', async () => {
    // Omitting fetchMe exercises defaultFetchMe; with no server the real getMe
    // rejects, so the surface settles on its calm error.
    renderSurface(CAMPAIGN, {
      fetchSituations: () => Promise.resolve(situations(0, 1)),
      fetchProgress: () => Promise.resolve(progress([])),
    })
    expect(await screen.findByTestId('character-surface-error')).toBeDefined()
  })

  it('owner, situation set but level unset → redirects to the level pick', async () => {
    renderSurface(CAMPAIGN, baseDeps({ fetchSituations: () => Promise.resolve(situations(0, null)) }))
    expect(await screen.findByTestId('route-level')).toBeDefined()
  })

  it('member, level unset → the hold', async () => {
    renderSurface(
      { ...CAMPAIGN, creator: 'Host' },
      baseDeps({ fetchSituations: () => Promise.resolve(situations(0, null)) }),
    )
    expect(await screen.findByTestId('character-hold')).toBeDefined()
  })

  it('both set, no concept row → redirects to create', async () => {
    renderSurface(CAMPAIGN, baseDeps({ fetchProgress: () => Promise.resolve(progress([])) }))
    expect(await screen.findByTestId('route-create')).toBeDefined()
  })

  it('concept processing → the loading beat', async () => {
    renderSurface(CAMPAIGN, baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'processing' })])) }))
    expect(await screen.findByTestId('character-loading')).toBeDefined()
  })

  it('concept completed + unconfirmed + a charId → the reveal', async () => {
    renderSurface(
      CAMPAIGN,
      baseDeps({
        fetchProgress: () =>
          Promise.resolve(progress([myConcept({ status: 'completed', characterId: 'char-1' })])),
      }),
    )
    expect(await screen.findByTestId('character-reveal-loading')).toBeDefined()
  })

  it('completed + unconfirmed but charId still null → holds on the loading beat', async () => {
    renderSurface(
      CAMPAIGN,
      baseDeps({
        fetchProgress: () =>
          Promise.resolve(progress([myConcept({ status: 'completed', characterId: null })])),
      }),
    )
    expect(await screen.findByTestId('character-loading')).toBeDefined()
    expect(screen.queryByTestId('character-reveal-loading')).toBeNull()
  })

  it('completed + confirmed → party staging, on a FRESH mount (confirmed_at durable)', async () => {
    // The reload-stability guarantee: no in-session confirm happened — the durable
    // confirmedAt alone routes to staging, so a refresh in the completed→active
    // window does NOT bounce the player back to the reveal.
    renderSurface(
      CAMPAIGN,
      baseDeps({
        fetchProgress: () =>
          Promise.resolve(
            progress([
              myConcept({ status: 'completed', characterId: 'char-1', confirmedAt: '2026-01-02T00:00:00.000Z' }),
            ]),
          ),
      }),
    )
    expect(await screen.findByTestId('party-staging-loading')).toBeDefined()
    expect(screen.queryByTestId('character-reveal-loading')).toBeNull()
  })

  it('concept integrated → the play entry', async () => {
    renderSurface(CAMPAIGN, baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'integrated' })])) }))
    expect(await screen.findByTestId('character-play')).toBeDefined()
  })

  it('campaign active → the play entry, and Enter leads into play', async () => {
    renderSurface({ ...CAMPAIGN, status: 'active' }, baseDeps())
    expect(await screen.findByTestId('character-play')).toBeDefined()
    fireEvent.click(screen.getByTestId('character-play-enter'))
    expect(await screen.findByTestId('route-play')).toBeDefined()
  })

  it('reveal "Begin again" resets the concept and hands off to create', async () => {
    const resetInReveal = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    renderSurface(
      CAMPAIGN,
      baseDeps({
        fetchProgress: () =>
          Promise.resolve(progress([myConcept({ status: 'completed', characterId: 'char-1' })])),
        reveal: {
          getCharacter: () => Promise.resolve(SHEET),
          confirmCharacter: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          resetCharacterConcept: resetInReveal,
        },
      }),
    )
    // Two-step (ux-run2 myth-fca4y): arm the confirm, then fire the confirm verb.
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('characterCreate.reveal.startOver') }))
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('characterCreate.reveal.startOverConfirm') }),
    )
    expect(await screen.findByTestId('route-create')).toBeDefined()
    expect(resetInReveal).toHaveBeenCalledWith(testCtx, CID)
  })

  it('staging "Begin" finalizes and hands off to play', async () => {
    const staged = progress([
      myConcept({ status: 'completed', characterId: 'char-1', confirmedAt: '2026-01-02T00:00:00.000Z' }),
    ])
    const finalize = vi.fn<() => Promise<unknown>>().mockResolvedValue({ campaignId: CID, jobId: 'j' })
    renderSurface(
      CAMPAIGN,
      baseDeps({
        fetchProgress: () => Promise.resolve(staged),
        staging: {
          getProgress: () => Promise.resolve(staged),
          getCampaigns: () => Promise.resolve([CAMPAIGN]),
          finalize,
          createClient: stubLoadingDeps.createClient,
        },
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /begin/i }))
    expect(await screen.findByTestId('route-play')).toBeDefined()
    expect(finalize).toHaveBeenCalledWith(testCtx, CID)
  })

  it('a transient signal-fetch failure → the calm surface error, whose retry re-reads', async () => {
    const fetchProgress = vi
      .fn<() => Promise<CharacterCreationProgress>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(progress([myConcept({ status: 'processing' })]))
    renderSurface(CAMPAIGN, baseDeps({ fetchProgress }))
    const retry = await screen.findByRole('button', { name: i18n.t('campaign.character.error.retry') })
    fireEvent.click(retry)
    // The re-read resolves this time → the loading beat.
    expect(await screen.findByTestId('character-loading')).toBeDefined()
  })
})

describe('CharacterSurface — the character-context failure (NOT the world-gen terminal)', () => {
  it('a failed concept shows the character retry, never the world-gen terminal', async () => {
    renderSurface(CAMPAIGN, baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'failed' })])) }))
    expect(await screen.findByTestId('character-failure')).toBeDefined()
    expect(screen.queryByTestId('worldgen-terminal')).toBeNull()
    expect(screen.queryByTestId('worldgen-failed')).toBeNull()
  })

  it('the concept-failure retry resets the concept, then hands off to create', async () => {
    const resetConcept = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    renderSurface(
      CAMPAIGN,
      baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'failed' })])), resetConcept }),
    )
    fireEvent.click(await screen.findByTestId('character-failure-retry'))
    expect(await screen.findByTestId('route-create')).toBeDefined()
    expect(resetConcept).toHaveBeenCalledWith(testCtx, 'c1')
  })

  it('a failed concept-failure retry surfaces a calm note (stays on the surface)', async () => {
    const resetConcept = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('nope'))
    renderSurface(
      CAMPAIGN,
      baseDeps({ fetchProgress: () => Promise.resolve(progress([myConcept({ status: 'failed' })])), resetConcept }),
    )
    fireEvent.click(await screen.findByTestId('character-failure-retry'))
    expect(await screen.findByTestId('character-failure-retry-error')).toBeDefined()
  })

  it('campaign failed (terminal integration failure) → the integration failure surface, not the terminal', async () => {
    const finalize = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined)
    renderSurface({ ...CAMPAIGN, status: 'failed' }, baseDeps({ finalize }))
    expect(await screen.findByTestId('character-failure')).toBeDefined()
    expect(screen.queryByTestId('worldgen-terminal')).toBeNull()
    // Its retry re-attempts the fan-in.
    fireEvent.click(screen.getByTestId('character-failure-retry'))
    expect(finalize).toHaveBeenCalledWith(testCtx, 'c1')
  })

  it('a failed integration retry surfaces the calm note', async () => {
    const finalize = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('not_in_setup'))
    renderSurface({ ...CAMPAIGN, status: 'failed' }, baseDeps({ finalize }))
    fireEvent.click(await screen.findByTestId('character-failure-retry'))
    expect(await screen.findByTestId('character-failure-retry-error')).toBeDefined()
  })
})
