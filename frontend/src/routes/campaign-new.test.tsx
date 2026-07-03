import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useParams } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  configureGuidedDraft,
  readGuidedDraft,
  type ApiContext,
  type SessionDraftStore,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CampaignNewRoute } from './campaign-new.tsx'

// ENVIRONMENT shim (Node 25 vs jsdom), not production code. The screen mounts
// @mythrun/ui's <ThemeProvider>, which reads `localStorage` on mount. Node 25
// ships a non-functional builtin `localStorage` that SHADOWS jsdom's real
// `Storage`; install a functional in-memory one so the stack renders (mirrors
// landing.test.tsx / onboard.test.tsx).
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

const BASE_URL = 'http://api.test'
const server = setupServer()
const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
  server.listen({ onUnhandledRequest: 'error' })
})

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

// The navigation SINK: `/campaigns/:campaignId` (the generating route, Phase C).
// B3 only needs to prove the controller navigates there on a 201, so this stand-in
// echoes the routed id back for the assertion.
function CampaignTarget(): React.JSX.Element {
  const { campaignId } = useParams()
  return <div data-testid="route-campaign-target">{campaignId}</div>
}

function renderRoute(): void {
  const router = createMemoryRouter(
    [
      { path: '/campaigns/new', element: <CampaignNewRoute /> },
      { path: '/campaigns/:campaignId', element: <CampaignTarget /> },
    ],
    { initialEntries: ['/campaigns/new'] },
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
}

beforeEach(() => { setMatch(); localStorage.clear() })
// Web's vitest config sets no `globals`, so testing-library's auto-cleanup is not
// registered — `cleanup()` must UNMOUNT the prior render (mirrors landing.test).
afterEach(() => { cleanup(); server.resetHandlers() })
afterAll(() => { server.close() })

const ideaTitle = (): string => i18n.t('campaignNew.fork.idea.title')
const loveTitle = (): string => i18n.t('campaignNew.fork.love.title')

/** Walk fork → freeform (the screen every freeform case starts from). */
function gotoFreeform(): void {
  renderRoute()
  act(() => { screen.getByText(ideaTitle()).click() })
}

describe('CampaignNewRoute', () => {
  it('renders the fork screen with both choices (i18n keys resolved)', () => {
    renderRoute()
    expect(screen.getByTestId('route-campaign-new')).toBeDefined()
    expect(screen.getByTestId('screen-fork')).toBeDefined()
    expect(screen.getByText(ideaTitle())).toBeDefined()
    expect(screen.getByText(loveTitle())).toBeDefined()
    // Back is hidden on the fork (it is the flow's root).
    expect(screen.queryByTestId('campaign-new-back')).toBeNull()
  })

  it('advances to the freeform screen when "Start from an idea" is chosen', () => {
    renderRoute()
    act(() => { screen.getByText(ideaTitle()).click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
  })

  it('advances to the guided screen when "Build from what you love" is chosen', () => {
    renderRoute()
    act(() => { screen.getByText(loveTitle()).click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
  })

  it('the back affordance pops history and returns to the fork', () => {
    renderRoute()
    act(() => { screen.getByText(ideaTitle()).click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
    act(() => { screen.getByTestId('campaign-new-back').click() })
    expect(screen.getByTestId('screen-fork')).toBeDefined()
    expect(screen.queryByTestId('campaign-new-back')).toBeNull()
  })
})

describe('CampaignNewRoute freeform screen', () => {
  const begin = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('freeform-begin')
  const typeConcept = (value: string): void => {
    fireEvent.change(screen.getByTestId('freeform-input'), { target: { value } })
  }

  it('keeps Begin disabled under 20 chars and enables it at or above 20', () => {
    gotoFreeform()
    // Empty → disabled.
    expect(begin().disabled).toBe(true)
    // 19 chars → still disabled (the freeform floor mirrors the contract min(20)).
    typeConcept('a'.repeat(19))
    expect(begin().disabled).toBe(true)
    // 20 chars → enabled.
    typeConcept('a'.repeat(20))
    expect(begin().disabled).toBe(false)
  })

  it('posts the WRAPPED freeform body and navigates to /campaigns/:newId on 201', async () => {
    let capturedBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ campaignId: 'c-new-1' }, { status: 201 })
      }),
    )
    gotoFreeform()
    const concept = 'A drowned cathedral city the tide never fully leaves.'
    typeConcept(concept)
    act(() => { begin().click() })

    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-target').textContent).toBe('c-new-1')
    })
    // The wire body is the wrapped freeform shape — nothing more.
    expect(capturedBody).toEqual({
      world: { kind: 'new', source: { mode: 'freeform', concept } },
    })
  })

  it('shows a 422 concept_rejected rejectionMessage inline, without navigating', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json(
          { code: 'concept_rejected', reason: 'inappropriate', rejectionMessage: 'That concept crosses a line.' },
          { status: 422 },
        ),
      ),
    )
    gotoFreeform()
    typeConcept('A drowned cathedral city the tide never fully leaves.')
    act(() => { begin().click() })

    await waitFor(() => {
      expect(screen.getByTestId('freeform-notice').textContent).toBe('That concept crosses a line.')
    })
    // Stayed on freeform — the minimal inline rejection does not navigate (B5 owns
    // the full rejection screen).
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
    expect(screen.queryByTestId('route-campaign-target')).toBeNull()
    // Begin is re-enabled so the player can edit + retry.
    expect(begin().disabled).toBe(false)
  })

  it('switches to the guided path when the quiet switch line is pressed', () => {
    gotoFreeform()
    act(() => { screen.getByTestId('freeform-switch').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
  })
})

