import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  HttpError,
  type ApiContext,
  type StartingSituationsResponse,
  type SubmitCharacterResponse,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CharacterNewRoute } from './character-new.tsx'

// The CHARACTER-CREATE entry (MYT-90, D3) — the two-path chooser + the freeform
// path. These tests inject the situations fetch + the submit seams (defaults are
// the real endpoints), render AT the `/campaigns/:id/character/new` URL under a
// memory router (so `useParams` resolves `:id`), and assert: the chooser shows
// both paths; picking freeform reveals the "Who are you?" concept prompt; the
// second prompt's whisper is the chosen situation's invitation; a full submit
// sends BOTH concept + grounding text and lands on the processing seam; a
// too-short answer is blocked with a calm notice at each step; a failed submit
// stays on the freeform path with a calm notice; picking guided opens the guided
// builder (the builder's own flow is covered in guided-path.test.tsx).

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; install a functional in-memory one (mirrors the
// sibling route tests).
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

// The chosen situation's invitation — LLM-authored DATA the grounding step
// renders verbatim as the second prompt's whisper.
const CHOSEN_INVITATION = 'Whose debt is it, and why is it yours to pay?'

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
      invitation: CHOSEN_INVITATION,
    },
  ],
  chosenIndex: 1,
  startingLevel: 3,
}

const SUBMIT_OK: SubmitCharacterResponse = {
  conceptId: 'concept-1',
  status: 'processing',
  jobId: 'job-1',
}

// Well over the 20-char floor the backend body schema enforces.
const CONCEPT = 'A retired toll-clerk who never stopped counting the dead.'
const GROUNDING = 'A debt that was never mine came due on the worst possible night.'
const SHORT = 'too short'

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

interface Overrides {
  fetchSituations?: () => Promise<StartingSituationsResponse>
  submit?: (ctx: ApiContext, campaignId: string, body: unknown) => Promise<SubmitCharacterResponse>
}

function renderRoute(overrides: Overrides = {}): {
  submit: (ctx: ApiContext, campaignId: string, body: unknown) => Promise<SubmitCharacterResponse>
} {
  const fetchSituations = overrides.fetchSituations ?? vi.fn().mockResolvedValue(SITUATIONS)
  const submit = overrides.submit ?? vi.fn().mockResolvedValue(SUBMIT_OK)
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/character/new',
        element: <CharacterNewRoute fetchSituations={fetchSituations} submit={submit} />,
      },
    ],
    { initialEntries: [`/campaigns/${CAMPAIGN_ID}/character/new`] },
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
  return { submit }
}

/** Click the freeform choice in the path chooser. */
function pickFreeform(): void {
  fireEvent.click(within(screen.getByTestId('chooser-freeform')).getByRole('button'))
}

/** Type into the single visible freeform textarea + press its Continue control. */
function answerAndContinue(value: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
  fireEvent.click(within(screen.getByTestId('freeform-prompt')).getByRole('button'))
}

describe('CharacterNewRoute — the path chooser', () => {
  it('renders both creation paths (freeform + guided)', () => {
    renderRoute()
    expect(screen.getByTestId('route-character-new')).toBeDefined()
    expect(screen.getByTestId('chooser-freeform')).toBeDefined()
    expect(screen.getByTestId('chooser-guided')).toBeDefined()
    expect(screen.getByText(i18n.t('characterCreate.chooser.prompt'))).toBeDefined()
  })

  it('renders the guided builder when the guided path is picked', () => {
    renderRoute()
    fireEvent.click(within(screen.getByTestId('chooser-guided')).getByRole('button'))
    // The guided path opens on the option-grid builder, not the freeform prompt.
    expect(screen.getByTestId('guided-builder')).toBeDefined()
    expect(screen.queryByTestId('freeform-prompt')).toBeNull()
  })
})

describe('CharacterNewRoute — the freeform path', () => {
  it('shows the "Who are you?" concept prompt after picking freeform', () => {
    renderRoute()
    pickFreeform()
    expect(screen.getByTestId('freeform-prompt')).toBeDefined()
    expect(
      screen.getByText(i18n.t('characterCreate.freeform.conceptPrompt')),
    ).toBeDefined()
  })

  it("uses the chosen situation's invitation as the grounding prompt's whisper", async () => {
    renderRoute()
    pickFreeform()
    answerAndContinue(CONCEPT)
    // The second step's whisper is DATA from the situation at chosenIndex.
    expect(await screen.findByText(CHOSEN_INVITATION)).toBeDefined()
    expect(
      screen.getByText(i18n.t('characterCreate.freeform.groundingPrompt')),
    ).toBeDefined()
  })

  it('submits BOTH conceptText and situationGroundingText, then lands on the processing seam', async () => {
    const { submit } = renderRoute()
    pickFreeform()
    answerAndContinue(CONCEPT)
    await screen.findByText(CHOSEN_INVITATION)
    answerAndContinue(GROUNDING)
    expect(await screen.findByTestId('character-processing')).toBeDefined()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(testCtx, CAMPAIGN_ID, {
      conceptText: CONCEPT,
      situationGroundingText: GROUNDING,
    })
  })

  it('blocks a too-short concept with a calm notice (and does not advance)', () => {
    const { submit } = renderRoute()
    pickFreeform()
    answerAndContinue(SHORT)
    expect(screen.getByTestId('freeform-notice')).toBeDefined()
    // Still on the concept step — the grounding whisper never appears.
    expect(screen.queryByText(CHOSEN_INVITATION)).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })

  it('blocks a too-short grounding answer with a calm notice (and does not submit)', async () => {
    const { submit } = renderRoute()
    pickFreeform()
    answerAndContinue(CONCEPT)
    await screen.findByText(CHOSEN_INVITATION)
    answerAndContinue(SHORT)
    expect(screen.getByTestId('freeform-notice')).toBeDefined()
    expect(screen.queryByTestId('character-processing')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })

  it('surfaces a calm notice and stays on the freeform path when submit fails', async () => {
    const submit = vi.fn().mockRejectedValue(new HttpError(400, 'Bad Request', 'bad_body'))
    renderRoute({ submit })
    pickFreeform()
    answerAndContinue(CONCEPT)
    await screen.findByText(CHOSEN_INVITATION)
    answerAndContinue(GROUNDING)
    expect(await screen.findByTestId('freeform-notice')).toBeDefined()
    expect(screen.queryByTestId('character-processing')).toBeNull()
  })

  it('falls back to a generic grounding whisper when no situation is chosen', async () => {
    const fetchSituations = vi
      .fn()
      .mockResolvedValue({ ...SITUATIONS, chosenIndex: null })
    renderRoute({ fetchSituations })
    pickFreeform()
    answerAndContinue(CONCEPT)
    expect(
      await screen.findByText(i18n.t('characterCreate.freeform.groundingWhisperFallback')),
    ).toBeDefined()
  })
})
