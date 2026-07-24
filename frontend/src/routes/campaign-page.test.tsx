import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  createSseStatusClient,
  HttpError,
  type ApiContext,
  type CampaignSummary,
  type SseStatusClient,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CampaignPage } from './campaign-page.tsx'
import type { InvitePanelDeps } from './campaign-invite-panel.tsx'
import type { CharacterSurfaceDeps } from './character-new/character-surface.tsx'

// The campaign page (MYT-89 D5 → MYT-90 D8 → MYT-91): world identity + the OWNER
// InvitePanel (MYT-91, replacing the old stub seam) + the real character surface
// (MYT-90). `fetchCampaigns` is injected for the identity; `characterDeps` drives
// the mounted surface to a stable, non-network beat (a processing concept → the
// loading beat); `inviteDeps` injects the invite endpoints + web share/clipboard
// ports so the owner panel resolves a link without a live endpoint or a real
// clipboard. The surface's own routing is covered in character-surface.test.tsx.

// A never-opened SSE client so the mounted loading beat never touches the network.
const characterDeps: CharacterSurfaceDeps = {
  fetchMe: () => Promise.resolve({ user: { id: 'viewer-1' } }),
  fetchSituations: () => Promise.resolve({ situations: [], chosenIndex: 0, startingLevel: 1 }),
  fetchProgress: () =>
    Promise.resolve({
      campaignId: 'c1',
      totalMembers: 1,
      concepts: [
        {
          userId: 'viewer-1',
          displayName: 'You',
          status: 'processing',
          submittedAt: '2026-01-01T00:00:00.000Z',
          confirmedAt: null,
          characterId: null,
        },
      ],
      missing: [],
    }),
  loading: {
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
  },
}

// A deterministic invite seam: `ensurePrimary` resolves a fixed primary link so the
// owner panel renders without a live endpoint; the ports are inert no-ops (each
// test that exercises copy/share/cap-reached overrides the slice it drives).
const DEFAULT_INVITE_DEPS: InvitePanelDeps = {
  ensurePrimary: () =>
    Promise.resolve({ inviteUrl: 'https://mythrun.com/join/ABC123', inviteCode: 'ABC123' }),
  create: () => Promise.resolve({ inviteUrl: 'https://mythrun.com/join/NEW', inviteCode: 'NEW' }),
  revoke: () => Promise.resolve(),
  copyText: () => Promise.resolve(),
  webShare: () => Promise.resolve(),
  canShare: false,
}

// ENVIRONMENT shim (Node 25 vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; install a functional in-memory one (mirrors the sibling
// route tests).
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
  worldColors: { from: 'moss-100', to: 'verdigris-800' },
  creator: null,
  party: [],
  sessionCount: 0,
  lastPlayedAt: null,
  cardPhase: 'needs-character',
}

function renderPage(
  fetchCampaigns: (ctx: ApiContext) => Promise<readonly CampaignSummary[]>,
  campaignId = 'c1',
  inviteDeps: InvitePanelDeps = DEFAULT_INVITE_DEPS,
): void {
  render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={[`/campaigns/${campaignId}`]}>
            <CampaignPage
              campaignId={campaignId}
              fetchCampaigns={fetchCampaigns}
              characterDeps={characterDeps}
              inviteDeps={inviteDeps}
            />
          </MemoryRouter>
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
}