describe('CampaignNewRoute guided screen', () => {
  const SYNTH_URL = `${BASE_URL}/api/campaigns/synthesize-preview`
  const stepMarker = (n: 'one' | 'two' | 'three'): string => i18n.t(`campaignNew.guided.step.${n}`)
  const findLabel = (): string => i18n.t('campaignNew.guided.find')

  const nameInput = (): HTMLInputElement => screen.getByTestId<HTMLInputElement>('guided-name-input')
  const whyInput = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>('guided-why-input')
  const advanceBtn = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('guided-advance')
  const marker = (): string | null => screen.getByTestId('guided-step-marker').textContent

  const typePick = (title: string, why: string): void => {
    fireEvent.change(nameInput(), { target: { value: title } })
    fireEvent.change(whyInput(), { target: { value: why } })
  }

  /** Walk fork → guided (the screen every guided case starts from). */
  function gotoGuided(): void {
    renderRoute()
    act(() => { screen.getByText(loveTitle()).click() })
  }

  const PICKS = [
    { title: 'Dark Souls', whyILikeIt: 'the oppressive melancholy' },
    { title: 'Dune', whyILikeIt: 'ecology as destiny' },
    { title: 'Annihilation', whyILikeIt: 'the shimmer' },
  ] as const

  /** Fill all three picks in sequence, advancing through steps 1→2→3 (leaves on step 3). */
  function fillAllPicks(): void {
    PICKS.forEach((p, i) => {
      typePick(p.title, p.whyILikeIt)
      if (i < 2) act(() => { advanceBtn().click() })
    })
  }

  it('starts on step one with the name + why fields and the first marker', () => {
    gotoGuided()
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(marker()).toBe(stepMarker('one'))
    expect(nameInput()).toBeDefined()
    expect(whyInput()).toBeDefined()
    // No step-back on step one; the quiet freeform switch is offered instead.
    expect(screen.queryByTestId('guided-back')).toBeNull()
    expect(screen.getByTestId('guided-switch')).toBeDefined()
  })

  it('advances through the three steps with the primary action', () => {
    gotoGuided()
    typePick(PICKS[0].title, PICKS[0].whyILikeIt)
    act(() => { advanceBtn().click() })
    expect(marker()).toBe(stepMarker('two'))
    typePick(PICKS[1].title, PICKS[1].whyILikeIt)
    act(() => { advanceBtn().click() })
    expect(marker()).toBe(stepMarker('three'))
    // On the last step the action becomes "Find my world".
    expect(advanceBtn().textContent).toBe(findLabel())
  })

  it('keeps the primary action disabled until the current pick is filled', () => {
    gotoGuided()
    expect(advanceBtn().disabled).toBe(true)
    fireEvent.change(nameInput(), { target: { value: 'Dark Souls' } })
    expect(advanceBtn().disabled).toBe(true) // why still empty
    fireEvent.change(whyInput(), { target: { value: 'the oppressive melancholy' } })
    expect(advanceBtn().disabled).toBe(false)
  })

  it('← Back on step two returns to step one with the step-one pick preserved', () => {
    gotoGuided()
    typePick(PICKS[0].title, PICKS[0].whyILikeIt)
    act(() => { advanceBtn().click() })
    expect(marker()).toBe(stepMarker('two'))
    act(() => { screen.getByTestId('guided-back').click() })
    expect(marker()).toBe(stepMarker('one'))
    expect(nameInput().value).toBe(PICKS[0].title)
    expect(whyInput().value).toBe(PICKS[0].whyILikeIt)
  })

  it('posts exactly the 3-pick body and, on 201, moves to preview carrying the payload', async () => {
    let capturedBody: unknown
    server.use(
      http.post(SYNTH_URL, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ previewId: 'p-1', concept: 'A synthesized concept.' }, { status: 201 })
      }),
    )
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('screen-preview')).toBeDefined()
    })
    // The carried concept reached (and renders on) the preview screen.
    expect(screen.getByTestId('preview-concept').textContent).toBe('A synthesized concept.')
    // The wire body is exactly the three picks — nothing more.
    expect(capturedBody).toEqual({ picks: PICKS })
  })

  it('routes to the rejection state on a 422 concept_rejected', async () => {
    server.use(
      http.post(SYNTH_URL, () =>
        HttpResponse.json(
          {
            code: 'concept_rejected',
            reason: 'clone_intent',
            rejectionMessage: 'Too close to an existing world.',
            synthesizedConcept: 'A near-clone concept.',
          },
          { status: 422 },
        ),
      ),
    )
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('screen-rejection')).toBeDefined()
    })
    expect(screen.queryByTestId('screen-guided')).toBeNull()
  })

  it('shows a calm inline retry notice on a 503, without leaving the guided screen', async () => {
    server.use(
      http.post(SYNTH_URL, () =>
        HttpResponse.json({ code: 'llm_upstream_unavailable' }, { status: 503 }),
      ),
    )
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('guided-notice')).toBeDefined()
    })
    // Stayed on guided; the action re-enables so the player can retry.
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.queryByTestId('screen-preview')).toBeNull()
    expect(advanceBtn().disabled).toBe(false)
  })

  it('routes a content_filtered synthesize to the TERMINAL rejection, not a retry notice', async () => {
    server.use(
      http.post(SYNTH_URL, () =>
        HttpResponse.json({ code: 'content_filtered' }, { status: 422 }),
      ),
    )
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('screen-rejection')).toBeDefined()
    })
    // Anthropic's content policy is terminal (retrying re-hits the same filter):
    // the distinct filtered message + start-over only — never the try-again notice.
    expect(screen.getByTestId('rejection-message').textContent).toBe(
      i18n.t('campaignNew.rejection.filteredMessage'),
    )
    expect(screen.getByTestId('rejection-start-over')).toBeDefined()
    expect(screen.queryByTestId('rejection-edit-freeform')).toBeNull()
    expect(screen.queryByTestId('guided-notice')).toBeNull()
    expect(screen.queryByTestId('screen-guided')).toBeNull()
  })

  it('switches to the freeform path from the step-one quiet switch line', () => {
    gotoGuided()
    act(() => { screen.getByTestId('guided-switch').click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
  })
})

