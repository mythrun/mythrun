import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  HttpError,
  type ApiContext,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { SituationPickRoute } from './situation-pick.tsx'

// The STARTING-SITUATION PICK (MYT-89 Phase D, D4) — the three opening hooks as
// borderless ghost items; selecting one POSTs its index and lands on the campaign
// page (`/campaigns/:id`). These tests inject the fetch + choose seams (defaults
// are the real endpoints), render AT the situation URL under a memory router whose
// `/campaigns/:id` route is a probe element (`createMemoryRouter` with route
// OBJECTS — paths are object properties, not JSX attrs — so the i18next literal-
// string rail stays clean), and assert: all three hooks render (title +
// locationName + prose visible), selecting hook N posts index N and navigates to
// the campaign page, and a 409 `situation_locked` still navigates.

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

const SITUATIONS: StartingSituationsResponse = {
  situations: [
    { index: 0, title: 'The harbour at low tide', locationName: 'Ashfen Reach', prose: 'A skiff has come in wrong.' },
    { index: 1, title: 'A debt come due', locationName: 'The Salt Ledger', prose: 'The counting-house wants paying.' },
    { index: 2, title: 'Smoke over the moor', locationName: 'Greywater Fen', prose: 'The beacon is burning out of season.' },
  ],
  chosenIndex: null,
}

interface Overrides {
  fetchSituations?: () => Promise<StartingSituationsResponse>
  chooseSituation?: (ctx: ApiContext, campaignId: string, index: number) => Promise<unknown>
}

function renderPick(overrides: Overrides = {}): {
  chooseSituation: (ctx: ApiContext, campaignId: string, index: number) => Promise<unknown>
} {
  const fetchSituations = overrides.fetchSituations ?? vi.fn().mockResolvedValue(SITUATIONS)
  const chooseSituation = overrides.chooseSituation ?? vi.fn().mockResolvedValue({ index: 0 })
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/situation',
        element: (
          <SituationPickRoute fetchSituations={fetchSituations} chooseSituation={chooseSituation} />
        ),
      },
      // The campaign-page landing (D5) — a bare probe: its presence proves the
      // post-pick navigation resolved to `/campaigns/:id`.
      { path: '/campaigns/:id', element: <div data-testid="campaign-page" /> },
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

describe('SituationPickRoute — the three opening hooks', () => {
  it('renders all three hooks with their title, locationName, AND prose', async () => {
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
    expect(screen.getByText('[ph: finding your openings]')).toBeDefined()
    expect(screen.queryByTestId('situation-hooks')).toBeNull()
  })
})

describe('SituationPickRoute — selecting a hook', () => {
  it('posts the chosen index and navigates to the campaign page on success', async () => {
    const chooseSituation = vi.fn().mockResolvedValue({ index: 1 })
    renderPick({ chooseSituation })
    await screen.findByTestId('situation-hooks')

    fireEvent.click(screen.getByRole('button', { name: /A debt come due/ }))

    // Landed on the campaign page…
    await screen.findByTestId('campaign-page')
    // …having posted index 1 for this campaign (the wire body is `{ index: 1 }`).
    expect(chooseSituation).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 1)
  })

  it('still navigates to the campaign page on a 409 situation_locked', async () => {
    const chooseSituation = vi
      .fn()
      .mockRejectedValue(new HttpError(409, 'Conflict', 'situation_locked'))
    renderPick({ chooseSituation })
    await screen.findByTestId('situation-hooks')

    fireEvent.click(screen.getByRole('button', { name: /The harbour at low tide/ }))

    // The pick is already locked in — proceed to the campaign page idempotently.
    await screen.findByTestId('campaign-page')
    expect(chooseSituation).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, 0)
  })
})