describe('CampaignPage — world identity + MYT-90/91 seams', () => {
  it('renders the world identity (cover + world name) for the matched campaign', async () => {
    renderPage(() => Promise.resolve([CAMPAIGN]))
    expect(await screen.findByTestId('campaign-world-name')).toBeDefined()
    expect(screen.getByTestId('campaign-world-name').textContent).toBe('Emberdeep Hollow')
    // The per-world dither cover (a real colour pair, not the ghost band).
    expect(screen.getByTestId('campaign-cover')).toBeDefined()
    expect(screen.queryByTestId('campaign-cover-ghost')).toBeNull()
  })

  it('mounts the owner InvitePanel (MYT-91) with the primary link and the character surface (MYT-90)', async () => {
    renderPage(() => Promise.resolve([CAMPAIGN]))
    await screen.findByTestId('campaign-world-name')
    // MYT-99g03: the owner invite is DEMOTED below the character beat as a quiet
    // collapsed line (still under `seam-invite` so the selectors don't dangle);
    // opening it reveals the resolved primary link verbatim.
    expect(screen.getByTestId('seam-invite')).toBeDefined()
    fireEvent.click(await screen.findByTestId('invite-collapsed'))
    expect(await screen.findByDisplayValue('https://mythrun.com/join/ABC123')).toBeDefined()
    // The character region routes the injected processing concept to the live
    // loading beat.
    expect(await screen.findByTestId('character-loading')).toBeDefined()
    expect(screen.queryByTestId('seam-character')).toBeNull()
  })

  it('copies the invite link through the injected port and flips the copied ack', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined)
    renderPage(() => Promise.resolve([CAMPAIGN]), 'c1', {
      ...DEFAULT_INVITE_DEPS,
      copyText,
      canShare: true,
    })
    // Open the demoted invite first (collapsed by default on the character beats).
    fireEvent.click(await screen.findByTestId('invite-collapsed'))
    await screen.findByTestId('invite-panel-link')
    fireEvent.click(screen.getByTestId('invite-panel-copy'))
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith('https://mythrun.com/join/ABC123')
    })
    // The panel reflects the transient "copied" acknowledgement (the route's timer).
    await waitFor(() => {
      expect(screen.getByTestId('invite-panel-copy').textContent).toMatch(/copied/i)
    })
  })

  it('surfaces the cap-reached notice when the invite endpoint reports the cap (409)', async () => {
    renderPage(() => Promise.resolve([CAMPAIGN]), 'c1', {
      ...DEFAULT_INVITE_DEPS,
      ensurePrimary: () =>
        Promise.reject(new HttpError(409, 'invite cap reached', 'invite_cap_reached')),
    })
    // A calm cap-reached notice (a soft limit), and — with no resolved link — the
    // create affordance, never a dead field.
    expect(await screen.findByTestId('invite-panel-notice')).toBeDefined()
    expect(screen.queryByTestId('invite-panel-link')).toBeNull()
  })

  it('renders NO invite panel for a non-owner (a joined member, creator set)', async () => {
    renderPage(() => Promise.resolve([{ ...CAMPAIGN, creator: 'Other Player' }]))
    // The owner-only invite region is absent for a member; the rest of the page
    // (identity + the character surface) still renders.
    expect(await screen.findByTestId('campaign-world-name')).toBeDefined()
    expect(screen.queryByTestId('seam-invite')).toBeNull()
    expect(screen.queryByTestId('invite-panel')).toBeNull()
    expect(await screen.findByTestId('character-loading')).toBeDefined()
  })

  it('renders a ghost cover (and still the owner panel) when the world has no colour pick yet', async () => {
    renderPage(() => Promise.resolve([{ ...CAMPAIGN, worldColors: null }]))
    expect(await screen.findByTestId('campaign-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('campaign-cover')).toBeNull()
    // The owner panel still renders regardless of identity colour resolution.
    expect(screen.getByTestId('seam-invite')).toBeDefined()
  })

  it('settles to a calm ghost identity (no invite panel) when the campaign is not found', async () => {
    renderPage(() => Promise.resolve([]), 'missing')
    // No matched campaign ⟹ no owner gate ⟹ no invite panel; the surface still
    // holds on its calm loading line (campaign null) and the identity falls to the
    // ghost swatch.
    expect(await screen.findByTestId('character-surface-loading')).toBeDefined()
    expect(screen.queryByTestId('seam-invite')).toBeNull()
    expect(screen.getByTestId('campaign-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('campaign-world-name')).toBeNull()
  })

  it('settles to a calm ghost identity (no invite panel) when the campaign fetch fails', async () => {
    renderPage(() => Promise.reject(new Error('boom')))
    expect(await screen.findByTestId('campaign-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('seam-invite')).toBeNull()
  })
})
