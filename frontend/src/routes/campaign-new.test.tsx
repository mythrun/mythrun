import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { render, screen, act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useParams } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  configureGuidedDraft,
  configureStreamingFetch,
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
      // The HOME landing — the fork's exit affordance (ux-run2 myth-80an1)
      // resolves here; its presence proves the flow has a way out.
      { path: '/', element: <div data-testid="route-home-target" /> },
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

// ---------------------------------------------------------------------------
// The guided SYNTHESIS wire (myth-umggn): a streamed SSE POST through the
// client-core StreamingFetch seam, not a fetch MSW can script. Each guided
// test installs its own scripted fake — either a canned script (status +
// frames, ended) or a hand-driven push stream for progressive-render
// assertions. `opens` records the request (url/init) for wire-body asserts.
// ---------------------------------------------------------------------------

interface StreamOpen {
  url: string
  init: { headers: Record<string, string>; signal: AbortSignal; method?: 'POST'; body?: string }
}

const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

/** Canned stream: non-200 yields `errorBody` as JSON; 200 yields `frames` then ends. */
function installSynthStream(script: {
  status?: number
  errorBody?: unknown
  frames?: readonly unknown[]
}): { opens: StreamOpen[] } {
  const opens: StreamOpen[] = []
  configureStreamingFetch((url, init) => {
    opens.push({ url, init })
    const chunks = (async function* (): AsyncGenerator<string> {
      if ((script.status ?? 200) !== 200) {
        yield JSON.stringify(script.errorBody ?? {})
        return
      }
      for (const f of script.frames ?? []) yield await Promise.resolve(sseFrame(f))
    })()
    return Promise.resolve({ status: script.status ?? 200, chunks })
  })
  return { opens }
}

/** Hand-driven stream: the test pushes frames one by one (progressive render). */
function installPushSynthStream(): {
  opens: StreamOpen[]
  push: (payload: unknown) => void
  end: () => void
} {
  const opens: StreamOpen[] = []
  const queue: string[] = []
  let done = false
  let wake: (() => void) | null = null
  const notify = (): void => {
    wake?.()
    wake = null
  }
  const chunks: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) yield next
        if (done) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
  configureStreamingFetch((url, init) => {
    opens.push({ url, init })
    return Promise.resolve({ status: 200, chunks })
  })
  return {
    opens,
    push: (payload) => {
      queue.push(sseFrame(payload))
      notify()
    },
    end: () => {
      done = true
      notify()
    },
  }
}

/** Walk fork → freeform (the screen every freeform case starts from). */
function gotoFreeform(): void {
  renderRoute()
  act(() => { screen.getByText(ideaTitle()).click() })
}

/** myth-6t06f: fork → freeform → type a concept → fire the synthesis. The
 *  freeform path now opens the SAME stream the brainstorm path opens, so the
 *  scripted-frame harness serves both. */
function synthesizeFreeform(
  frames: readonly unknown[],
  concept = 'A drowned cathedral city the tide never fully leaves.',
): { opens: StreamOpen[] } {
  const installed = installSynthStream({ frames })
  gotoFreeform()
  fireEvent.change(screen.getByTestId('freeform-input'), { target: { value: concept } })
  act(() => { screen.getByTestId('freeform-draft').click() })
  return installed
}

