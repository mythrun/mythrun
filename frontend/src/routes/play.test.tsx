import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type CampaignSummary,
  type SessionView,
  type SessionPrepStream,
  type StartFlow,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { PlayRoute, type PlayRouteProps } from './play.tsx'

/** The start-flow render state (the union is not barreled; read it off StartFlow). */
type StartFlowState = StartFlow['state']

// The live-play route (MYT-92 T16) — the composition over the client-core session
// hooks. These tests inject the identity loaders + the three session hooks (defaults
// are the real endpoints/hooks) so every start-flow phase + the live shell render
// deterministically, without a live transport. The hooks' own logic is covered in
// client-core; here we assert the ROUTE wiring: phase → screen, the send/summon
// handlers, the recap landing, the purchase seam branches, and the calm holds.

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
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

const CAMPAIGN_ID = 'c1'
const VIEWER_ID = 'viewer-1'

/** A minimal-but-complete hub-card payload for the campaign under test. `creator`
 *  null ⟹ the viewer owns it. */
function campaign(overrides: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: CAMPAIGN_ID,
    worldId: 'w1',
    name: 'The Salt Ledger',
    status: 'active',
    language: 'en',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    worldName: 'Ashfen',
    worldColors: null,
    creator: null,
    party: [
      { userId: VIEWER_ID, displayName: 'Ada', hasCharacter: true },
      { userId: 'u2', displayName: 'Bram', hasCharacter: true },
    ],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
    ...overrides,
  }
}

const fetchMeOk = (): Promise<{ user: { id: string; displayName: string } }> =>
  Promise.resolve({ user: { id: VIEWER_ID, displayName: 'Ada' } })
const fetchCampaignsOk = (): Promise<readonly CampaignSummary[]> => Promise.resolve([campaign()])

/** A fixed StartFlow whose `start`/`retry` are spies (the phase never transitions on
 *  its own — the test drives it). */
function stubStart(state: StartFlowState): { hook: PlayRouteProps['useStart']; retry: ReturnType<typeof vi.fn> } {
  const retry = vi.fn()
  const flow: StartFlow = { state, start: vi.fn(), retry }
  return { hook: () => flow, retry }
}

function stubPrep(stream: SessionPrepStream): PlayRouteProps['usePrep'] {
  return () => stream
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    items: [],
    connection: { status: 'connected', attempt: 0 },
    thinking: false,
    typingUserIds: [],
    ended: false,
    progress: null,
    sendMessage: vi.fn(),
    summonDm: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  }
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

/** Render the play route at its URL under a memory router that also carries the recap
 *  landing (so a session-end navigation resolves to an observable stub). */
