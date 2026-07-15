import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, within, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  reduceLedger,
  emptyOverlay,
  type ApiContext,
  type KnowledgeCache,
  type LedgerUpdateFrame,
  type SessionSheetState,
  type SessionView,
  type WorldGenSnapshot,
} from '@mythrun/client-core'
import { snapshotToGraph, toWikiViewModel } from '@mythrun/client-core/worldgen'
import type {
  CuratedSheet,
  EntityGlyph,
  EntityIndex,
  ProseSegment,
} from '@mythrun/client-core/contract'
import { i18n } from '../../i18n/config.ts'
import { SessionShell, type SessionShellProps } from './session-shell.tsx'
import type { PlayKnowledgeHooks } from './knowledge-panel.tsx'

// MYT-94 Task 14 — the play-route knowledge composition (session-shell.tsx +
// knowledge-panel.tsx): the sidebar that fills MYT-92's placeholder seam, and the
// settled-prose entity highlighting threaded into MessageStream. These tests render
// the REAL SessionShell (mirroring session-shell.test.tsx) with an injected fake
// session + injected fake knowledge hooks (no transport), and drive the six done-when
// behaviours: default-open + collapse, chat highlighting, the chat→wiki bridge, the
// live-HP sheet overlay, the mobile Drawer, and the reconnect refetch.

const KESSA = 'Kessa Vurm'

// The known-tier snapshot the real wiki/graph projections derive from — an npc whose
// name appears in the DM prose below, so a mention is actually matched.
const SNAPSHOT: WorldGenSnapshot = {
  entities: [
    { id: 'npc-kessa', entityType: 'npc', name: KESSA },
    { id: 'loc-green', entityType: 'location', name: 'Greenward' },
  ],
  facts: [{ id: 'f1', entityId: 'npc-kessa', topic: 'role', content: 'A toll-clerk turned adventurer.' }],
  entityHierarchy: [],
  relationships: [],
}

/** A minimal real-shape matcher for ONE name — the production matcher has its own
 *  unit tests (Task 3); here we only need a working index over the DM prose. */
function makeIndex(name: string, entityId: string, glyph: EntityGlyph): EntityIndex {
  return {
    segment(text: string): readonly ProseSegment[] {
      const parts: ProseSegment[] = []
      let cursor = 0
      let hit = text.indexOf(name)
      while (hit !== -1) {
        if (hit > cursor) parts.push({ kind: 'text', text: text.slice(cursor, hit) })
        parts.push({ kind: 'entity', text: name, entityId, glyph })
        cursor = hit + name.length
        hit = text.indexOf(name, cursor)
      }
      if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
      return parts
    },
    card(id: string) {
      return id === entityId ? { entityId, name, glyph, leadLine: '' } : null
    },
  }
}

const READY_CACHE: KnowledgeCache = {
  wiki: toWikiViewModel(SNAPSHOT),
  graph: snapshotToGraph(SNAPSHOT),
  index: makeIndex(KESSA, 'npc-kessa', 'npc'),
  loading: false,
  failed: false,
}

/** The viewer's curated sheet (name matches the ledger frame's characterName). */
const SHEET: CuratedSheet = {
  name: KESSA,
  identityLine: 'Level 3 · Human Fighter · Toll-clerk of Greenward',
  stats: [
    { label: 'AC', value: '16' },
    { label: 'HP', value: '28 / 28' },
    { label: 'Speed', value: '30 ft' },
  ],
  abilities: [
    { abbrev: 'STR', score: 16, modifier: 3 },
    { abbrev: 'DEX', score: 13, modifier: 1 },
    { abbrev: 'CON', score: 15, modifier: 2 },
    { abbrev: 'INT', score: 12, modifier: 1 },
    { abbrev: 'WIS', score: 11, modifier: 0 },
    { abbrev: 'CHA', score: 9, modifier: -1 },
  ],
  prose: ['Kessa spent eleven years stamping manifests at the Greenward Toll.'],
  features: [{ name: 'Second Wind' }],
  equipment: [{ name: 'Longsword' }],
}

// ---- injected fake hooks (no transport) ---------------------------------------

let lastRefreshToken = -1

function cacheHook(cache: KnowledgeCache): PlayKnowledgeHooks['useCache'] {
  return (_campaignId, refreshToken) => {
    lastRefreshToken = refreshToken
    return cache
  }
}

/** A sheet hook that FOLDS the viewer's ledger frames on the passed character name
 *  (mirrors the real `useSessionSheet` overlay so the resolved-name feedback drives a
 *  real HP update), returning the given base sheet. */