// Shared guided-walk for the preview + rejection blocks: register the terminal
// synthesize handler, then fork → guided → fill the three picks → fire the final
// synthesize. The caller waits for whichever screen the handler's status lands on.
const GUIDED_SYNTH_URL = `${BASE_URL}/api/campaigns/synthesize-preview`
const GUIDED_PICKS = [
  { title: 'Dark Souls', whyILikeIt: 'the oppressive melancholy' },
  { title: 'Dune', whyILikeIt: 'ecology as destiny' },
  { title: 'Annihilation', whyILikeIt: 'the shimmer' },
] as const

function synthesizeGuided(handler: ReturnType<typeof http.post>): void {
  server.use(handler)
  renderRoute()
  act(() => { screen.getByText(loveTitle()).click() })
  GUIDED_PICKS.forEach((p, i) => {
    fireEvent.change(screen.getByTestId('guided-name-input'), { target: { value: p.title } })
    fireEvent.change(screen.getByTestId('guided-why-input'), { target: { value: p.whyILikeIt } })
    if (i < 2) act(() => { screen.getByTestId('guided-advance').click() })
  })
  act(() => { screen.getByTestId('guided-advance').click() })
}

describe('CampaignNewRoute preview screen', () => {
  const CONCEPT = 'A drowned cathedral city the tide never fully leaves.'

  /** Walk fork → guided → synthesize (201) → preview, carrying `concept`/`previewId`. */
  async function gotoPreview(concept = CONCEPT, previewId = 'p-1'): Promise<void> {
    synthesizeGuided(
      http.post(GUIDED_SYNTH_URL, () => HttpResponse.json({ previewId, concept }, { status: 201 })),
    )
    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
  }

  it('renders the concept prose and the three initial actions', async () => {
    await gotoPreview()
    expect(screen.getByTestId('preview-concept').textContent).toBe(CONCEPT)
    expect(screen.getByTestId('preview-begin')).toBeDefined()
    expect(screen.getByTestId('preview-ask-change')).toBeDefined()
    expect(screen.getByTestId('preview-start-over')).toBeDefined()
    // No spent-note before any rework.
    expect(screen.queryByTestId('preview-change-spent')).toBeNull()
  })

  it('commits the guided preview (wrapped body) and navigates to /campaigns/:id on Begin', async () => {
    let capturedBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ campaignId: 'c-guided-1' }, { status: 201 })
      }),
    )
    await gotoPreview()
    act(() => { screen.getByTestId('preview-begin').click() })

    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-target').textContent).toBe('c-guided-1')
    })
    // The guided commit body carries the previewId only — no concept text.
    expect(capturedBody).toEqual({
      world: { kind: 'new', source: { mode: 'guided', previewId: 'p-1' } },
    })
  })

  it('reworks once: shows the revised concept and leaves Begin as the only action', async () => {
    const revised = 'A revised tidal city, now watched over by a living lighthouse.'
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/p-1/rework`, () =>
        HttpResponse.json({ previewId: 'p-1', concept: revised }, { status: 200 }),
      ),
    )
    await gotoPreview()
    act(() => { screen.getByTestId('preview-ask-change').click() })
    fireEvent.change(screen.getByTestId('preview-change-input'), { target: { value: 'make the lighthouse alive' } })
    act(() => { screen.getByTestId('preview-rework').click() })

    await waitFor(() => {
      expect(screen.getByTestId('preview-concept').textContent).toBe(revised)
    })
    // The one change is spent: only Begin remains + the faint spent-note.
    expect(screen.getByTestId('preview-begin')).toBeDefined()
    expect(screen.getByTestId('preview-change-spent')).toBeDefined()
    expect(screen.queryByTestId('preview-ask-change')).toBeNull()
    expect(screen.queryByTestId('preview-start-over')).toBeNull()
    expect(screen.queryByTestId('preview-change-input')).toBeNull()
  })

  it('routes to the rejection state when a rework is rejected by the gate (422)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/p-1/rework`, () =>
        HttpResponse.json(
          {
            code: 'concept_rejected',
            reason: 'inappropriate',
            rejectionMessage: 'That change crosses a line.',
            synthesizedConcept: 'A reworked-but-rejected concept.',
          },
          { status: 422 },
        ),
      ),
    )
    await gotoPreview()
    act(() => { screen.getByTestId('preview-ask-change').click() })
    fireEvent.change(screen.getByTestId('preview-change-input'), { target: { value: 'push it further' } })
    act(() => { screen.getByTestId('preview-rework').click() })

    await waitFor(() => { expect(screen.getByTestId('screen-rejection')).toBeDefined() })
    expect(screen.getByTestId('rejection-message').textContent).toBe('That change crosses a line.')
    expect(screen.queryByTestId('screen-preview')).toBeNull()
  })

  it('returns to the guided picks on Start over', async () => {
    await gotoPreview()
    act(() => { screen.getByTestId('preview-start-over').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.queryByTestId('screen-preview')).toBeNull()
  })

  it('restarts the guided flow when the commit reports the preview expired (410)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json({ code: 'preview_expired' }, { status: 410 }),
      ),
    )
    await gotoPreview()
    act(() => { screen.getByTestId('preview-begin').click() })

    await waitFor(() => { expect(screen.getByTestId('screen-guided')).toBeDefined() })
    expect(screen.queryByTestId('screen-preview')).toBeNull()
  })
})