function renderRoute(props: PlayRouteProps): void {
  const router = createMemoryRouter(
    [
      { path: '/campaigns/:id/play', element: <PlayRoute fetchMe={fetchMeOk} fetchCampaigns={fetchCampaignsOk} {...props} /> },
      { path: '/campaigns/:id/recap', element: <RecapStub /> },
      { path: '/campaigns/:id', element: <CampaignStub /> },
    ],
    { initialEntries: [`/campaigns/${CAMPAIGN_ID}/play`] },
  )
  render(
    // The query provider mirrors the app root — the live shell's mount-time
    // balance invalidation (myth-q53lj) reads the query client.
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <ApiClientProvider value={testCtx}>
          <I18nextProvider i18n={i18n}>
            <RouterProvider router={router} />
          </I18nextProvider>
        </ApiClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

function RecapStub(): React.JSX.Element {
  return <div data-testid="route-recap" />
}

function CampaignStub(): React.JSX.Element {
  return <div data-testid="route-campaign-stub" />
}

describe('PlayRoute — start-flow phases', () => {
  it('renders the connecting beat while the start is in flight', async () => {
    const { hook } = stubStart({ phase: 'starting' })
    renderRoute({ useStart: hook })
    const beat = await screen.findByTestId('session-start-beat')
    expect(beat.getAttribute('data-phase')).toBe('connecting')
  })

  it('renders the calm preparing hold and does NOT re-attempt start when prep reports ready (the hook backoff-polls — no storm)', async () => {
    const { hook, retry } = stubStart({ phase: 'waiting', code: 'prep_not_ready' })
    renderRoute({ useStart: hook, usePrep: stubPrep({ status: 'ready', terminal: false }) })
    // The between-sessions interstitial shows; the SSE `ready` must NOT re-fire start()
    // — the storm's root cause is removed (the hook owns the poll cadence).
    expect(await screen.findByTestId('play-preparing')).toBeDefined()
    expect(screen.getByTestId('session-preparing')).toBeDefined()
    // Give any (removed) retry effect a chance to fire — it must not.
    await waitFor(() => {
      expect(screen.getByTestId('session-preparing')).toBeDefined()
    })
    expect(retry).not.toHaveBeenCalled()
  })

  it('holds the preparing interstitial (no retry) while prep is still generating', async () => {
    const { hook, retry } = stubStart({ phase: 'waiting', code: 'prep_not_ready' })
    renderRoute({ useStart: hook, usePrep: stubPrep({ status: 'generating', terminal: false }) })
    await screen.findByTestId('play-preparing')
    expect(retry).not.toHaveBeenCalled()
  })

  it('shows the calm prep-failed hold on a terminal prep failure', async () => {
    const { hook } = stubStart({ phase: 'waiting', code: 'prep_not_ready' })
    renderRoute({ useStart: hook, usePrep: stubPrep({ status: 'failed', terminal: true }) })
    expect(await screen.findByTestId('play-prep-failed')).toBeDefined()
  })

  it('the integration wait (campaign_not_active) with a PARTY shows the calm hold with the party-integration line — NOT the retry-mash blocked notice', async () => {
    // The reported bug: clicking "begin the adventure" landed the owner on the
    // generic "try again" blocked notice while the world was being woven together.
    // campaign_not_active now polls under the calm hold, with apter words. The
    // default fixture party has two members → the "party" wording.
    const { hook } = stubStart({ phase: 'waiting', code: 'campaign_not_active' })
    renderRoute({ useStart: hook, usePrep: stubPrep({ status: 'generating', terminal: false }) })
    expect(await screen.findByTestId('play-preparing')).toBeDefined()
    expect(screen.getAllByText(i18n.t('play.preparing.integratingLabel')).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('play-blocked')).toBeNull()
  })

  it('the integration wait (campaign_not_active) for a SOLO owner reads as their own character settling in — never claims a "party" of one', async () => {
    // The forensic user: a solo owner in the ~51s setup window. "Bringing your PARTY
    // into the world" would be wrong for a table of one, so it borrows the settling line.
    const soloCampaign = { ...campaign(), party: [{ userId: VIEWER_ID, displayName: 'Ada', hasCharacter: true }] }
    const { hook } = stubStart({ phase: 'waiting', code: 'campaign_not_active' })
    renderRoute({
      useStart: hook,
      usePrep: stubPrep({ status: 'generating', terminal: false }),
      fetchCampaigns: () => Promise.resolve([soloCampaign]),
    })
    expect(await screen.findByTestId('play-preparing')).toBeDefined()
    expect(screen.getAllByText(i18n.t('play.preparing.settlingLabel')).length).toBeGreaterThan(0)
  })

  it('the self-integration wait (members_without_characters, viewer only) shows the calm hold with the settling line — never "waiting on your own name"', async () => {
    // The forensic attempts 1-4: a solo owner clicked ~0.5s after finalizing; his OWN
    // integration was in flight so /start named HIM as the missing member. It must read
    // as "your character is settling in", auto-polling — not the members block.
    const { hook } = stubStart({ phase: 'waiting', code: 'members_without_characters' })
    renderRoute({ useStart: hook, usePrep: stubPrep({ status: 'generating', terminal: false }) })
    expect(await screen.findByTestId('play-preparing')).toBeDefined()
    expect(screen.getAllByText(i18n.t('play.preparing.settlingLabel')).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('play-blocked')).toBeNull()
  })

  it('renders the generic retry notice for an off-contract blocked stop', async () => {
    const { hook } = stubStart({ phase: 'blocked', code: 'unrecognized_stop' })
    renderRoute({ useStart: hook })
    expect(await screen.findByTestId('play-blocked')).toBeDefined()
  })

  it('a terminal integration failure (campaign_failed) shows the return-to-setup notice and routes back to the campaign page (never re-POSTs /start in place)', async () => {
    const { hook, retry } = stubStart({ phase: 'blocked', code: 'campaign_failed' })
    renderRoute({ useStart: hook })
    const notice = await screen.findByTestId('play-integration-failed')
    expect(notice).toBeDefined()
    fireEvent.click(screen.getByTestId('play-integration-failed-retry'))
    // The action navigates to the campaign setup page (where the integration
    // retry lives) — it does NOT re-attempt start in place.
    expect(await screen.findByTestId('route-campaign-stub')).toBeDefined()
    expect(retry).not.toHaveBeenCalled()
  })

  it('renders a retry notice for a generic start error', async () => {
    const { hook } = stubStart({ phase: 'error' })
    renderRoute({ useStart: hook })
    expect(await screen.findByTestId('play-error')).toBeDefined()
  })
})

describe('PlayRoute — the purchase-moment seam', () => {
  it('renders the owner buy seam with the credit detail', async () => {
    const { hook } = stubStart({
      phase: 'purchase',
      moment: { available: 1, required: 2, viewerIsOwner: true },
    })
    renderRoute({ useStart: hook })
    expect(await screen.findByTestId('purchase-moment-seam')).toBeDefined()
    // The MYT-95 merge wired the real PurchasePrompt into the seam: the credit
    // detail rides its body, and the owner buy group renders the presets.
    const prompt = screen.getByTestId('purchase-moment-prompt')
    expect(prompt.textContent).toContain('1')
    expect(prompt.textContent).toContain('2')
    expect(screen.getByRole('group')).toBeDefined()
  })

  it('renders the "host is out of credits" hold for a non-owner', async () => {
    const { hook } = stubStart({
      phase: 'purchase',
      moment: { available: 0, required: 2, viewerIsOwner: false },
    })
    renderRoute({ useStart: hook })
    expect(await screen.findByTestId('play-purchase-not-owner')).toBeDefined()
    expect(screen.queryByTestId('purchase-moment-seam')).toBeNull()
  })
})

describe('PlayRoute — the live session shell', () => {
  const DM_TEXT = 'The tavern door creaks open on a gust of cold rain.'
  const readyItems: SessionView['items'] = [
    { kind: 'dm', key: 'dm-1', turnId: 'T1', text: DM_TEXT, streaming: false },
  ]

  it('mounts the transcript with the session items', async () => {
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, useLiveSession: () => makeSession({ items: readyItems }) })
    expect(await screen.findByTestId('message-stream')).toBeDefined()
    expect(screen.getByText(DM_TEXT)).toBeDefined()
  })

  it('sends the composed message and clears the input on Send', async () => {
    const sendMessage = vi.fn()
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, useLiveSession: () => makeSession({ sendMessage }) })
    await screen.findByTestId('message-stream')

    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'I open the door' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.input.send') }))

    expect(sendMessage).toHaveBeenCalledWith('I open the door')
    expect((field as HTMLTextAreaElement).value).toBe('')
  })

  it('summons the DM with the @dm token composed into the text', async () => {
    const summonDm = vi.fn()
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, useLiveSession: () => makeSession({ summonDm }) })
    await screen.findByTestId('message-stream')

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'what do I see?' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.input.summon') }))

    expect(summonDm).toHaveBeenCalledWith('@dm what do I see?')
  })

  it('navigates to the recap route when the session ends', async () => {
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, useLiveSession: () => makeSession({ ended: true }) })
    expect(await screen.findByTestId('route-recap')).toBeDefined()
  })

  it('is a single-column full-bleed stage with the desktop sidebar seam and no mobile drawer', async () => {
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, useLiveSession: () => makeSession({ items: readyItems }) })
    const shell = await screen.findByTestId('session-shell')
    // The full-bleed flex-scroll root — the min-h-0 chain the transcript scrolls in.
    expect(shell.className).toContain('min-h-0')
    expect(shell.className).toContain('flex')
    expect(screen.getByTestId('message-stream')).toBeDefined()
    // The sidebar is the collapsible desktop seam only (MYT-92 wires no mobile drawer).
    expect(screen.getAllByTestId('session-sidebar-seam')).toHaveLength(1)
  })
})

describe('PlayRoute — identity holds', () => {
  it('shows a calm loading line while the viewer resolves', () => {
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    // A never-resolving identity fetch keeps the route in the loading hold.
    const never = <T,>(): Promise<T> => new Promise<T>(() => undefined)
    renderRoute({ useStart: hook, fetchMe: never, fetchCampaigns: never })
    expect(screen.getByTestId('play-loading')).toBeDefined()
  })

  it('shows a retry notice when the viewer cannot be loaded', async () => {
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, fetchCampaigns: () => Promise.reject(new Error('boom')) })
    expect(await screen.findByTestId('play-viewer-error')).toBeDefined()
  })

  it('treats a campaign the viewer is not a member of as an error', async () => {
    const { hook } = stubStart({ phase: 'ready', sessionId: 's1' })
    renderRoute({ useStart: hook, fetchCampaigns: () => Promise.resolve([]) })
    expect(await screen.findByTestId('play-viewer-error')).toBeDefined()
  })
})
