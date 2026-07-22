import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  HttpError,
  type ApiContext,
  type CampaignSummary,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { LevelPickRoute } from './level-pick.tsx'

// The STARTING-LEVEL PICK (MYT-90 character-creation, D2) — the party-wide beat
// between the situation pick and character creation. It is OWNER-ONLY: the owner
// (`CampaignSummary.creator === null` — the viewer made the world) picks the
// party's shared starting level (1–5); a member (a non-null creator, i.e. a
// joined world) — or an unresolved / failed role probe — sees a calm "waiting for
// the owner" hold instead of the picker (fail-CLOSED, so the owner-only picker
// never flashes for a non-owner). Selecting a level and confirming POSTs it via
// `setStartingLevel` and hands off to the CREATE beat
// (`/campaigns/:id/character/new`). These tests inject the set + campaign-role
// seams (defaults are the real endpoints), render AT the level URL under a memory
// router whose `/campaigns/:id/character/new` route is a bare probe element
// (`createMemoryRouter` with route OBJECTS — paths are object properties, not JSX
// attrs — so the i18next literal-string rail stays clean), and assert: the owner
// sees the five level cards, a member sees the hold and NOT the picker, selecting
// level N and confirming posts N and navigates to the create beat, a 409
// `level_locked` still hands off idempotently, a non-409 failure keeps the picker
// up with a retryable note, and a failed role probe fails CLOSED to the hold.

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; the platform builtin can shadow jsdom's real Storage.
// Install a functional in-memory one (mirrors situation-pick.test.tsx).
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
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** A hub campaign summary for the route's role probe. `creator: null` ⟹ the viewer
 *  OWNS the world (sees the picker); a non-null creator ⟹ a member (sees the hold). */
function makeCampaign(overrides: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: CAMPAIGN_ID,
    worldId: 'w1',
    name: 'The Ashfen Pact',
    status: 'setup',
    language: 'en',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    worldName: 'Emberdeep Hollow',
    worldColors: null,
    creator: null,
    party: [],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'needs-character',
    ...overrides,
  }
}

interface Overrides {
  setStartingLevel?: (ctx: ApiContext, campaignId: string, level: number) => Promise<void>
  fetchCampaigns?: (ctx: ApiContext) => Promise<readonly CampaignSummary[]>
  fetchStartingLevel?: (ctx: ApiContext, campaignId: string) => Promise<number | null>
}

function renderPick(overrides: Overrides = {}): {
  setStartingLevel: (ctx: ApiContext, campaignId: string, level: number) => Promise<void>
} {
  const setLevel = overrides.setStartingLevel ?? vi.fn().mockResolvedValue(undefined)
  // Owner by default (creator: null) — the picker path; the member/fail-closed
  // cases override with a non-null creator / a rejection / a pending probe.
  const fetchCampaigns =
    overrides.fetchCampaigns ?? vi.fn().mockResolvedValue([makeCampaign()])
  // Default the persisted-level probe to null so existing cases keep the
  // DEFAULT_LEVEL pre-selection (and never hit the real endpoint).
  const fetchStartingLevel =
    overrides.fetchStartingLevel ?? vi.fn().mockResolvedValue(null)
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/level',
        element: (
          <LevelPickRoute
            setStartingLevel={setLevel}
            fetchCampaigns={fetchCampaigns}
            fetchStartingLevel={fetchStartingLevel}
          />
        ),
      },
      // The CREATE landing (D3) — a bare probe: its presence proves the post-confirm
      // navigation resolved to `/campaigns/:id/character/new`.
      { path: '/campaigns/:id/character/new', element: <div data-testid="character-new" /> },
    ],
    { initialEntries: [`/campaigns/${CAMPAIGN_ID}/level`] },
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
  return { setStartingLevel: setLevel }
}

describe('LevelPickRoute — the owner-only picker', () => {
  it('renders five level cards (1–5) with their grant glosses for the owner', async () => {
    renderPick()
    const cards = await screen.findAllByTestId('level-card')
    expect(cards).toHaveLength(5)
    expect(cards.map((c) => c.getAttribute('data-level'))).toEqual(['1', '2', '3', '4', '5'])
    // Each card carries its grant gloss.
    expect(screen.getByText(i18n.t('startingLevel.grant1'))).toBeDefined()
    expect(screen.getByText(i18n.t('startingLevel.grant5'))).toBeDefined()
    // The owner sees the picker, never the member hold.
    expect(screen.queryByTestId('level-pick-hold')).toBeNull()
  })

  it('holds on a neutral loading line while the role probe is in flight', () => {
    const pending = new Promise<readonly CampaignSummary[]>(() => {
      /* never resolves */
    })
    renderPick({ fetchCampaigns: vi.fn(() => pending) })
    expect(screen.getByTestId('level-pick-loading')).toBeDefined()
    expect(screen.queryAllByTestId('level-card')).toHaveLength(0)
  })
})

