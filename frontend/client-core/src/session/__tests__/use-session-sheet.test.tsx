import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ApiContext } from '../../api/endpoint.ts'
import { ApiClientProvider } from '../../api/client-context.tsx'
import type { CharacterFull, PartyRoster } from '../../api/characters.ts'
import type { CuratedSheet } from '../../contract/index.ts'
import type { LedgerUpdateFrame } from '../ledger-reducer.ts'
import { toRevealViewModel } from '../../character/sheet-adapter.ts'
import {
  useSessionSheet,
  type AdaptSheet,
  type FetchCharacter,
  type FetchRoster,
} from '../use-session-sheet.ts'

// useSessionSheet (MYT-94 Task 6): the in-session character-sheet view-model.
// Resolves the VIEWER's own characterId off the party roster, fetches the raw
// CharacterFull, adapts it to a CuratedSheet (adapter injected — see the module
// header), and folds the viewer's own `ledger_update` frames into a live overlay.
// Every test injects the two reads + the adapter through `deps` (no real
// transport) except the default-path test, which drives the real endpoints (MSW).

const BASE_URL = 'http://api.test'
const CID = 'campaign-123'
const VIEWER = 'user-viewer'
const VIEWER_CHAR = 'Ysolde Emberquill'
const CHAR_ID = 'char-viewer'

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

function makeWrapper() {
  return ({ children }: { children: ReactNode }) => (
    <ApiClientProvider value={testCtx}>{children}</ApiClientProvider>
  )
}

/** A hand-resolved promise so a test controls exactly when a read settles — the
 *  seam the `active`-flag guard (drop-a-late-resolve) is exercised through. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const rosterWithViewer: PartyRoster = {
  members: [
    { userId: VIEWER, displayName: 'Dev User 1', conceptStatus: 'completed', characterId: CHAR_ID },
    { userId: 'user-other', displayName: 'Dev User 2', conceptStatus: 'completed', characterId: 'char-other' },
  ],
}

const rosterNoCharacter: PartyRoster = {
  members: [{ userId: VIEWER, displayName: 'Dev User 1', conceptStatus: 'none' }],
}

const rawCharacter: CharacterFull = {
  character: {
    id: CHAR_ID,
    user_id: VIEWER,
    entity_id: null,
    name: VIEWER_CHAR,
    level: 3,
    class: 'Sorcerer',
    species: 'Human',
    background: 'Acolyte',
    str: 10,
    dex: 12,
    con: 14,
    int: 11,
    wis: 13,
    cha: 16,
    hit_points: 8,
    max_hit_points: 8,
    armor_class: 12,
    proficiency_bonus: 2,
    gold: 15,
    hit_die: 6,
    hit_dice_remaining: 3,
    spellcasting_progression: 'full',
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  },
  skills: [],
  features: [],
  equipment: [],
  spells: [],
}

const curatedFixture: CuratedSheet = {
  name: VIEWER_CHAR,
  identityLine: 'Level 3 · Human Sorcerer · Acolyte',
  stats: [{ label: 'HP', value: '8 / 8' }],
  abilities: [],
  prose: [],
  features: [],
  equipment: [],
}

const adaptSheet: AdaptSheet = () => curatedFixture

/** A `kind:'hp'` ledger frame (post-mutation authoritative hp/maxHp — no delta). */
function hpFrame(characterName: string, hp: number, maxHp: number): LedgerUpdateFrame {
  return {
    type: 'ledger_update',
    turnId: 'turn-1',
    characterName,
    kind: 'hp',
    summary: `${characterName} now ${String(hp)}/${String(maxHp)} HP.`,
    hp,
    maxHp,
  }
}

/** deps with the two reads faked; the adapter is the shared fixture-returner. */
function fakeDeps(overrides?: {
  fetchRoster?: FetchRoster
  fetchCharacter?: FetchCharacter
  adaptSheet?: AdaptSheet
}) {
  return {
    adaptSheet: overrides?.adaptSheet ?? adaptSheet,
    fetchRoster:
      overrides?.fetchRoster ?? ((): Promise<PartyRoster> => Promise.resolve(rosterWithViewer)),
    fetchCharacter:
      overrides?.fetchCharacter ?? ((): Promise<CharacterFull> => Promise.resolve(rawCharacter)),
  }
}

