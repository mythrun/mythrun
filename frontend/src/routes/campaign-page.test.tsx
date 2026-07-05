import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { ApiClientProvider, type ApiContext, type CampaignSummary } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CampaignPage } from './campaign-page.tsx'

// The campaign page (D5) is the MYT-89 boundary: world identity + two clearly-marked
// STUB seams (invite = MYT-91, character = MYT-90). `fetchCampaigns` is injected so
// these render against a resolved fixture without a live endpoint.

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
): void {
  render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <CampaignPage campaignId={campaignId} fetchCampaigns={fetchCampaigns} />
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

  it('renders both clearly-marked stub seams (invite MYT-91, character MYT-90)', async () => {
    renderPage(() => Promise.resolve([CAMPAIGN]))
    await screen.findByTestId('campaign-world-name')
    const invite = screen.getByTestId('seam-invite')
    const character = screen.getByTestId('seam-character')
    expect(invite).toBeDefined()
    expect(character).toBeDefined()
    // Placeholder copy → visibly a stub, not a fake-working control.
    expect(invite.textContent).toContain('[ph:')
    expect(character.textContent).toContain('[ph:')
  })

  it('renders a ghost cover when the world has no colour pick yet', async () => {
    renderPage(() => Promise.resolve([{ ...CAMPAIGN, worldColors: null }]))
    expect(await screen.findByTestId('campaign-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('campaign-cover')).toBeNull()
    // The seams still render regardless of identity resolution.
    expect(screen.getByTestId('seam-invite')).toBeDefined()
  })

  it('settles to a calm ghost identity when the campaign is not found', async () => {
    renderPage(() => Promise.resolve([]), 'missing')
    // The page (seams) still renders; the identity falls to the ghost swatch.
    expect(await screen.findByTestId('seam-character')).toBeDefined()
    expect(screen.getByTestId('campaign-cover-ghost')).toBeDefined()
    expect(screen.queryByTestId('campaign-world-name')).toBeNull()
  })

  it('settles to a calm ghost identity when the campaign fetch fails', async () => {
    renderPage(() => Promise.reject(new Error('boom')))
    expect(await screen.findByTestId('seam-invite')).toBeDefined()
    expect(screen.getByTestId('campaign-cover-ghost')).toBeDefined()
  })
})
