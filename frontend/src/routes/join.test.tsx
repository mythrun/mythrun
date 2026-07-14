import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  HttpError,
  useSessionStore,
  type ApiContext,
  type InvitePreview,
  type AcceptResult,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { JoinRoute } from './join.tsx'

// The PUBLIC invite landing route `/join/:code` (MYT-91 T7). It resolves pre-auth:
// on mount it previews the invite (campaign name + who invited you), then composes
// the @mythrun/ui <JoinPreview> card. The route owns the three things the card
// does not: the preview fetch + its two throw-forks (a thrown 404 → a STANDALONE
// terminal invalid notice with NO campaign data, so JoinPreview is never mounted;
// a transient/5xx → a calm retry arm), the guarded sign-in round-trip for a
// signed-out visitor (navigate to `signinReturnToJoin(code)` — the shipped
// isLocalPath+OAuth-state redirect, no new mechanism), and the signed-in inline
// accept → navigation (new member → the join-summary; already-a-member → the
// campaign). A post-accept failure resolves to a calm arm through the card, no nav.
//
// These tests inject the `fetchPreview` / `accept` / `navigateTo` seams (defaults
// are the real client-core fns) so they drive the flow without a live endpoint or
// real navigation, seed the session store for the signed-in/out branch, and render
// AT `/join/ABC` under a memory router so `useParams` resolves the code.

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; the platform builtin can shadow jsdom's real Storage.
// Install a functional in-memory one (mirrors join-summary.test.tsx).
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

const CODE = 'ABC'

type FetchPreview = (ctx: ApiContext, code: string) => Promise<InvitePreview>
type Accept = (ctx: ApiContext, code: string) => Promise<AcceptResult>

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

/** A valid 200 preview: the real campaign + owner still resolve for a revoked
 *  code (that is `valid:false`, NOT a throw); override to shape each case. */
function makePreview(overrides: Partial<InvitePreview> = {}): InvitePreview {
  return {
    campaignName: 'Ashfall',
    ownerUsername: 'mara',
    ownerDisplayName: 'Mara',
    valid: true,
    ...overrides,
  }
}

function renderJoin(
  opts: {
    session?: 'ready' | 'unauthenticated'
    fetchPreview?: FetchPreview
    accept?: Accept
  } = {},
): { navigateTo: ReturnType<typeof vi.fn>; fetchPreview: FetchPreview; accept: Accept } {
  if ((opts.session ?? 'ready') === 'ready') useSessionStore.getState().setReady('u1')
  else useSessionStore.getState().setUnauthenticated()

  const fetchPreview = opts.fetchPreview ?? vi.fn<FetchPreview>().mockResolvedValue(makePreview())
  const accept =
    opts.accept ?? vi.fn<Accept>().mockResolvedValue({ campaignId: 'camp-1', alreadyMember: false })
  const navigateTo = vi.fn<(path: string) => void>()

  const router = createMemoryRouter(
    [
      {
        path: '/join/:code',
        element: <JoinRoute fetchPreview={fetchPreview} accept={accept} navigateTo={navigateTo} />,
      },
    ],
    { initialEntries: [`/join/${CODE}`] },
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
  return { navigateTo, fetchPreview, accept }
}

describe('JoinRoute — the preview card', () => {
  it('renders the previewed campaign name and who invited you', async () => {
    renderJoin({ session: 'ready' })
    await screen.findByTestId('join-preview')
    expect(screen.getByTestId('join-preview-campaign').textContent).toContain('Ashfall')
    expect(screen.getByTestId('join-preview-owner').textContent).toContain('Mara')
  })

  it('previews the code from the URL', async () => {
    const { fetchPreview } = renderJoin({ session: 'ready' })
    await screen.findByTestId('join-preview')
    expect(fetchPreview).toHaveBeenCalledWith(expect.anything(), CODE)
  })
})

describe('JoinRoute — signed-out visitor', () => {
  it('routes the sign-in CTA through the guarded returnTo round-trip', async () => {
    const { navigateTo } = renderJoin({ session: 'unauthenticated' })
    fireEvent.click(await screen.findByTestId('join-preview-signin'))
    // signinReturnToJoin('ABC') — the whole /join/:code path url-encoded onto the
    // SHIPPED ?returnTo (no new redirect mechanism).
    expect(navigateTo).toHaveBeenCalledWith('/auth/signin?returnTo=%2Fjoin%2FABC')
  })
})

describe('JoinRoute — signed-in accept', () => {
  it('navigates a new member to the join-summary', async () => {
    const { navigateTo } = renderJoin({
      session: 'ready',
      accept: vi.fn<Accept>().mockResolvedValue({ campaignId: 'camp-1', alreadyMember: false }),
    })
    fireEvent.click(await screen.findByTestId('join-preview-accept'))
    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/campaigns/camp-1/join')
    })
  })

  it('routes an already-a-member straight to the campaign', async () => {
    const { navigateTo } = renderJoin({
      session: 'ready',
      accept: vi.fn<Accept>().mockResolvedValue({ campaignId: 'camp-1', alreadyMember: true }),
    })
    fireEvent.click(await screen.findByTestId('join-preview-accept'))
    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/campaigns/camp-1')
    })
  })

  it('renders the calm full arm on a 409 and does NOT navigate', async () => {
    const { navigateTo } = renderJoin({
      session: 'ready',
      accept: vi.fn<Accept>().mockRejectedValue(new HttpError(409, 'full', 'campaign_full')),
    })
    fireEvent.click(await screen.findByTestId('join-preview-accept'))
    await screen.findByTestId('join-preview-notice')
    expect(navigateTo).not.toHaveBeenCalled()
  })
})

describe('JoinRoute — preview forks', () => {
  it('renders the in-card invalid notice with NO accept CTA on a valid:false preview', async () => {
    renderJoin({
      session: 'ready',
      fetchPreview: vi.fn<FetchPreview>().mockResolvedValue(makePreview({ valid: false })),
    })
    // The card still mounts (the 200 carries the real campaign/owner); it just
    // renders the calm invalid notice and no CTA.
    await screen.findByTestId('join-preview')
    expect(screen.getByTestId('join-preview-notice')).toBeDefined()
    expect(screen.queryByTestId('join-preview-accept')).toBeNull()
    expect(screen.queryByTestId('join-preview-signin')).toBeNull()
  })

  it('renders a STANDALONE terminal notice (no JoinPreview) on a thrown 404', async () => {
    renderJoin({
      session: 'ready',
      fetchPreview: vi
        .fn<FetchPreview>()
        .mockRejectedValue(new HttpError(404, 'not found', 'invite_not_found')),
    })
    await screen.findByTestId('route-join-invalid')
    // No campaign data to show → the card is never mounted.
    expect(screen.queryByTestId('join-preview')).toBeNull()
  })

  it('renders a calm retry arm on a transient preview failure and re-fetches', async () => {
    const fetchPreview = vi
      .fn<FetchPreview>()
      .mockRejectedValueOnce(new HttpError(500, 'server error'))
      .mockResolvedValueOnce(makePreview())
    renderJoin({ session: 'ready', fetchPreview })
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }))
    await screen.findByTestId('join-preview')
    expect(fetchPreview).toHaveBeenCalledTimes(2)
  })
})
