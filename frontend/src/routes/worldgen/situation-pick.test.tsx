import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  HttpError,
  type ApiContext,
  type CampaignSummary,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { SituationPickRoute } from './situation-pick.tsx'

// The STARTING-SITUATION PICK (MYT-90 character-creation, D1) — the first
// character-creation beat after the world reveal. It is OWNER-ONLY: the owner
// (`CampaignSummary.creator === null` — the viewer made the world) picks one of
// three opening hooks; a member (a non-null creator, i.e. a joined world) sees a
// calm "waiting for the owner" hold instead of the picker. Selecting a hook POSTs
// its index and hands off to the LEVEL-PICK beat (`/campaigns/:id/level`, built by
// D2). These tests inject the fetch + choose + campaign-role seams (defaults are
// the real endpoints), render AT the situation URL under a memory router whose
// `/campaigns/:id/level` route is a probe element (`createMemoryRouter` with route
// OBJECTS — paths are object properties, not JSX attrs — so the i18next literal-
// string rail stays clean), and assert: the owner sees all three hooks, a member
// sees the hold and NOT the picker, selecting hook N posts index N and navigates
// to the level-pick beat, a 409 `situation_locked` still hands off to level-pick,
// and a failed role probe fails CLOSED to the hold (never the owner-only picker).

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; the platform builtin can shadow jsdom's real Storage.
// Install a functional in-memory one (mirrors reveal.test.tsx).
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

const SITUATIONS: StartingSituationsResponse = {
  situations: [
    {
      index: 0,
      title: 'The harbour at low tide',
      locationName: 'Ashfen Reach',
      prose: 'A skiff has come in wrong.',
      invitation: 'What draws you to the water?',
    },
    {
      index: 1,
      title: 'A debt come due',
      locationName: 'The Salt Ledger',
      prose: 'The counting-house wants paying.',
      invitation: 'Whose debt is it?',
    },
    {
      index: 2,
      title: 'Smoke over the moor',
      locationName: 'Greywater Fen',
      prose: 'The beacon is burning out of season.',
      invitation: 'Why are you on the moor?',
    },
  ],
  chosenIndex: null,
  startingLevel: null,
}

interface Overrides {
  fetchSituations?: () => Promise<StartingSituationsResponse>
  chooseSituation?: (ctx: ApiContext, campaignId: string, index: number) => Promise<unknown>
  fetchCampaigns?: (ctx: ApiContext) => Promise<readonly CampaignSummary[]>
}

function renderPick(overrides: Overrides = {}): {
  chooseSituation: (ctx: ApiContext, campaignId: string, index: number) => Promise<unknown>
} {
  const fetchSituations = overrides.fetchSituations ?? vi.fn().mockResolvedValue(SITUATIONS)
  const chooseSituation = overrides.chooseSituation ?? vi.fn().mockResolvedValue({ index: 0 })
  // Owner by default (creator: null) — the picker path; the member/fail-closed
  // cases override with a non-null creator / a rejection.
  const fetchCampaigns =
    overrides.fetchCampaigns ?? vi.fn().mockResolvedValue([makeCampaign()])
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/situation',
        element: (
          <SituationPickRoute
            fetchSituations={fetchSituations}
            chooseSituation={chooseSituation}
            fetchCampaigns={fetchCampaigns}
          />
        ),
      },
      // The LEVEL-PICK landing (D2) — a bare probe: its presence proves the
      // post-pick navigation resolved to `/campaigns/:id/level`.
      { path: '/campaigns/:id/level', element: <div data-testid="level-pick" /> },
    ],
    { initialEntries: [`/campaigns/${CAMPAIGN_ID}/situation`] },
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
  return { chooseSituation }
}

describe('SituationPickRoute — the owner-only picker', () => {
  it('renders all three hooks with their title, locationName, AND prose for the owner', async () => {
    renderPick()
    const hooks = await screen.findByTestId('situation-hooks')
    expect(hooks).toBeDefined()
    // title
    expect(screen.getByText('A debt come due')).toBeDefined()
    // locationName
    expect(screen.getByText('The Salt Ledger')).toBeDefined()
    // prose
    expect(screen.getByText('The counting-house wants paying.')).toBeDefined()
    // three selectable hooks
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('shows a calm loading placeholder before the situations resolve', () => {
    const pending = new Promise<StartingSituationsResponse>(() => {
      /* never resolves */
    })
    renderPick({ fetchSituations: vi.fn(() => pending) })
    expect(screen.getByText(i18n.t('startingSituation.loading'))).toBeDefined()
    expect(screen.queryByTestId('situation-hooks')).toBeNull()
  })
})

describe('SituationPickRoute — the member hold (owner gate)', () => {
  it('shows the waiting hold to a member and NOT the owner picker', async () => {
    renderPick({ fetchCampaigns: vi.fn().mockResolvedValue([makeCampaign({ creator: 'Bram' })]) })
    await screen.findByTestId('situation-pick-hold')
    expect(screen.queryByTestId('situation-hooks')).toBeNull()
    expect(screen.queryByTestId('situation-pick')).toBeNull()
  })

  it('fails CLOSED to the hold when the role probe fails (never leaks the picker)', async () => {
    renderPick({ fetchCampaigns: vi.fn().mockRejectedValue(new Error('boom')) })
    await screen.findByTestId('situation-pick-hold')
    expect(screen.queryByTestId('situation-hooks')).toBeNull()
  })
})

describe('SituationPickRoute — selecting a hook hands off to level-pick', () => {
  it('posts the chosen index and navigates to the level-pick beat on success', async () => {
    const chooseSituation = vi.fn().mockResolvedValue({ index: 1 })
    renderPick({ chooseSituation })
    await screen.findByTestId('situation-hooks')

    fireEvent.click(screen.getByRole('button', { name: /A debt come due/ }))

    // Handed off to the level-pick beat…
    await screen.findByTestId('level-pick')
    // …having posted index 1 for this campaign (the wire body is `{ index: 1 }`).
    expect(chooseSituation).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 1)
  })

  it('still hands off to level-pick on a 409 situation_locked', async () => {
    const chooseSituation = vi
      .fn()
      .mockRejectedValue(new HttpError(409, 'Conflict', 'situation_locked'))
    renderPick({ chooseSituation })
    await screen.findByTestId('situation-hooks')

    fireEvent.click(screen.getByRole('button', { name: /The harbour at low tide/ }))

    // The pick is already locked in — proceed to the level-pick beat idempotently.
    await screen.findByTestId('level-pick')
    expect(chooseSituation).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 0)
  })

  it('keeps the picker up on a non-409 pick failure (a retryable note)', async () => {
    const chooseSituation = vi.fn().mockRejectedValue(new HttpError(500, 'Server error'))
    renderPick({ chooseSituation })
    await screen.findByTestId('situation-hooks')

    fireEvent.click(screen.getByRole('button', { name: /Smoke over the moor/ }))

    // A calm retryable note surfaces and the hooks stay for a re-pick — we did NOT
    // navigate onward.
    await screen.findByText(i18n.t('startingSituation.error'))
    expect(screen.getByTestId('situation-hooks')).toBeDefined()
    expect(screen.queryByTestId('level-pick')).toBeNull()
  })
})