describe('LevelPickRoute — the member hold (owner gate)', () => {
  it('shows the waiting hold to a member and NOT the owner picker', async () => {
    renderPick({ fetchCampaigns: vi.fn().mockResolvedValue([makeCampaign({ creator: 'Bram' })]) })
    await screen.findByTestId('level-pick-hold')
    expect(screen.queryByTestId('level-pick')).toBeNull()
    expect(screen.queryAllByTestId('level-card')).toHaveLength(0)
  })

  it('fails CLOSED to the hold when the role probe fails (never leaks the picker)', async () => {
    renderPick({ fetchCampaigns: vi.fn().mockRejectedValue(new Error('boom')) })
    await screen.findByTestId('level-pick-hold')
    expect(screen.queryAllByTestId('level-card')).toHaveLength(0)
  })
})

describe('LevelPickRoute — selecting a level hands off to character creation', () => {
  it('posts the chosen level and navigates to the create beat on success', async () => {
    const setLevel = vi.fn().mockResolvedValue(undefined)
    renderPick({ setStartingLevel: setLevel })
    const cards = await screen.findAllByTestId('level-card')

    // Pick level 5 (not the default) then confirm — select by the durable
    // data-level attribute, not the grant-gloss copy.
    const level5 = cards.find((c) => c.getAttribute('data-level') === '5')
    if (level5 === undefined) throw new Error('no level-5 card')
    fireEvent.click(level5)
    fireEvent.click(screen.getByTestId('level-pick-confirm'))

    // Handed off to the create beat, having posted level 5 for this campaign.
    await screen.findByTestId('character-new')
    expect(setLevel).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 5)
  })

  it('pre-selects the PERSISTED level so a re-confirm cannot silently downgrade it (MYT-102 QA M1)', async () => {
    const { setStartingLevel: setLevel } = renderPick({
      fetchStartingLevel: vi.fn().mockResolvedValue(5),
    })
    // Wait for the picker + the persisted-level seed to resolve.
    await screen.findByTestId('level-pick-confirm')
    await waitFor(() => {
      expect(screen.getByTestId('level-pick-confirm').textContent).toContain('5')
    })
    // Confirming WITHOUT touching a card re-affirms 5 — never the default 3.
    fireEvent.click(screen.getByTestId('level-pick-confirm'))
    await waitFor(() => {
      expect(setLevel).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 5)
    })
  })

  it('confirms the default level when the owner does not change the pick', async () => {
    const setLevel = vi.fn().mockResolvedValue(undefined)
    renderPick({ setStartingLevel: setLevel })
    await screen.findAllByTestId('level-card')

    // No card clicked — the default pick (level 3, the mockup's pre-selection).
    fireEvent.click(screen.getByTestId('level-pick-confirm'))

    await screen.findByTestId('character-new')
    expect(setLevel).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 3)
  })

  it('still hands off to the create beat on a 409 level_locked', async () => {
    const setLevel = vi.fn().mockRejectedValue(new HttpError(409, 'Conflict', 'level_locked'))
    renderPick({ setStartingLevel: setLevel })
    await screen.findAllByTestId('level-card')

    fireEvent.click(screen.getByTestId('level-pick-confirm'))

    // The level is already locked in — proceed to the create beat idempotently.
    await screen.findByTestId('character-new')
    expect(setLevel).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 3)
  })

  it('keeps the picker up on a non-409 failure (a retryable note)', async () => {
    const setLevel = vi.fn().mockRejectedValue(new HttpError(500, 'Server error'))
    renderPick({ setStartingLevel: setLevel })
    await screen.findAllByTestId('level-card')

    fireEvent.click(screen.getByTestId('level-pick-confirm'))

    // A calm retryable note surfaces and the picker stays for a re-confirm — we did
    // NOT navigate onward.
    await screen.findByText(i18n.t('startingLevel.error'))
    expect(screen.getByTestId('level-pick')).toBeDefined()
    expect(screen.queryByTestId('character-new')).toBeNull()
  })
})