const server = setupServer()
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe('useSessionSheet — the fetch/adapt path', () => {
  it('resolves the viewer characterId off the roster, fetches, and adapts to a CuratedSheet', async () => {
    const fetchCharacter = vi.fn<FetchCharacter>().mockResolvedValue(rawCharacter)
    const adapt = vi.fn<AdaptSheet>().mockReturnValue(curatedFixture)

    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [], fakeDeps({ fetchCharacter, adaptSheet: adapt })),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.failed).toBe(false)
    expect(result.current.sheet).toBe(curatedFixture)
    // it fetched the VIEWER's character (not the other member's) and adapted the raw read.
    expect(fetchCharacter).toHaveBeenCalledWith(testCtx, CID, CHAR_ID)
    expect(adapt).toHaveBeenCalledWith(rawCharacter)
    unmount()
  })

  it('settles to failed/empty when the viewer has no finalized character', async () => {
    const fetchCharacter = vi.fn<FetchCharacter>()
    const { result, unmount } = renderHook(
      () =>
        useSessionSheet(
          CID,
          VIEWER,
          VIEWER_CHAR,
          [],
          fakeDeps({ fetchRoster: () => Promise.resolve(rosterNoCharacter), fetchCharacter }),
        ),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.sheet).toBeNull()
    expect(result.current.failed).toBe(true)
    // no characterId → the per-character read is never attempted.
    expect(fetchCharacter).not.toHaveBeenCalled()
    unmount()
  })

  it('settles to failed/empty when a read rejects', async () => {
    const { result, unmount } = renderHook(
      () =>
        useSessionSheet(
          CID,
          VIEWER,
          VIEWER_CHAR,
          [],
          fakeDeps({ fetchRoster: () => Promise.reject(new Error('roster down')) }),
        ),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.failed).toBe(true)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.sheet).toBeNull()
    unmount()
  })

  it('drops a late RESOLVE after unmount (no state update)', async () => {
    const d = deferred<PartyRoster>()
    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [], fakeDeps({ fetchRoster: () => d.promise })),
      { wrapper: makeWrapper() },
    )

    unmount()
    d.resolve(rosterWithViewer)
    await d.promise

    expect(result.current.loading).toBe(true)
    expect(result.current.sheet).toBeNull()
  })

  it('drops a late REJECT after unmount (no state update)', async () => {
    const d = deferred<PartyRoster>()
    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [], fakeDeps({ fetchRoster: () => d.promise })),
      { wrapper: makeWrapper() },
    )

    unmount()
    d.reject(new Error('late'))
    await d.promise.catch(() => undefined)

    expect(result.current.loading).toBe(true)
    expect(result.current.failed).toBe(false)
  })

  it('defaults the two reads to the real getCharacters/getCharacter endpoints', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/${CID}/characters`, () => HttpResponse.json(rosterWithViewer)),
      http.get(`${BASE_URL}/api/campaigns/${CID}/characters/${CHAR_ID}`, () =>
        HttpResponse.json(rawCharacter),
      ),
    )

    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [], { adaptSheet }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.failed).toBe(false)
    expect(result.current.sheet).toBe(curatedFixture)
    unmount()
  })

  it('defaults deps entirely — real reads + the canonical client-core curated adapter', async () => {
    // No `deps` arg at all: the reads default to the real endpoints AND `adaptSheet`
    // defaults to the client-core `toRevealViewModel(raw).curated` reshape (the
    // promoted brain-side adapter), so the produced sheet is the real curated view.
    server.use(
      http.get(`${BASE_URL}/api/campaigns/${CID}/characters`, () => HttpResponse.json(rosterWithViewer)),
      http.get(`${BASE_URL}/api/campaigns/${CID}/characters/${CHAR_ID}`, () =>
        HttpResponse.json(rawCharacter),
      ),
    )

    const { result, unmount } = renderHook(() => useSessionSheet(CID, VIEWER, VIEWER_CHAR, []), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.failed).toBe(false)
    expect(result.current.sheet).toEqual(toRevealViewModel(rawCharacter).curated)
    unmount()
  })
})

describe('useSessionSheet — the live overlay', () => {
  it("folds the viewer's own hp ledger frame into the overlay", () => {
    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [hpFrame(VIEWER_CHAR, 5, 8)], fakeDeps()),
      { wrapper: makeWrapper() },
    )

    expect(result.current.overlay.hp).toBe(5)
    expect(result.current.overlay.maxHp).toBe(8)
    unmount()
  })

  it('ignores a ledger frame for ANOTHER character', () => {
    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [hpFrame('Someone Else', 2, 20)], fakeDeps()),
      { wrapper: makeWrapper() },
    )

    expect(result.current.overlay.hp).toBeNull()
    expect(result.current.overlay.maxHp).toBeNull()
    unmount()
  })

  it('starts from the empty overlay when there are no frames', () => {
    const { result, unmount } = renderHook(
      () => useSessionSheet(CID, VIEWER, VIEWER_CHAR, [], fakeDeps()),
      { wrapper: makeWrapper() },
    )

    expect(result.current.overlay.hp).toBeNull()
    expect(result.current.overlay.gold).toBeNull()
    expect(result.current.overlay.conditionLog).toEqual([])
    unmount()
  })
})