describe('CampaignNewRoute', () => {
  it('renders the fork screen with both choices (i18n keys resolved)', () => {
    renderRoute()
    expect(screen.getByTestId('route-campaign-new')).toBeDefined()
    expect(screen.getByTestId('screen-fork')).toBeDefined()
    expect(screen.getByText(ideaTitle())).toBeDefined()
    expect(screen.getByText(loveTitle())).toBeDefined()
    // The fork has an EXIT (ux-run2 myth-80an1: "the only escape was guessing
    // that the logo goes home") — the quiet Back leads home.
    expect(screen.getByTestId('campaign-new-back')).toBeDefined()
  })

  it('the fork Back exits the flow to home (the flow root has a named way out)', () => {
    renderRoute()
    act(() => { screen.getByTestId('campaign-new-back').click() })
    expect(screen.getByTestId('route-home-target')).toBeDefined()
  })

  it('labels the wizard-level top exit "Leave brainstorm" on guided (one Back, one meaning)', () => {
    renderRoute()
    act(() => { screen.getByText(loveTitle()).click() })
    // ux-run2 myth-80an1: on step 3 the top control and the step-level "← Back"
    // beside Next were IDENTICAL twins with different destinations. The top
    // affordance now says what it does; the step Back stays the only "Back".
    expect(screen.getByTestId('campaign-new-back').textContent).toBe(
      i18n.t('campaignNew.guided.leave'),
    )
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
    // Back on the fork it reads as the plain Back again (the home exit).
    expect(screen.getByTestId('campaign-new-back').textContent).toBe(i18n.t('back'))
  })
})

