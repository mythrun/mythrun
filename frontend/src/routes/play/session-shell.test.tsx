import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ConnectionState } from '@mythrun/client-core'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  type ApiContext,
  type KnowledgeCache,
  type SessionSheetState,
  type SessionView,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { SessionShell } from './session-shell.tsx'
import type { PlayKnowledgeHooks } from './knowledge-panel.tsx'

// The dice-moment wiring (MYT-93 T7). The shell subscribes `useRollReveal`, computes
// `buildRevealView(items, state)` per render, and threads the reveal view + resolved
// i18n label bundle into MessageStream. These tests assert the wiring BEHAVIOURALLY
// (not just that the type break is gone): a live skill_check renders a RollCard whose
// turn's outcome prose is BUFFERED until Continue, and a replayed (persisted `seq`)
// card renders already-released with its prose shown. The reveal reducer + card
// rendering are covered in client-core / @mythrun/ui; here we pin the ROUTE seam.

// The DieSpin stepped budget (8 steps × 125ms ≈ 1s) — mirrored so the spin walk below
// is self-describing. Kept in lockstep with DieSpin.tsx.
const SPIN_STEPS = 8
const STEP_MS = 125

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads `localStorage`
// on mount; install a functional in-memory one (mirrors the sibling route tests).
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

// Shell identity props as constants (referenced as expressions, not inline JSX string
// literals — the i18next/no-literal-string rail applies to test files too).
const CAMPAIGN_ID = 'c1'
const SESSION_ID = 's1'
const VIEWER_ID = 'viewer-1'
const DISPLAY_NAME = 'Ada'

const DM_TEXT = 'The lock gives with a soft click, and the strongbox lid lifts.'

/** A LIVE skill_check (no `seq`) — the theatre case: idle → revealed → released. */
const SKILL_CHECK: SessionView['items'][number] = {
  kind: 'skill_check',
  key: 'sc-1',
  turnId: 'T1',
  frame: {
    type: 'skill_check',
    turnId: 'T1',
    characterName: 'Kessa Vurm',
    skill: 'sleight of hand',
    context: 'working the strongbox lock',
    roll: 14,
    roll2: null,
    rollType: 'normal',
    modifier: 2,
    total: 16,
    dc: 12,
    outcomeTier: 'success',
    // The prose seed — NEVER rendered on the card (it would pre-empt the buffer).
    constraint: 'The lock opens; inside is a folded letter.',
  },
}

/** The post-check outcome prose — same turnId, so it is gated behind the card. */
const DM_PROSE: SessionView['items'][number] = {
  kind: 'dm',
  key: 'dm-1',
  turnId: 'T1',
  text: DM_TEXT,
  streaming: false,
}

/** A REPLAYED skill_check (persisted `seq`) — history, no theatre. */
const REPLAYED_SKILL_CHECK: SessionView['items'][number] = {
  ...SKILL_CHECK,
  frame: { ...SKILL_CHECK.frame, seq: 7 },
}

function makeSession(
  items: SessionView['items'],
  connection: ConnectionState = { status: 'connected', attempt: 0 },
  overrides: Partial<SessionView> = {},
): SessionView {
  return {
    items,
    connection,
    thinking: false,
    typingUserIds: [],
    ended: false,
    // myth-atxhx: NO progress signal by default — the honest pre-first-turn state,
    // and the one under which the end affordances must stay absent. Tests that
    // exercise ending pass NEAR_END explicitly.
    progress: null,
    sendMessage: vi.fn(),
    summonDm: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  }
}

// myth-atxhx: the end affordances exist only near the end of a session, so every
// test that exercises ending passes this explicitly (the gate itself is pinned in
// session-progress.test.tsx).
const NEAR_END = 0.85

/** A LIVE long-rest ledger frame (no seq) — the wind-down trigger (myth-lhp99). */
const LONG_REST: SessionView['items'][number] = {
  kind: 'ledger_update',
  key: 'lr-1',
  turnId: 'TR1',
  frame: {
    type: 'ledger_update',
    turnId: 'TR1',
    characterName: 'Kessa Vurm',
    kind: 'rest',
    restType: 'long',
    summary: 'Kessa Vurm finishes a long rest.',
  },
}
/** A short rest — must NOT trigger the wind-down. */
const SHORT_REST: SessionView['items'][number] = {
  ...LONG_REST,
  key: 'sr-1',
  turnId: 'TR2',
  frame: { ...LONG_REST.frame, turnId: 'TR2', restType: 'short', summary: 'Kessa Vurm finishes a short rest.' },
}