function sheetHook(sheet: CuratedSheet | null): PlayKnowledgeHooks['useSheet'] {
  return (_campaignId, _viewerUserId, viewerCharacterName, frames) => {
    const overlay = frames
      .filter((frame) => frame.characterName === viewerCharacterName)
      .reduce(reduceLedger, emptyOverlay)
    const state: SessionSheetState = { sheet, overlay, loading: false, failed: sheet === null }
    return state
  }
}

const READY_HOOKS: PlayKnowledgeHooks = { useCache: cacheHook(READY_CACHE), useSheet: sheetHook(SHEET) }

// ---- session / transcript fixtures --------------------------------------------

const DM_ITEM: SessionView['items'][number] = {
  kind: 'dm',
  key: 'dm-1',
  turnId: 'T1',
  text: `${KESSA} steps into the toll house.`,
  streaming: false,
}

const HP_FRAME: LedgerUpdateFrame = {
  type: 'ledger_update',
  turnId: 'T2',
  characterName: KESSA,
  kind: 'hp',
  summary: 'A hobgoblin blade opens a gash.',
  hp: 12,
  maxHp: 28,
}
const LEDGER_ITEM: SessionView['items'][number] = {
  kind: 'ledger_update',
  key: 'lg-1',
  turnId: 'T2',
  frame: HP_FRAME,
}

const testCtx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

const CAMPAIGN_ID = 'c1'
const SESSION_ID = 's1'
const VIEWER_ID = 'viewer-1'
const DISPLAY_NAME = 'Ada'

function makeSession(
  items: SessionView['items'],
  status: SessionView['connection']['status'] = 'connected',
): SessionView {
  return {
    items,
    connection: { status, attempt: 0 },
    thinking: false,
    typingUserIds: [],
    ended: false,
    sendMessage: vi.fn(),
    summonDm: vi.fn(),
    endSession: vi.fn(),
  }
}

// ENVIRONMENT shim (ThemeProvider reads localStorage on mount) — mirrors the sibling
// route tests.
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

interface ShellOptions {
  readonly items?: SessionView['items']
  readonly status?: SessionView['connection']['status']
  readonly characterName?: string
  readonly hooks?: PlayKnowledgeHooks
}

function shellTree(options: ShellOptions) {
  const { items = [DM_ITEM], status = 'connected', characterName = '', hooks = READY_HOOKS } = options
  const props: SessionShellProps = {
    ctx: testCtx,
    campaignId: CAMPAIGN_ID,
    sessionId: SESSION_ID,
    viewerUserId: VIEWER_ID,
    displayName: DISPLAY_NAME,
    characterName,
    party: new Map(),
    reducedMotion: true,
    useLiveSession: () => makeSession(items, status),
    knowledgeHooks: hooks,
  }
  return (
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SessionShell {...props} />
        </MemoryRouter>
      </I18nextProvider>
    </ThemeProvider>
  )
}

function renderShell(options: ShellOptions = {}) {
  const result = render(shellTree(options))
  return {
    ...result,
    rerenderShell: (next: ShellOptions) => {
      result.rerender(shellTree(next))
    },
  }
}

/** A query-aware matchMedia stub — the wide-sidebar query resolves to the viewport
 *  under test; `fire()` invokes the hook's change listener (a runtime resize). */
function stubViewport(wide: boolean): { fire: () => void; setWide: (w: boolean) => void } {
  let listener: (() => void) | undefined
  let matches = wide
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query === '(min-width: 1024px)' ? matches : false
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, cb: () => void) => {
        listener = cb
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  return { fire: () => listener?.(), setWide: (w: boolean) => (matches = w) }
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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  lastRefreshToken = -1
})

const EXPAND = i18n.t('play.sidebar.expand')
const MENTION_LABEL = i18n.t('play.knowledge.mention', { name: KESSA })
const OPEN_IN_WIKI = i18n.t('play.knowledge.openInWiki')

