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
  type WorldGenSnapshot,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { CharacterNewRoute } from './character-new.tsx'

// The CHARACTER-CREATE entry (MYT-90, D3 + the MYT-102 grounding/wiki work) — the
// two-path chooser + the freeform path. These tests inject the situations fetch,
// the submit seam, and the wiki-snapshot seam (defaults are the real endpoints),
// render AT the `/campaigns/:id/character/new` URL under a memory router (so
// `useParams` resolves `:id`), and assert: the chooser shows both paths; picking
// freeform reveals the "Who are you?" concept prompt; the second prompt's whisper
// is the chosen situation's invitation; a full submit sends BOTH concept +
// grounding text and lands on the processing seam (Track B's placeholder); a
// too-short answer is blocked with a calm notice at each step; a failed submit
// stays on the freeform path with a calm notice; picking guided opens the guided
// builder (the builder's own flow is covered in guided-path.test.tsx). The
// situation recap, freeform step signposting, and the creation wiki are the
// MYT-102 additions covered below.

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

// The world snapshot the create-screen wiki browses (MYT-102) — the same
// member-readable projection the reveal wiki fetches. Relationship-bearing (the
// `WorldGenSnapshot` re-type) so the RELATED cross-links populate.
const WIKI_SNAPSHOT: WorldGenSnapshot = {
  entities: [
    { id: 'ent-loc-1', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'ent-npc-1', entityType: 'npc', name: 'Maeris Vale' },
  ],
  facts: [
    { id: 'fact-1', entityId: 'ent-npc-1', topic: 'Role', content: 'Harbourmaster of the Reach.' },
  ],
  entityHierarchy: [],
  relationships: [
    { sourceEntityId: 'ent-npc-1', targetEntityId: 'ent-loc-1', relationshipType: 'harbourmaster_of' },
  ],
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
  // Restore the no-matchMedia default (wide/desktop) for tests that stub none.
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

// jsdom has no matchMedia (the DS hooks then report the wide/desktop regime).
// Install a QUERY-AWARE stub so `useViewportBelowLg` ('(min-width: 1024px)')
// resolves to the viewport under test; every other query stays non-matching.
function mockViewport({ belowLg }: { belowLg: boolean }): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(min-width: 1024px)' ? !belowLg : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

interface Overrides {
  fetchSituations?: () => Promise<StartingSituationsResponse>
  submit?: (ctx: ApiContext, campaignId: string, body: unknown) => Promise<SubmitCharacterResponse>
  fetchSnapshot?: () => Promise<WorldGenSnapshot>
}

function renderRoute(overrides: Overrides = {}): {
  submit: (ctx: ApiContext, campaignId: string, body: unknown) => Promise<SubmitCharacterResponse>
} {
  const fetchSituations = overrides.fetchSituations ?? vi.fn().mockResolvedValue(SITUATIONS)
  const submit = overrides.submit ?? vi.fn().mockResolvedValue(SUBMIT_OK)
  const fetchSnapshot = overrides.fetchSnapshot ?? vi.fn().mockResolvedValue(WIKI_SNAPSHOT)
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/character/new',
        element: (
          <CharacterNewRoute
            fetchSituations={fetchSituations}
            submit={submit}
            fetchSnapshot={fetchSnapshot}
          />
        ),
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

/** Type into the freeform prompt's textarea + press its Continue control. Scoped
 *  WITHIN the prompt: once the wiki snapshot resolves, the side rail's search
 *  input is a second role=textbox on the page. */
function answerAndContinue(value: string): void {
  const prompt = screen.getByTestId('freeform-prompt')
  fireEvent.change(within(prompt).getByRole('textbox'), { target: { value } })
  fireEvent.click(within(prompt).getByRole('button'))
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
    // On success the machine advances to `processing` — Track B's post-submit seam
    // (the committed placeholder line until the D5 loading beat lands there).
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

describe('CharacterNewRoute — the situation recap (MYT-102)', () => {
  it('shows the chosen situation above the freeform concept prompt', async () => {
    renderRoute()
    pickFreeform()
    // The recap renders the chosen situation's DATA verbatim once the fetch lands.
    const recap = await screen.findByTestId('situation-recap')
    expect(recap.textContent).toContain('A debt come due')
    expect(recap.textContent).toContain('The Salt Ledger')
    expect(recap.textContent).toContain('The counting-house wants paying.')
    // Above the prompt: the recap precedes the FreeformPrompt in document order.
    const prompt = screen.getByTestId('freeform-prompt')
    expect(recap.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the recap in view on the grounding step', async () => {
    renderRoute()
    pickFreeform()
    await screen.findByTestId('situation-recap')
    answerAndContinue(CONCEPT)
    await screen.findByText(CHOSEN_INVITATION)
    expect(screen.getByTestId('situation-recap')).toBeDefined()
  })

  it('renders no recap when no situation is chosen', async () => {
    const fetchSituations = vi.fn().mockResolvedValue({ ...SITUATIONS, chosenIndex: null })
    renderRoute({ fetchSituations })
    pickFreeform()
    answerAndContinue(CONCEPT)
    // Settle on the grounding step (the fallback whisper) — still no recap.
    await screen.findByText(i18n.t('characterCreate.freeform.groundingWhisperFallback'))
    expect(screen.queryByTestId('situation-recap')).toBeNull()
  })
})

describe('CharacterNewRoute — freeform step signposting (MYT-102)', () => {
  it('signposts "1 of 2" on the concept step and "2 of 2" on the grounding step', async () => {
    renderRoute()
    pickFreeform()
    expect(screen.getByTestId('freeform-step-indicator').textContent).toBe(
      i18n.t('characterCreate.freeform.stepIndicator', { current: 1, total: 2 }),
    )
    answerAndContinue(CONCEPT)
    await screen.findByText(CHOSEN_INVITATION)
    expect(screen.getByTestId('freeform-step-indicator').textContent).toBe(
      i18n.t('characterCreate.freeform.stepIndicator', { current: 2, total: 2 }),
    )
  })
})

describe('CharacterNewRoute — the world wiki during creation (MYT-102)', () => {
  it('mounts the browsable wiki in the desktop side rail', async () => {
    renderRoute()
    expect(screen.getByTestId('character-new-wiki-rail')).toBeDefined()
    expect(await screen.findByTestId('reveal-wiki')).toBeDefined()
  })

  it('collapses the rail to a slim handle and re-expands it', async () => {
    renderRoute()
    await screen.findByTestId('reveal-wiki')
    fireEvent.click(screen.getByTestId('character-new-wiki-toggle'))
    // Collapsed: the slim handle remains, the panel is gone.
    expect(screen.getByTestId('character-new-wiki-rail')).toBeDefined()
    expect(screen.queryByTestId('reveal-wiki')).toBeNull()
    fireEvent.click(screen.getByTestId('character-new-wiki-toggle'))
    // The model lives in the route (not the rail), so re-expanding is instant.
    expect(screen.getByTestId('reveal-wiki')).toBeDefined()
  })

  it('serves the wiki from the edge-handle drawer on narrow viewports', async () => {
    mockViewport({ belowLg: true })
    renderRoute()
    expect(screen.queryByTestId('character-new-wiki-rail')).toBeNull()
    // The drawer (mount-persistent children) holds the wiki even while closed.
    expect(screen.getByTestId('character-new-wiki-drawer')).toBeDefined()
    expect(await screen.findByTestId('reveal-wiki')).toBeDefined()
  })

  it('shows the calm unavailable line when the snapshot fetch fails', async () => {
    const fetchSnapshot = vi.fn().mockRejectedValue(new HttpError(403, 'Forbidden', 'not_member'))
    renderRoute({ fetchSnapshot })
    expect(await screen.findByText(i18n.t('worldReveal.unavailable'))).toBeDefined()
  })
})