/** A fresh TanStack client per render — the shell's mount-time balance
 *  invalidation (myth-q53lj) needs a real provider; tests that assert the
 *  invalidation pass their own client and spy on it. */
function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** Render the shell against an explicit SessionView (lets a test inject `thinking`,
 *  a spy `endSession`, etc.). Mirrors renderShell's provider stack. */
function renderShellSession(session: SessionView, queryClient: QueryClient = makeQueryClient()): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <SessionShell
              ctx={testCtx}
              campaignId={CAMPAIGN_ID}
              sessionId={SESSION_ID}
              viewerUserId={VIEWER_ID}
              displayName={DISPLAY_NAME}
              characterName=""
              party={new Map()}
              reducedMotion={false}
              useLiveSession={() => session}
              knowledgeHooks={KNOWLEDGE_HOOKS}
            />
          </MemoryRouter>
        </I18nextProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

// The MYT-94 knowledge sidebar is now part of the shell; inject calm empty data
// hooks so these dice-focused tests don't drive the real client-core hooks (which
// need an ApiClientProvider). The knowledge composition has its own tests
// (knowledge-panel.test.tsx). A null cache index means the DM prose is NOT
// highlighted — the reveal assertions below are unaffected.
const EMPTY_CACHE: KnowledgeCache = { wiki: null, graph: null, index: null, loading: false, failed: true }
const EMPTY_SHEET: SessionSheetState = {
  sheet: null,
  overlay: { hp: null, maxHp: null, gold: null, conditionLog: [], activeConditions: null },
  loading: false,
  failed: true,
}
const KNOWLEDGE_HOOKS: PlayKnowledgeHooks = { useCache: () => EMPTY_CACHE, useSheet: () => EMPTY_SHEET }