describe('CampaignNewRoute rejection screen', () => {
  /** Walk fork → guided → synthesize (422 guided rejection) → the rejection screen. */
  async function gotoRejection(): Promise<void> {
    synthesizeGuided(
      http.post(GUIDED_SYNTH_URL, () =>
        HttpResponse.json(
          {
            code: 'concept_rejected',
            reason: 'clone_intent',
            rejectionMessage: 'Too close to an existing world.',
            synthesizedConcept: 'A near-clone concept.',
          },
          { status: 422 },
        ),
      ),
    )
    await waitFor(() => { expect(screen.getByTestId('screen-rejection')).toBeDefined() })
  }

  it('renders the rejection message and, for a guided rejection, the judged concept', async () => {
    await gotoRejection()
    expect(screen.getByTestId('rejection-message').textContent).toBe('Too close to an existing world.')
    expect(screen.getByTestId('rejection-concept').textContent).toBe('A near-clone concept.')
    expect(screen.getByTestId('rejection-edit-freeform')).toBeDefined()
    expect(screen.getByTestId('rejection-start-over')).toBeDefined()
  })

  it('drops into freeform pre-filled with the judged concept on edit-as-freeform', async () => {
    await gotoRejection()
    act(() => { screen.getByTestId('rejection-edit-freeform').click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
    expect(screen.getByTestId<HTMLTextAreaElement>('freeform-input').value).toBe('A near-clone concept.')
  })

  it('returns to the guided picks on start over', async () => {
    await gotoRejection()
    act(() => { screen.getByTestId('rejection-start-over').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.queryByTestId('screen-rejection')).toBeNull()
  })
})

// The §11 draft seam is a no-op in the harness by default (the web store is only
// wired at boot). Configure an in-memory SessionDraftStore so the clear-timing
// wiring — draft survives synthesize, cleared only on commit — is EXERCISED.
function makeDraftStore(): SessionDraftStore {
  const backing = new Map<string, string>()
  return {
    get: (key) => backing.get(key) ?? null,
    set: (key, value) => { backing.set(key, value) },
    remove: (key) => { backing.delete(key) },
  }
}

describe('CampaignNewRoute guided draft persistence (§11)', () => {
  beforeEach(() => { configureGuidedDraft(makeDraftStore()) })
  afterEach(() => { configureGuidedDraft(null) })

  async function gotoPreviewWithDraft(): Promise<void> {
    synthesizeGuided(
      http.post(GUIDED_SYNTH_URL, () =>
        HttpResponse.json({ previewId: 'p-1', concept: 'A synthesized concept.' }, { status: 201 }),
      ),
    )
    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
  }

  it('keeps the draft through synthesize and clears it only once the campaign commits', async () => {
    await gotoPreviewWithDraft()
    // The picks SURVIVE a successful synthesize — so a start-over / 410 re-prefills.
    expect(readGuidedDraft()?.picks).toEqual(GUIDED_PICKS)

    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json({ campaignId: 'c-guided-1' }, { status: 201 }),
      ),
    )
    act(() => { screen.getByTestId('preview-begin').click() })
    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-target').textContent).toBe('c-guided-1')
    })
    // The draft is dropped exactly once — at guided commit.
    expect(readGuidedDraft()).toBeNull()
  })

  it('re-prefills the guided picks when Start over returns from the preview', async () => {
    await gotoPreviewWithDraft()
    act(() => { screen.getByTestId('preview-start-over').click() })
    // Back on guided (re-mounted from the persisted draft, on the last-typed step),
    // with that pick re-prefilled — the three picks were NOT lost (§11).
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.getByTestId<HTMLInputElement>('guided-name-input').value).toBe(GUIDED_PICKS[2].title)
    expect(screen.getByTestId<HTMLTextAreaElement>('guided-why-input').value).toBe(GUIDED_PICKS[2].whyILikeIt)
  })
})