describe('play knowledge composition — the sidebar', () => {
  it('renders the sidebar OPEN by default on desktop; the toggle collapses + re-expands it', () => {
    renderShell()
    const shell = screen.getByTestId('session-shell')
    // Open: the rail panel is inline in the shell, with the wiki tab + the collapse toggle.
    expect(within(shell).getByTestId('session-sidebar-seam')).toBeDefined()
    expect(within(shell).getByTestId('knowledge-wiki')).toBeDefined()

    // Collapse → the panel is replaced by the slim expand handle (no tabs).
    fireEvent.click(within(shell).getByTestId('session-sidebar-toggle'))
    expect(within(shell).queryByTestId('knowledge-wiki')).toBeNull()
    const expand = within(shell).getByTestId('session-sidebar-toggle')
    expect(expand.getAttribute('aria-label')).toBe(EXPAND)

    // Expand again → the tabs return.
    fireEvent.click(expand)
    expect(within(shell).getByTestId('knowledge-wiki')).toBeDefined()
  })

  it('shows the calm unavailable lines when the projections have not settled', () => {
    renderShell({
      hooks: {
        useCache: cacheHook({ wiki: null, graph: null, index: null, loading: false, failed: true }),
        useSheet: sheetHook(null),
      },
    })
    const shell = screen.getByTestId('session-shell')
    expect(within(shell).getByTestId('knowledge-wiki-unavailable')).toBeDefined()
    // A null cache index ⇒ the chat is NOT highlighted (plain prose, no mention).
    expect(screen.queryByRole('button', { name: MENTION_LABEL })).toBeNull()
  })
})

describe('play knowledge composition — chat highlighting bridge', () => {
  it('threads the cache index into MessageStream so a known name highlights in settled prose', () => {
    renderShell()
    // The DM prose renders the recognized name as a focusable mention (a button).
    const mention = screen.getByRole('button', { name: MENTION_LABEL })
    expect(mention).toBeDefined()
    expect(mention.textContent).toContain(KESSA)
  })

  it('a chat entity-highlight → "open in wiki" forces the wiki tab AND opens a collapsed sidebar', () => {
    renderShell()
    const shell = screen.getByTestId('session-shell')

    // Move OFF the wiki tab (Radix Tabs activates on left mousedown), then collapse
    // the rail — the pre-conditions the bridge must undo.
    fireEvent.mouseDown(within(shell).getByRole('tab', { name: i18n.t('play.knowledge.sheetTab') }))
    expect(within(shell).getByTestId('session-sheet')).toBeDefined()
    fireEvent.click(within(shell).getByTestId('session-sidebar-toggle'))
    expect(within(shell).queryByTestId('session-sheet')).toBeNull()

    // Click the chat mention → its popover → "open in the world guide".
    fireEvent.click(screen.getByRole('button', { name: MENTION_LABEL }))
    fireEvent.click(screen.getByRole('button', { name: OPEN_IN_WIKI }))

    // The sidebar re-opened AND landed on the wiki tab (not the sheet tab).
    expect(within(shell).getByTestId('knowledge-wiki')).toBeDefined()
    expect(within(shell).queryByTestId('session-sheet')).toBeNull()
  })
})

describe('play knowledge composition — the live sheet', () => {
  it('folds a ledger_update HP change into the sheet tab even with no character name threaded', async () => {
    renderShell({ items: [DM_ITEM, LEDGER_ITEM], characterName: '' })
    const shell = screen.getByTestId('session-shell')
    fireEvent.mouseDown(within(shell).getByRole('tab', { name: i18n.t('play.knowledge.sheetTab') }))
    // The resolved-name feedback (name '' → the sheet's own name) lets the overlay
    // fold: the HP stat shows the live post-mutation value.
    await waitFor(() => {
      const hp = within(shell).getByTestId('session-sheet-hp')
      expect(hp.getAttribute('data-live')).toBe('true')
      expect(hp.textContent).toContain('12 / 28')
    })
  })
})

describe('play knowledge composition — responsive + boundary refetch', () => {
  it('mounts the shipped Drawer (portaled, summonable) on a narrow viewport', () => {
    stubViewport(false) // below lg
    renderShell()
    const shell = screen.getByTestId('session-shell')
    // The Drawer portals its content to <body>, so the seam is NOT inside the shell.
    expect(within(shell).queryByTestId('session-sidebar-seam')).toBeNull()
    expect(screen.getByTestId('session-sidebar-seam')).toBeDefined()
    // The chat still owns the shell (full-bleed).
    expect(within(shell).getByTestId('message-stream')).toBeDefined()
  })

  it('flips rail → drawer when the viewport crosses below lg at runtime', () => {
    const vp = stubViewport(true) // desktop
    renderShell()
    const shell = screen.getByTestId('session-shell')
    expect(within(shell).getByTestId('session-sidebar-seam')).toBeDefined()
    vp.setWide(false)
    act(() => {
      vp.fire()
    })
    expect(within(shell).queryByTestId('session-sidebar-seam')).toBeNull()
    expect(screen.getByTestId('session-sidebar-seam')).toBeDefined()
  })

  it('bumps the cache refetch token on a reconnecting → connected transition', () => {
    const { rerenderShell } = renderShell({ status: 'reconnecting' })
    const before = lastRefreshToken
    rerenderShell({ status: 'connected' })
    expect(lastRefreshToken).toBe(before + 1)
  })
})
