import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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

// The ux-run3 play-polish route seams, split from session-shell.test.tsx (the
// 400-line module convention — same harness pattern as the sibling suites):
//   • myth-q53lj — the mount-time billing-balance invalidation (debit-at-start
//     freshness: the header counter must agree with the past-tense credit line).
//   • myth-twraw — a released roll card settles as a receipt in its CAUSAL slot.
//   • myth-1msig — the @dm exchange wraps in the marked table-talk frame.
//   • myth-em6bg — the labeled off-live-edge jump pill (wired i18n labels).
//   • myth-88lmb — the swept end transition: one farewell signal, no stale
//     confirm, an inert quiet composer; the credit line under the question.

// The DieSpin stepped budget — kept in lockstep with DieSpin.tsx (mirrors the
// sibling suite).
const SPIN_STEPS = 8
const STEP_MS = 125

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; install a functional in-memory one.
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

function makeSession(
  items: SessionView['items'],
  overrides: Partial<SessionView> = {},
): SessionView {
  return {
    items,
    connection: { status: 'connected', attempt: 0 },
    thinking: false,
    typingUserIds: [],
    ended: false,
    sendMessage: vi.fn(),
    summonDm: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  }
}

// Calm empty knowledge hooks (the sidebar composition has its own tests).
const EMPTY_CACHE: KnowledgeCache = { wiki: null, graph: null, index: null, loading: false, failed: true }
const EMPTY_SHEET: SessionSheetState = {
  sheet: null,
  overlay: { hp: null, maxHp: null, gold: null, conditionLog: [] },
  loading: false,
  failed: true,
}
const KNOWLEDGE_HOOKS: PlayKnowledgeHooks = { useCache: () => EMPTY_CACHE, useSheet: () => EMPTY_SHEET }

/** A fresh TanStack client per render — the shell's mount-time balance
 *  invalidation (myth-q53lj) needs a real provider; the invalidation test passes
 *  its own client and spies on it. */
function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderShell(session: SessionView, queryClient: QueryClient = makeQueryClient()): void {
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

describe('SessionShell — ux-run3 play polish', () => {
  it('myth-q53lj: invalidates the shared billing balance on mount (debit-at-start freshness)', () => {
    const client = makeQueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderShell(makeSession([DM_PROSE]), client)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['billing', 'balance'] })
  })

  it('myth-twraw: a released card settles as a receipt in its CAUSAL slot — before its own prose', () => {
    // The observed live order: the FT streamed the prose BEFORE its roll tool
    // call, so the card arrived after the prose it caused. On release, the
    // receipt must file ahead of the prose in the durable transcript.
    vi.useFakeTimers()
    renderShell(makeSession([DM_PROSE, SKILL_CHECK]))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.roll.roll') }))
    act(() => {
      vi.advanceTimersByTime(SPIN_STEPS * STEP_MS)
    })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('play.roll.continue') }))
    const receipt = screen.getByTestId('roll-receipt')
    const prose = screen.getByText(DM_TEXT)
    // The receipt PRECEDES the outcome prose in document order (cause before effect).
    expect(receipt.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('myth-1msig: an @dm exchange wraps in the table-talk frame with the question attributed inside', () => {
    const ask: SessionView['items'][number] = {
      kind: 'player',
      key: 'q-1',
      turnId: null,
      seq: 8,
      userId: VIEWER_ID,
      displayName: DISPLAY_NAME,
      characterName: 'Kessa Vurm',
      text: '@dm does Kessa know what the key opens?',
      pending: false,
    }
    const answer: SessionView['items'][number] = {
      kind: 'dm',
      key: 'a-1',
      turnId: 'TT1',
      text: 'Not common knowledge at her tier. Back to you.',
      streaming: false,
    }
    renderShell(makeSession([ask, answer]))
    const frame = screen.getByRole('note')
    expect(frame.hasAttribute('data-table-talk')).toBe(true)
    expect(frame.textContent).toContain(i18n.t('play.tableTalk.label'))
    // The record keeps the attributed Q with the A, inside one marked block.
    expect(frame.textContent).toContain(ask.text)
    expect(frame.textContent).toContain('Kessa Vurm')
    expect(frame.textContent).toContain(answer.text)
  })

  it('myth-em6bg: scrolled off the live edge, the labeled jump pill appears (wired labels)', () => {
    renderShell(makeSession([DM_PROSE]))
    const scroller = screen.getByTestId('message-stream-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: i18n.t('play.stream.jump') })).toBeDefined()
  })

  it('myth-88lmb: confirming the end sweeps the transition — one farewell signal, swept confirm, inert composer', () => {
    const endSession = vi.fn()
    renderShell(makeSession([DM_PROSE], { endSession, thinking: true }))
    fireEvent.click(screen.getByTestId('end-session-open'))
    fireEvent.click(screen.getByTestId('end-session-do'))
    expect(endSession).toHaveBeenCalledTimes(1)
    // The confirm block (and the whole control) is SWEPT, never left greyed.
    expect(screen.queryByTestId('end-session-confirm')).toBeNull()
    expect(screen.queryByTestId('end-session-open')).toBeNull()
    // ONE signal, at the live edge, in the farewell voice — the generic turn
    // indicator is replaced, not doubled.
    expect(screen.getByText(i18n.t('play.end.closing'))).toBeDefined()
    expect(screen.queryByText(i18n.t('play.thinking.dm'))).toBeNull()
    // The composer stops soliciting moves: inert field, quiet placeholder, no
    // duelling "Ending…" caption.
    const field = screen.getByRole('textbox')
    expect(field.hasAttribute('disabled')).toBe(true)
    expect(field.hasAttribute('placeholder')).toBe(false)
    expect(screen.getByTestId('session-input-busy').textContent).toBe('')
  })

  it('myth-88lmb: the credit disclosure sits under the QUESTION line, before the buttons', () => {
    renderShell(makeSession([DM_PROSE]))
    fireEvent.click(screen.getByTestId('end-session-open'))
    const credit = screen.getByTestId('end-session-credit')
    const cancel = screen.getByTestId('end-session-cancel')
    // The credit line shares a column with the prompt and PRECEDES the buttons in
    // document order (a fast reader must not parse it as a consequence of confirming).
    expect(credit.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(credit.parentElement?.textContent).toContain(i18n.t('play.end.prompt'))
  })
})
