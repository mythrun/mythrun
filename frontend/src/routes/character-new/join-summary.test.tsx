import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { JoinSummaryRoute } from './join-summary.tsx'

// The MEMBER-JOIN WORLD-INTRO SUMMARY (MYT-90 D9) — the brief entry surface a
// member reaches after accepting an invite (MYT-91 owns invite→here). It is a
// briefer variant of the owner's world reveal: it FETCHES the world snapshot and
// shows just the world's NAME (the introduction title) + a short intro paragraph,
// then a primary CTA that hands off to character creation
// (`/campaigns/:id/character/new` — the owner already set situation + level, so the
// member skips those beats).
//
// These tests inject the snapshot fetch seam (default is the real endpoint), render
// AT the join URL under a memory router whose `/campaigns/:id/character/new` route
// is a bare probe element (`createMemoryRouter` with route OBJECTS — paths are
// object properties, not JSX attrs — so the i18next literal-string rail stays
// clean), and assert: the world name + intro render, the CTA navigates to the
// create beat, and the load lifecycle holds (a calm loading line, then a calm
// retryable notice on a failed fetch — the snapshot endpoint is member-readable
// since myth-0xwos, so the notice is the transient-failure/non-member arm, not
// the normal member experience).

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; the platform builtin can shadow jsdom's real Storage.
// Install a functional in-memory one (mirrors level-pick.test.tsx).
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

type FetchSnapshot = (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>

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

/** A valid client-parsed world snapshot carrying the intro (title = the world's
 *  name, prose = the elevator pitch); the other collections are inert empties —
 *  the join summary reads only the introduction. */
function makeSnapshot(overrides: Partial<WorldGenSnapshot> = {}): WorldGenSnapshot {
  return {
    introduction: {
      title: 'Emberdeep Hollow',
      prose: 'A drowned mining town where the lamps never went out.',
      references: [],
    },
    entities: [],
    facts: [],
    entityHierarchy: [],
    relationships: [],
    ...overrides,
  }
}

function renderJoin(overrides: { fetchSnapshot?: FetchSnapshot } = {}): {
  fetchSnapshot: FetchSnapshot
} {
  const fetchSnapshot = overrides.fetchSnapshot ?? vi.fn().mockResolvedValue(makeSnapshot())
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/join',
        element: <JoinSummaryRoute fetchSnapshot={fetchSnapshot} />,
      },
      // The CREATE landing (D3) — a bare probe: its presence proves the CTA
      // navigation resolved to `/campaigns/:id/character/new`.
      { path: '/campaigns/:id/character/new', element: <div data-testid="character-new" /> },
    ],
    { initialEntries: [`/campaigns/${CAMPAIGN_ID}/join`] },
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
  return { fetchSnapshot }
}

describe('JoinSummaryRoute — the world intro', () => {
  it('renders the world name and the introduction prose', async () => {
    renderJoin()
    await screen.findByTestId('join-summary')
    expect(screen.getByTestId('join-summary-world-name')).toBeDefined()
    expect(screen.getByText('Emberdeep Hollow')).toBeDefined()
    expect(screen.getByText(/drowned mining town/i)).toBeDefined()
  })

  it('fetches the snapshot for the campaign in the URL', async () => {
    const { fetchSnapshot } = renderJoin()
    await screen.findByTestId('join-summary')
    expect(fetchSnapshot).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID)
  })
})

describe('JoinSummaryRoute — the create handoff', () => {
  it('navigates to the create beat when the CTA is pressed', async () => {
    renderJoin()
    fireEvent.click(await screen.findByTestId('join-summary-create'))
    // The probe at `/campaigns/:id/character/new` renders — the CTA navigated there.
    await screen.findByTestId('character-new')
  })
})

describe('JoinSummaryRoute — the load lifecycle', () => {
  it('holds on a calm loading line while the fetch is in flight', () => {
    const pending = new Promise<WorldGenSnapshot>(() => {
      /* never resolves */
    })
    renderJoin({ fetchSnapshot: vi.fn(() => pending) })
    expect(screen.getByTestId('join-summary-loading')).toBeDefined()
    expect(screen.queryByTestId('join-summary')).toBeNull()
  })

  it('fails CLOSED to a calm retryable notice when the fetch rejects', async () => {
    // A transient failure and a true denial (non-member) look the same from
    // here — both land on the calm notice. (Members read the snapshot since
    // myth-0xwos; this is the failure arm, not the member default.)
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error('boom'))
    renderJoin({ fetchSnapshot })
    await screen.findByTestId('join-summary-error')
    expect(screen.queryByTestId('join-summary')).toBeNull()
  })

  it('treats a snapshot with no introduction as the same calm notice', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValue(makeSnapshot({ introduction: undefined }))
    renderJoin({ fetchSnapshot })
    await screen.findByTestId('join-summary-error')
  })

  it('re-fetches the snapshot on retry', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeSnapshot())
    renderJoin({ fetchSnapshot })
    await screen.findByTestId('join-summary-error')
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await screen.findByTestId('join-summary')
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })
})
