import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

// The session-progress route seams (myth-atxhx), split from session-shell.test.tsx
// (the 400-line module convention — same harness pattern as the sibling suites).
//
// What is pinned here is a PRODUCT rule, not a rendering detail: a Mythrun session
// is a play UNIT, not a sitting. Leaving is free and rejoining is normal, and the
// credit is debited at session START — so ending early refunds nothing and destroys
// what the player already bought. Therefore the voluntary end affordances (the
// persistent control AND the long-rest wind-down offer) exist ONLY near the end,
// where choosing the landing beats letting the budget cliff choose it. With no
// progress signal at all, neither appears — the safe default for an action that
// cannot be undone. The position line itself is a WORD, never the cost-derived
// number.

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

/** Settled DM prose — the ordinary between-turns state the chrome row sits above. */
const DM_PROSE: SessionView['items'][number] = {
  kind: 'dm',
  key: 'dm-1',
  turnId: 'T1',
  text: DM_TEXT,
  streaming: false,
}

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

// The two positions the surface behaves differently at, plus "no signal at all".
const NEAR_END = 0.85
const EARLY = 0.1

const EMPTY_CACHE: KnowledgeCache = { wiki: null, graph: null, index: null, loading: false, failed: true }
const EMPTY_SHEET: SessionSheetState = {
  sheet: null,
  overlay: { hp: null, maxHp: null, gold: null, conditionLog: [], activeConditions: null },
  loading: false,
  failed: true,
}
const KNOWLEDGE_HOOKS: PlayKnowledgeHooks = { useCache: () => EMPTY_CACHE, useSheet: () => EMPTY_SHEET }

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
    // No progress signal by default — the honest pre-first-turn state.
    progress: null,
    sendMessage: vi.fn(),
    summonDm: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  }
}

function renderShellSession(session: SessionView): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
  Object.defineProperty(globalThis, 'localStorage', { value: new MemStorage(), configurable: true })
})

afterEach(() => {
  cleanup()
})

describe('SessionShell — session progress + the end gate (myth-atxhx)', () => {
  it('shows NO end control early — ending there destroys a session the player already paid for', () => {
    renderShellSession(makeSession([DM_PROSE], { progress: EARLY }))
    expect(screen.queryByTestId('end-session-open')).toBeNull()
    // The position line still shows: the player learns where they are without
    // being handed the one control that would waste it.
    expect(screen.getByTestId('session-progress-line').getAttribute('data-band')).toBe('early')
  })

  it('shows NO end control and NO position line with no signal at all (older frames, pre-first-turn)', () => {
    renderShellSession(makeSession([DM_PROSE]))
    expect(screen.queryByTestId('end-session-open')).toBeNull()
    expect(screen.queryByTestId('session-progress-line')).toBeNull()
  })

  it('surfaces the end control from the near-end band on — choosing the landing is craft', () => {
    renderShellSession(makeSession([DM_PROSE], { progress: 0.7 }))
    expect(screen.getByTestId('end-session-open')).toBeDefined()
    expect(screen.getByTestId('session-progress-line').getAttribute('data-band')).toBe('late')
  })

  it('withholds the wind-down offer early even on a long rest (the natural-beat trap)', () => {
    // A long rest at 15% is the moment ending FEELS most reasonable and is most
    // wasteful — the same gate as the end control has to cover it.
    renderShellSession(makeSession([DM_PROSE, LONG_REST], { progress: EARLY }))
    expect(screen.queryByTestId('wind-down-offer')).toBeNull()
  })

  it('renders the band as a WORD, never the cost-derived number', () => {
    renderShellSession(makeSession([DM_PROSE], { progress: 0.65 }))
    const line = screen.getByTestId('session-progress-line')
    expect(line.textContent).toBe(i18n.t('play.progress.middle'))
    // No percentage, no fraction, no digits at all: the signal is token spend, and
    // a number would read as money burned rather than story told.
    expect(line.textContent).not.toMatch(/\d/)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('Keep playing steps back from the confirm without ending — the escape hatch holds', () => {
    const endSession = vi.fn()
    renderShellSession(makeSession([DM_PROSE], { endSession, progress: NEAR_END }))
    fireEvent.click(screen.getByTestId('end-session-open'))
    fireEvent.click(screen.getByTestId('end-session-cancel'))
    expect(endSession).not.toHaveBeenCalled()
    // Back to the resting control, not a dead-ended confirm.
    expect(screen.queryByTestId('end-session-confirm')).toBeNull()
    expect(screen.getByTestId('end-session-open')).toBeDefined()
  })

  it('sweeps the whole chrome row once the end is confirmed (no stale position line)', () => {
    renderShellSession(makeSession([DM_PROSE], { progress: 0.95 }))
    fireEvent.click(screen.getByTestId('end-session-open'))
    fireEvent.click(screen.getByTestId('end-session-do'))
    expect(screen.queryByTestId('session-progress-line')).toBeNull()
    expect(screen.queryByTestId('end-session-open')).toBeNull()
  })
})