describe('CampaignNewRoute freeform screen', () => {
  // The primary drafts a proposal since myth-6t06f — it no longer "begins" a
  // world, and the testid says so.
  const begin = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('freeform-draft')
  const typeConcept = (value: string): void => {
    fireEvent.change(screen.getByTestId('freeform-input'), { target: { value } })
  }

  it('keeps the primary disabled under 20 chars and enables it at or above 20', () => {
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

  // myth-5fi4q — the player's typed world concept survives a reload, exactly as
  // the guided sibling's picks do. Player words are never lost.
  it('restores the typed concept after a reload', () => {
    gotoFreeform()
    typeConcept('A drowned archive city where the tides read the books')
    // A reload: the whole tree goes away and comes back on the flow root.
    cleanup()
    gotoFreeform()
    expect(screen.getByTestId<HTMLTextAreaElement>('freeform-input').value).toBe(
      'A drowned archive city where the tides read the books',
    )
  })

  it('drops the persisted concept once the campaign is actually created', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json({ campaignId: 'camp-drafted' }, { status: 201 }),
      ),
    )
    synthesizeFreeform([
      { type: 'complete', previewId: 'p-ff', title: 'The Low Water', concept: 'A drowned cathedral city.' },
    ])
    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
    act(() => { screen.getByTestId('preview-begin').click() })
    await screen.findByTestId('route-campaign-target')
    cleanup()
    gotoFreeform()
    expect(screen.getByTestId<HTMLTextAreaElement>('freeform-input').value).toBe('')
  })

  // myth-6t06f: the primary no longer buys a world. It posts the player's own
  // concept as the SYNTHESIS body — the same stream the brainstorm path opens —
  // and the flow lands on the proposal checkpoint, not on a generating campaign.
  it('sends the concept to the synthesis stream and lands on the proposal, not on generation', async () => {
    const concept = 'A drowned cathedral city the tide never fully leaves.'
    const { opens } = synthesizeFreeform(
      [
        { type: 'delta', text: 'A drowned cathedral city ' },
        { type: 'complete', previewId: 'p-ff', title: 'The Low Water', concept },
      ],
      concept,
    )

    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
    // The wire body is the freeform proposal shape — the concept, nothing else.
    expect(opens[0]?.url).toBe(`${BASE_URL}/api/campaigns/synthesize-preview/stream`)
    expect(JSON.parse(opens[0]?.init.body ?? '{}')).toEqual({ concept })
    // Nothing was committed: no campaign, no navigation.
    expect(screen.queryByTestId('route-campaign-target')).toBeNull()
  })

  it('a double-click opens exactly ONE synthesis stream — no double burn', async () => {
    const { opens } = installSynthStream({
      frames: [{ type: 'complete', previewId: 'p-ff', title: 'The Low Water', concept: 'A drowned city.' }],
    })
    gotoFreeform()
    typeConcept('A drowned cathedral city the tide never fully leaves.')
    act(() => {
      begin().click()
      begin().click()
    })
    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
    expect(opens).toHaveLength(1)
  })

  // The gate verdict is now a terminal FRAME, not a 422 on the commit: it routes
  // to the shared rejection screen, where the judged text is the player's own
  // words and "adjust it yourself" hands them straight back.
  it('routes a gate rejection to the rejection screen carrying the player own words', async () => {
    const concept = 'A drowned cathedral city the tide never fully leaves.'
    synthesizeFreeform(
      [
        {
          type: 'rejected',
          code: 'concept_rejected',
          reason: 'inappropriate',
          rejectionMessage: 'That concept crosses a line.',
          synthesizedConcept: concept,
        },
      ],
      concept,
    )

    await waitFor(() => { expect(screen.getByTestId('screen-rejection')).toBeDefined() })
    expect(screen.getByTestId('rejection-message').textContent).toBe('That concept crosses a line.')
    expect(screen.getByTestId('rejection-concept').textContent).toBe(concept)
    // Their own paragraph comes back into the field, editable.
    act(() => { screen.getByTestId('rejection-edit-freeform').click() })
    expect(screen.getByTestId<HTMLTextAreaElement>('freeform-input').value).toBe(concept)
  })

  it('shows a calm inline retry notice on a 503 OPEN, without leaving the freeform screen', async () => {
    installSynthStream({ status: 503, errorBody: { code: 'llm_upstream_unavailable' } })
    gotoFreeform()
    typeConcept('A drowned cathedral city the tide never fully leaves.')
    act(() => { begin().click() })

    await waitFor(() => { expect(screen.getByTestId('freeform-notice')).toBeDefined() })
    expect(screen.getByTestId('freeform-notice').textContent).toBe(
      i18n.t('campaignNew.freeform.retry'),
    )
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
    expect(screen.queryByTestId('screen-synthesizing')).toBeNull()
    // The action re-enables so the player can retry.
    expect(begin().disabled).toBe(false)
  })

  it('switches to the guided path when the quiet switch line is pressed', () => {
    gotoFreeform()
    act(() => { within(screen.getByTestId('freeform-switch')).getByRole('button').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
  })
})

describe('CampaignNewRoute guided screen', () => {
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

  it('scaffolds the blank page: an example placeholder + a shape hint wired to the why field', () => {
    gotoGuided()
    // ux-run2 myth-exobi: the story field carries one evocative real title as a
    // faint placeholder, and a single mono hint under the why field says what
    // shape of answer is plenty — wired via aria-describedby.
    expect(nameInput().placeholder).toBe(i18n.t('campaignNew.guided.titlePlaceholder'))
    const hint = screen.getByText(i18n.t('campaignNew.guided.whyHint'))
    expect(hint.id).toBeTruthy()
    expect(whyInput().getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('advancing is sequence-aware: varied questions + settled picks echoed above (no data-loss beat)', () => {
    gotoGuided()
    // Step 1 asks with the protected opening copy.
    expect(screen.getByText(i18n.t('campaignNew.guided.nameQuestion.one'))).toBeDefined()
    expect(screen.queryByTestId('guided-settled-1')).toBeNull()
    typePick(PICKS[0].title, PICKS[0].whyILikeIt)
    act(() => { advanceBtn().click() })
    // ux-run2 myth-tf60g: step 2 must NOT be a pixel-repeat over emptied fields —
    // the question re-phrases for a SECOND story and step 1's answer stays
    // on-screen as a settled ledger row.
    expect(screen.getByText(i18n.t('campaignNew.guided.nameQuestion.two'))).toBeDefined()
    expect(screen.getByTestId('guided-settled-1').textContent).toContain(PICKS[0].title)
    expect(nameInput().value).toBe('')
    typePick(PICKS[1].title, PICKS[1].whyILikeIt)
    act(() => { advanceBtn().click() })
    // Step 3: the terse closer + both settled stories in the ledger.
    expect(screen.getByText(i18n.t('campaignNew.guided.nameQuestion.three'))).toBeDefined()
    expect(screen.getByTestId('guided-settled-1').textContent).toContain(PICKS[0].title)
    expect(screen.getByTestId('guided-settled-2').textContent).toContain(PICKS[1].title)
  })

  it('offers the escape hatch on EVERY step, not just step one', () => {
    gotoGuided()
    typePick(PICKS[0].title, PICKS[0].whyILikeIt)
    act(() => { advanceBtn().click() })
    // ux-run2 myth-vjl7d: "if the hatch is worth offering, offer it on every
    // step" — and it still switches to freeform mid-wizard.
    const hatch = screen.getByTestId('guided-switch')
    act(() => { within(hatch).getByRole('button').click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
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

  it('streams the brief live: text arrives progressively, then the completed brief lands on preview', async () => {
    const { opens, push } = installPushSynthStream()
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    // The 200 head advances the flow to the SYNTHESIZING screen (no dump-wait).
    await waitFor(() => {
      expect(screen.getByTestId('screen-synthesizing')).toBeDefined()
    })
    // The wire request is a streamed POST of exactly the three picks.
    expect(opens[0]?.url).toBe(`${BASE_URL}/api/campaigns/synthesize-preview/stream`)
    expect(opens[0]?.init.method).toBe('POST')
    expect(JSON.parse(opens[0]?.init.body ?? '')).toEqual({ picks: PICKS })

    // First delta: the prose renders MID-STREAM, caret up, no preview yet.
    push({ type: 'delta', text: 'A drowned cathedral ' })
    await waitFor(() => {
      expect(screen.getByTestId('synthesizing-prose').textContent).toContain(
        'A drowned cathedral ',
      )
    })
    expect(document.querySelector('[data-streaming-caret]')).not.toBeNull()
    expect(screen.queryByTestId('screen-preview')).toBeNull()

    // Second delta grows the same paragraph.
    push({ type: 'delta', text: 'city.' })
    await waitFor(() => {
      expect(screen.getByTestId('synthesizing-prose').textContent).toContain(
        'A drowned cathedral city.',
      )
    })

    // The terminal complete lands the flow on preview with the SAME contract
    // payload the synchronous route produced (previewId + concept).
    push({ type: 'complete', previewId: 'p-1', concept: 'A drowned cathedral city.' })
    await waitFor(() => {
      expect(screen.getByTestId('screen-preview')).toBeDefined()
    })
    expect(screen.getByTestId('preview-concept').textContent).toBe('A drowned cathedral city.')

    // The synthesizing beat is a transition, not history: back → the guided picks.
    act(() => { screen.getByTestId('campaign-new-back').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.queryByTestId('screen-synthesizing')).toBeNull()
  })

  it('routes a streamed gate rejection to the rejection state (the streamed text resolves there)', async () => {
    installSynthStream({
      frames: [
        { type: 'delta', text: 'A near-clone concept.' },
        {
          type: 'rejected',
          code: 'concept_rejected',
          reason: 'clone_intent',
          rejectionMessage: 'Too close to an existing world.',
          synthesizedConcept: 'A near-clone concept.',
        },
      ],
    })
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('screen-rejection')).toBeDefined()
    })
    // The text the player watched arrive is the judged concept on this screen.
    expect(screen.getByTestId('rejection-concept').textContent).toBe('A near-clone concept.')
    expect(screen.queryByTestId('screen-guided')).toBeNull()
    expect(screen.queryByTestId('screen-synthesizing')).toBeNull()
  })

  it('shows a calm inline retry notice on a 503 OPEN, without leaving the guided screen', async () => {
    installSynthStream({ status: 503, errorBody: { code: 'llm_upstream_unavailable' } })
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('guided-notice')).toBeDefined()
    })
    // Stayed on guided; the action re-enables so the player can retry.
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.queryByTestId('screen-synthesizing')).toBeNull()
    expect(advanceBtn().disabled).toBe(false)
  })

  it('routes a mid-stream content_filtered to the TERMINAL rejection, not a retry notice', async () => {
    installSynthStream({
      frames: [
        { type: 'delta', text: 'Half a br' },
        { type: 'error', code: 'content_filtered' },
      ],
    })
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

  it('an interrupted stream keeps the halted text with a calm notice; try again returns to guided', async () => {
    // Deltas then a bare stream end — no terminal frame (wifi drop / crash).
    installSynthStream({ frames: [{ type: 'delta', text: 'Half a brief that stopp' }] })
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })

    await waitFor(() => {
      expect(screen.getByTestId('synthesizing-failed')).toBeDefined()
    })
    // Failure honesty: the halted partial STAYS on the page, caret down.
    expect(screen.getByTestId('synthesizing-prose').textContent).toContain(
      'Half a brief that stopp',
    )
    expect(document.querySelector('[data-streaming-caret]')).toBeNull()

    // The quiet try-again returns to the guided picks. (Pick re-prefill rides
    // the §11 draft seam, exercised in the draft-persistence describe below —
    // unconfigured here, so only the screen transition is asserted.)
    act(() => { screen.getByTestId('synthesizing-retry').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.queryByTestId('screen-synthesizing')).toBeNull()
  })

  it('backing out mid-stream aborts the request (the Sonnet burn stops)', async () => {
    const { opens, push } = installPushSynthStream()
    gotoGuided()
    fillAllPicks()
    act(() => { advanceBtn().click() })
    await waitFor(() => {
      expect(screen.getByTestId('screen-synthesizing')).toBeDefined()
    })
    push({ type: 'delta', text: 'A half-written ' })
    await waitFor(() => {
      expect(screen.getByTestId('synthesizing-prose').textContent).toContain('A half-written ')
    })

    act(() => { screen.getByTestId('campaign-new-back').click() })
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(opens[0]?.init.signal.aborted).toBe(true)
  })

  it('switches to the freeform path from the quiet switch line', () => {
    gotoGuided()
    act(() => { within(screen.getByTestId('guided-switch')).getByRole('button').click() })
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
  })
})

// Shared guided-walk for the preview + rejection blocks: install the scripted
// synthesis STREAM (myth-umggn), then fork → guided → fill the three picks →
// fire the final synthesize. The caller waits for whichever screen the
// script's terminal frame lands on.
const GUIDED_PICKS = [
  { title: 'Dark Souls', whyILikeIt: 'the oppressive melancholy' },
  { title: 'Dune', whyILikeIt: 'ecology as destiny' },
  { title: 'Annihilation', whyILikeIt: 'the shimmer' },
] as const

function synthesizeGuided(frames: readonly unknown[]): void {
  installSynthStream({ frames })
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
  const TITLE = 'The Low Water Mark'

  /** Walk fork → guided → streamed synthesize (complete) → preview, carrying `concept`/`previewId`. */
  async function gotoPreview(concept = CONCEPT, previewId = 'p-1'): Promise<void> {
    synthesizeGuided([
      { type: 'delta', text: concept },
      { type: 'complete', previewId, title: TITLE, concept },
    ])
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
    // ux-run2 myth-ia9v2: a compact keep-pair sits ABOVE the prose too, so the
    // first viewport already shows a decision exists; the commitment cost is
    // disclosed under the primary (myth-fca4y).
    expect(screen.getByTestId('preview-begin-top')).toBeDefined()
    expect(screen.getByText(i18n.t('campaignNew.preview.cost'))).toBeDefined()
  })

  // ux-run2 myth-8u3h3: the weave acknowledges what it wove — the player's own
  // three named stories as a quiet attribution line under the eyebrow. Read from
  // the guided draft (which survives synthesize → preview), so the line needs a
  // configured store; without one it simply doesn't render (the test below).
  // myth-z3icr: the proposal HEADLINES the world's name. It arrives on the wire
  // (the synthesize stage emits it) — the page never mines it out of the prose,
  // which would be a ZFC violation.
  it("headlines the world's name from the wire", async () => {
    await gotoPreview()
    expect(screen.getByTestId('preview-title').textContent).toBe(TITLE)
    // A real heading, not a styled line of prose.
    expect(screen.getByTestId('preview-title').tagName).toBe('H1')
  })

  it("re-headlines the revised name after a rework", async () => {
    const revised = 'A revised tidal city, now watched over by a living lighthouse.'
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/p-1/rework`, () =>
        HttpResponse.json(
          { previewId: 'p-1', title: 'The Living Lamp', concept: revised },
          { status: 200 },
        ),
      ),
    )
    await gotoPreview()
    act(() => { screen.getByTestId('preview-ask-change').click() })
    fireEvent.change(screen.getByTestId('preview-change-input'), {
      target: { value: 'make the lighthouse alive' },
    })
    act(() => { screen.getByTestId('preview-rework').click() })

    await waitFor(() => {
      expect(screen.getByTestId('preview-title').textContent).toBe('The Living Lamp')
    })
  })

  it('renders the "Woven from" attribution line from the guided picks', async () => {
    configureGuidedDraft(makeDraftStore())
    try {
      await gotoPreview()
      expect(screen.getByTestId('preview-woven-from').textContent).toBe(
        i18n.t('campaignNew.preview.wovenFrom', { sources: 'Dark Souls · Dune · Annihilation' }),
      )
    } finally {
      configureGuidedDraft(null)
    }
  })

  it('omits the attribution line when no draft is readable', async () => {
    await gotoPreview()
    expect(screen.queryByTestId('preview-woven-from')).toBeNull()
  })

  it('renders the concept in PARAGRAPHS at its blank-line seams (no wall of text)', async () => {
    const threePart = 'The archive drowns twice a day.\n\nThe Ledgermen tax the tide.\n\nYou begin at the low-water mark.'
    await gotoPreview(threePart)
    const prose = screen.getByTestId('preview-concept')
    const paragraphs = prose.querySelectorAll('p')
    expect(paragraphs).toHaveLength(3)
    expect(paragraphs[0]?.textContent).toBe('The archive drowns twice a day.')
    expect(paragraphs[2]?.textContent).toBe('You begin at the low-water mark.')
  })

  it('the top compact Begin commits exactly like the main one', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json({ campaignId: 'c-top-1' }, { status: 201 }),
      ),
    )
    await gotoPreview()
    act(() => { screen.getByTestId('preview-begin-top').click() })
    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-target').textContent).toBe('c-top-1')
    })
  })

  it('Start over is a TWO-STEP confirm: the row swaps in place; Keep it declines', async () => {
    await gotoPreview()
    // First activation never discards — the row swaps to the inline confirm
    // (ux-run2 myth-fca4y: "meant to commit, restarted instead" is the one
    // error this screen must never permit).
    act(() => { screen.getByTestId('preview-start-over').click() })
    expect(screen.getByTestId('screen-preview')).toBeDefined()
    expect(screen.getByText(i18n.t('campaignNew.preview.startOverConfirm'))).toBeDefined()
    // The normal actions are swapped out while confirming.
    expect(screen.queryByTestId('preview-begin')).toBeNull()
    // Declining restores the action row with the draft intact.
    act(() => { screen.getByTestId('preview-start-over-keep').click() })
    expect(screen.getByTestId('preview-begin')).toBeDefined()
    expect(screen.getByTestId('screen-preview')).toBeDefined()
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
    const REVISED_TITLE = 'The Living Lamp'
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/p-1/rework`, () =>
        HttpResponse.json({ previewId: 'p-1', title: REVISED_TITLE, concept: revised }, { status: 200 }),
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

  it('returns to the guided picks on a CONFIRMED Start over', async () => {
    await gotoPreview()
    act(() => { screen.getByTestId('preview-start-over').click() })
    act(() => { screen.getByTestId('preview-start-over-yes').click() })
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

// myth-6t06f: the proposal checkpoint reached from the FREEFORM path. The screen
// is the same one the brainstorm path lands on — these cases pin the two things
// that are NOT the same: where its exits lead, and what it may credit the weave
// to.
describe('CampaignNewRoute proposal from the freeform path', () => {
  const CONCEPT = 'A drowned cathedral city the tide never fully leaves.'

  async function gotoFreeformProposal(): Promise<void> {
    synthesizeFreeform(
      [
        { type: 'delta', text: CONCEPT },
        { type: 'complete', previewId: 'p-ff', title: 'The Low Water', concept: CONCEPT },
      ],
      CONCEPT,
    )
    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
  }

  it('headlines the name and renders the proposal prose', async () => {
    await gotoFreeformProposal()
    expect(screen.getByTestId('preview-title').textContent).toBe('The Low Water')
    expect(screen.getByTestId('preview-concept').textContent).toBe(CONCEPT)
  })

  // The bead's explicit ask: the "Adjust something" loop must work for a
  // freeform-originated proposal, not just a brainstorm-originated one.
  it('runs the adjust-something loop and spends the single change', async () => {
    const revised = 'A revised drowned city, now lit from beneath.'
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/p-ff/rework`, () =>
        HttpResponse.json(
          { previewId: 'p-ff', title: 'The Under-Light', concept: revised },
          { status: 200 },
        ),
      ),
    )
    await gotoFreeformProposal()
    act(() => { screen.getByTestId('preview-ask-change').click() })
    fireEvent.change(screen.getByTestId('preview-change-input'), {
      target: { value: 'light it from beneath' },
    })
    act(() => { screen.getByTestId('preview-rework').click() })

    await waitFor(() => {
      expect(screen.getByTestId('preview-concept').textContent).toBe(revised)
    })
    expect(screen.getByTestId('preview-title').textContent).toBe('The Under-Light')
    // The one change is spent: Begin is the only action left.
    expect(screen.getByTestId('preview-change-spent')).toBeDefined()
    expect(screen.queryByTestId('preview-ask-change')).toBeNull()
  })

  it('commits the parked proposal by previewId, exactly like the brainstorm path', async () => {
    let capturedBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ campaignId: 'c-ff-1' }, { status: 201 })
      }),
    )
    await gotoFreeformProposal()
    act(() => { screen.getByTestId('preview-begin').click() })

    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-target').textContent).toBe('c-ff-1')
    })
    // No concept text on the wire — the server already holds the gated proposal.
    expect(capturedBody).toEqual({
      world: { kind: 'new', source: { mode: 'guided', previewId: 'p-ff' } },
    })
  })

  it('returns to FREEFORM on a confirmed Start over, with the concept intact', async () => {
    await gotoFreeformProposal()
    act(() => { screen.getByTestId('preview-start-over').click() })
    act(() => { screen.getByTestId('preview-start-over-yes').click() })
    // Their own words, not the brainstorm picks (which is where a
    // path-blind Start over would have dumped them).
    expect(screen.getByTestId('screen-freeform')).toBeDefined()
    expect(screen.getByTestId<HTMLTextAreaElement>('freeform-input').value).toBe(CONCEPT)
    expect(screen.queryByTestId('screen-guided')).toBeNull()
  })

  it('returns to FREEFORM when the commit reports the proposal expired (410)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json({ code: 'preview_expired' }, { status: 410 }),
      ),
    )
    await gotoFreeformProposal()
    act(() => { screen.getByTestId('preview-begin').click() })

    await waitFor(() => { expect(screen.getByTestId('screen-freeform')).toBeDefined() })
    expect(screen.queryByTestId('screen-preview')).toBeNull()
  })

  // ux-run2 myth-8u3h3's credit line is true of a WEAVE only. A freeform
  // proposal was woven from the paragraph the player just wrote — and a stale
  // brainstorm draft in the same session would otherwise credit it to three
  // stories they never chose for this world.
  it('never shows the "Woven from" credit, even with a brainstorm draft in storage', async () => {
    configureGuidedDraft(makeDraftStore())
    try {
      // Leave a real brainstorm draft behind, then take the freeform path.
      synthesizeGuided([{ type: 'delta', text: 'unused' }])
      cleanup()
      expect(readGuidedDraft()?.picks).toEqual(GUIDED_PICKS)

      await gotoFreeformProposal()
      expect(screen.queryByTestId('preview-woven-from')).toBeNull()
    } finally {
      configureGuidedDraft(null)
    }
  })
})

describe('CampaignNewRoute rejection screen', () => {
  /** Walk fork → guided → streamed synthesize (gate rejection) → the rejection screen. */
  async function gotoRejection(): Promise<void> {
    synthesizeGuided([
      { type: 'delta', text: 'A near-clone concept.' },
      {
        type: 'rejected',
        code: 'concept_rejected',
        reason: 'clone_intent',
        rejectionMessage: 'Too close to an existing world.',
        synthesizedConcept: 'A near-clone concept.',
      },
    ])
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
    synthesizeGuided([
      { type: 'delta', text: 'A synthesized concept.' },
      { type: 'complete', previewId: 'p-1', title: 'The Synthesized Coast', concept: 'A synthesized concept.' },
    ])
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
    act(() => { screen.getByTestId('preview-start-over-yes').click() })
    // Back on guided (re-mounted from the persisted draft, on the last-typed step),
    // with that pick re-prefilled — the three picks were NOT lost (§11).
    expect(screen.getByTestId('screen-guided')).toBeDefined()
    expect(screen.getByTestId<HTMLInputElement>('guided-name-input').value).toBe(GUIDED_PICKS[2].title)
    expect(screen.getByTestId<HTMLTextAreaElement>('guided-why-input').value).toBe(GUIDED_PICKS[2].whyILikeIt)
  })

  it('clears the guided draft when the draft is committed via the FREEFORM path', async () => {
    // A guided draft can commit WITHOUT the guided preview's Begin: guided-rejection
    // → "edit as freeform" → freeform commit routes through FreeformScreen.onCommitted.
    // The clear lives in toCampaign, so this path drops the draft too (no leak).
    synthesizeGuided([
      {
        type: 'rejected',
        code: 'concept_rejected',
        reason: 'clone_intent',
        rejectionMessage: 'Too close to an existing world.',
        synthesizedConcept: 'A near-clone concept.',
      },
    ])
    await waitFor(() => { expect(screen.getByTestId('screen-rejection')).toBeDefined() })
    // The guided picks were persisted while typing — the draft is present here.
    expect(readGuidedDraft()?.picks).toEqual(GUIDED_PICKS)

    // Drop into freeform (pre-filled with the judged concept, ≥ 20 chars → the
    // primary is enabled). Since myth-6t06f that primary drafts a PROPOSAL, so
    // the commit happens one screen later — the clear still has to fire.
    act(() => { screen.getByTestId('rejection-edit-freeform').click() })
    installSynthStream({
      frames: [
        { type: 'complete', previewId: 'p-ff', title: 'The Near Clone', concept: 'A near-clone concept.' },
      ],
    })
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, () =>
        HttpResponse.json({ campaignId: 'c-freeform-1' }, { status: 201 }),
      ),
    )
    act(() => { screen.getByTestId('freeform-draft').click() })
    await waitFor(() => { expect(screen.getByTestId('screen-preview')).toBeDefined() })
    act(() => { screen.getByTestId('preview-begin').click() })

    await waitFor(() => {
      expect(screen.getByTestId('route-campaign-target').textContent).toBe('c-freeform-1')
    })
    // The freeform commit cleared the leaked guided draft (idempotent clear in toCampaign).
    expect(readGuidedDraft()).toBeNull()
  })
})