function renderShell(items: SessionView['items'], reducedMotion = false): void {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <SessionShell
              ctx={testCtx}
              campaignId={CAMPAIGN_ID}
              sessionId={SESSION_ID}
              viewerUserId={VIEWER_ID}
              displayName={DISPLAY_NAME}
              characterName=""
              party={new Map()}
              reducedMotion={reducedMotion}
              useLiveSession={() => makeSession(items)}
              knowledgeHooks={KNOWLEDGE_HOOKS}
            />
          </MemoryRouter>
        </I18nextProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
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
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('SessionShell — the dice-moment reveal wiring (MYT-93)', () => {
  it('renders a live skill_check as a RollCard and buffers its outcome prose (gated)', () => {
    renderShell([SKILL_CHECK, DM_PROSE])
    // The card is an in-stream RollCard with a Roll affordance, not a mono system line.
    expect(document.querySelector('[data-roll-card="skill_check"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: i18n.t('play.roll.roll') })).toBeDefined()
    // The constraint (prose seed) is never on the card, and the outcome prose is
    // BUFFERED behind the un-continued card.
    expect(screen.queryByText(SKILL_CHECK.frame.constraint)).toBeNull()
    expect(screen.queryByText(DM_TEXT)).toBeNull()
  })

  it('reveals the server numbers on Roll, then releases the buffered prose on Continue', () => {
    vi.useFakeTimers()
    renderShell([SKILL_CHECK, DM_PROSE])

    // Roll → the local spin runs, lands, and commits the reveal.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.roll.roll') }))
    act(() => {
      vi.advanceTimersByTime(SPIN_STEPS * STEP_MS)
    })

    // Revealed: the die stamps the used natural roll (total − modifier = 14) and the
    // mod→total readout settles — but the outcome prose is STILL gated (Continue-only).
    expect(screen.getByTestId('die-spin-result').textContent).toBe('14')
    expect(screen.getByText('14 + 2 = 16')).toBeDefined()
    expect(screen.queryByText(DM_TEXT)).toBeNull()

    // Continue → the turn drops out of gatedTurnIds → the buffered prose renders.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.roll.continue') }))
    expect(screen.getByText(DM_TEXT)).toBeDefined()
  })

  it('renders a replayed skill_check already released — the receipt, prose shown, no Roll (history)', () => {
    renderShell([REPLAYED_SKILL_CHECK, DM_PROSE])
    // History: the card files as the one-line receipt (myth-twraw), the prose is
    // shown, and there is no Roll theatre.
    expect(screen.getByTestId('roll-receipt').textContent).toContain('14 + 2 = 16')
    expect(screen.getByText(DM_TEXT)).toBeDefined()
    expect(screen.queryByRole('button', { name: i18n.t('play.roll.roll') })).toBeNull()
  })
})

/** Render the shell inside a router carrying a probe at the character-create
 *  target, so the no-character CTA's navigation is observable. */
function renderShellRouted(connection: ConnectionState): void {
  const router = createMemoryRouter(
    [
      {
        path: '/campaigns/:id/play',
        element: (
          <SessionShell
            ctx={testCtx}
            campaignId={CAMPAIGN_ID}
            sessionId={SESSION_ID}
            viewerUserId={VIEWER_ID}
            displayName={DISPLAY_NAME}
            characterName=""
            party={new Map()}
            reducedMotion={false}
            useLiveSession={() => makeSession([DM_PROSE], connection)}
            knowledgeHooks={KNOWLEDGE_HOOKS}
          />
        ),
      },
      { path: '/campaigns/:id/character/new', element: <p data-testid="character-new-probe" /> },
    ],
    { initialEntries: [`/campaigns/${CAMPAIGN_ID}/play`] },
  )
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

describe('SessionShell — the no-character surface (myth-mnik3)', () => {
  it('renders the explicit no-character notice (NOT the transcript) on a failed{no_character} close', () => {
    renderShellRouted({ status: 'failed', attempt: 0, failedReason: 'no_character' })
    expect(screen.getByTestId('play-no-character')).toBeDefined()
    // The live shell + transcript are NOT mounted — the player is not left waiting
    // at a silent table behind a disabled input.
    expect(screen.queryByTestId('session-shell')).toBeNull()
    expect(screen.queryByTestId('message-stream')).toBeNull()
  })

  it('the CTA routes into character creation', () => {
    renderShellRouted({ status: 'failed', attempt: 0, failedReason: 'no_character' })
    fireEvent.click(screen.getByTestId('play-no-character-create'))
    expect(screen.getByTestId('character-new-probe')).toBeDefined()
  })

  it('a terminal failed{denied} still falls through to the live shell (connection line owns it)', () => {
    // Only no_character short-circuits; denied/exhausted keep the shell (its
    // connection line + disabled input already surface those).
    renderShellRouted({ status: 'failed', attempt: 0, failedReason: 'denied' })
    expect(screen.queryByTestId('play-no-character')).toBeNull()
    expect(screen.getByTestId('session-shell')).toBeDefined()
  })
})

describe('SessionShell — session lifecycle + composer gating (myth-lhp99 / myth-dd63v)', () => {
  it('the end-session control confirms (one beat) then calls endSession', () => {
    const endSession = vi.fn()
    renderShellSession(makeSession([DM_PROSE], undefined, { endSession, progress: NEAR_END }))
    // A quiet control is always present; it opens an inline confirm, not a modal.
    fireEvent.click(screen.getByTestId('end-session-open'))
    expect(endSession).not.toHaveBeenCalled() // no fire until confirmed
    fireEvent.click(screen.getByTestId('end-session-do'))
    expect(endSession).toHaveBeenCalledTimes(1)
  })

  it('gates Send while the DM is thinking, with the busy caption (never a silent swallow)', () => {
    renderShellSession(makeSession([DM_PROSE], undefined, { thinking: true }))
    const send = screen.getByRole('button', { name: i18n.t('play.input.send') })
    expect(send.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('session-input-busy').textContent).toBe(i18n.t('play.input.dmBusy'))
  })

  it('myth-xxyo9: the inline confirm borders BOTH affordances and discloses the consequence AT the decision', () => {
    renderShellSession(makeSession([DM_PROSE], undefined, { progress: NEAR_END }))
    fireEvent.click(screen.getByTestId('end-session-open'))
    // "Keep playing" is a real bordered button beside "End session" — two square
    // outline buttons, never a bare mono label next to a bordered one.
    expect(screen.getByTestId('end-session-cancel').className).toContain('border-border-strong')
    expect(screen.getByTestId('end-session-do').className).toContain('border-border-strong')
    // myth-atxhx: the disclosure sits IN the confirm state, before commitment, and
    // it discloses IRREVERSIBILITY — not just the (already-spent) cost.
    expect(screen.getByTestId('end-session-disclosure').textContent).toBe(i18n.t('play.end.disclosure'))
  })

  it('myth-0q8jm: with a check unrolled the caption says the game waits on the PLAYER, never "the DM is writing"', () => {
    // The gated post-check prose is still streaming (invisible) — the run-2 lie.
    const gatedStreaming: SessionView['items'][number] = { ...DM_PROSE, key: 'dm-s', streaming: true }
    renderShellSession(makeSession([SKILL_CHECK, gatedStreaming]))
    expect(screen.getByTestId('session-input-busy').textContent).toBe(i18n.t('play.input.pendingRoll'))
    expect(screen.getByRole('button', { name: i18n.t('play.input.send') }).hasAttribute('disabled')).toBe(true)
  })

  it('myth-0q8jm: once the die is revealed the caption names the real pending act (Continue)', () => {
    vi.useFakeTimers()
    renderShellSession(makeSession([SKILL_CHECK, DM_PROSE]))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.roll.roll') }))
    act(() => {
      vi.advanceTimersByTime(SPIN_STEPS * STEP_MS)
    })
    expect(screen.getByTestId('session-input-busy').textContent).toBe(i18n.t('play.input.pendingContinue'))
    // Continue lifts the gate: no caption, Send live — three components, one state.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.roll.continue') }))
    expect(screen.getByTestId('session-input-busy').textContent).toBe('')
    expect(screen.getByRole('button', { name: i18n.t('play.input.send') }).hasAttribute('disabled')).toBe(false)
  })

  it('myth-svmer: a processed message below an armed card demotes it — no live Continue above newer turns', () => {
    const laterPlayer: SessionView['items'][number] = {
      kind: 'player',
      key: 'p-after',
      turnId: null,
      seq: 9,
      userId: 'u-2',
      displayName: 'Ada',
      characterName: 'Sable',
      text: 'I hold the sliver up to the light.',
      pending: false,
    }
    renderShellSession(makeSession([SKILL_CHECK, DM_PROSE, laterPlayer]))
    // The card renders as the historical receipt: no Roll/Continue (myth-twraw).
    expect(screen.queryByRole('button', { name: i18n.t('play.roll.roll') })).toBeNull()
    expect(screen.queryByRole('button', { name: i18n.t('play.roll.continue') })).toBeNull()
    expect(screen.getByTestId('roll-receipt').textContent).toContain('14 + 2 = 16')
    // Its gate lifted in the same paint: the prose shows and the composer is live.
    expect(screen.getByText(DM_TEXT)).toBeDefined()
    expect(screen.getByRole('button', { name: i18n.t('play.input.send') }).hasAttribute('disabled')).toBe(false)
  })

  it('gates Send while a live DM turn is still streaming', () => {
    const streamingDm: SessionView['items'][number] = { ...DM_PROSE, key: 'dm-s', streaming: true }
    renderShellSession(makeSession([streamingDm]))
    const send = screen.getByRole('button', { name: i18n.t('play.input.send') })
    expect(send.hasAttribute('disabled')).toBe(true)
  })

  it('offers the wind-down on a live long rest; Rest here ends the session', () => {
    const endSession = vi.fn()
    renderShellSession(makeSession([DM_PROSE, LONG_REST], undefined, { endSession, progress: NEAR_END }))
    expect(screen.getByTestId('wind-down-offer')).toBeDefined()
    fireEvent.click(screen.getByTestId('wind-down-rest'))
    expect(endSession).toHaveBeenCalledTimes(1)
  })

  it('a live short rest does NOT offer the wind-down; Keep playing dismisses a long one', () => {
    renderShellSession(makeSession([DM_PROSE, SHORT_REST], undefined, { progress: NEAR_END }))
    expect(screen.queryByTestId('wind-down-offer')).toBeNull()
    cleanup()
    renderShellSession(makeSession([DM_PROSE, LONG_REST], undefined, { progress: NEAR_END }))
    fireEvent.click(screen.getByTestId('wind-down-keep'))
    expect(screen.queryByTestId('wind-down-offer')).toBeNull()
  })
})

describe('SessionShell — the knowledge sidebar (MYT-94)', () => {
  it('mounts the knowledge sidebar beside the transcript (fills MYT-92 placeholder seam)', () => {
    renderShell([DM_PROSE])
    // The real sidebar seam replaces MYT-92's placeholder; the transcript still owns
    // the shell (both mount).
    expect(screen.getByTestId('session-sidebar-seam')).toBeDefined()
    expect(screen.getByTestId('message-stream')).toBeDefined()
    // A null cache index (not-yet-settled projections) leaves DM prose plain — no
    // highlighting is threaded, the enforced-ignorance-safe default.
    expect(screen.getByText(DM_TEXT)).toBeDefined()
  })
})
