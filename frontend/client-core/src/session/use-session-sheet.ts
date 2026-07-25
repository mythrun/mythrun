// frontend/client-core/src/session/use-session-sheet.ts
//
// MYT-94 (spec §6) Task 6 — the IN-SESSION character-sheet view-model. Resolves
// the viewer's OWN character off the party roster, fetches the raw CharacterFull,
// adapts it to the CuratedSheet the in-session sheet tab renders, and folds the
// viewer's own `ledger_update` frames into a live HP/gold/condition OVERLAY (Task
// 5's `reduceLedger`). All reads are the EXISTING member-readable character
// endpoints — no new backend read surface (spec §1/§6).
//
// Design pins:
//  - ONE fetch on mount: roster → the viewer's `characterId` → the full read →
//    the curated sheet. Mirrors `useWikiModel` (reveal-wiki-panel.tsx): an
//    `active` flag drops a late resolve after unmount / a superseded refetch;
//    `loading` is only ever true before the FIRST settle; a failed read settles
//    to the calm empty sheet (`failed:true`, `sheet:null`) — the tab renders its
//    quiet `[ph:]` unavailable line, never an error flash.
//  - A member with no finalized character (shouldn't happen at play time —
//    everyone finalized to start) resolves to the SAME calm empty sheet: no
//    `characterId` on the roster → `sheet:null`, `failed:true`, and the
//    per-character read is never attempted.
//  - The overlay is a pure fold of the viewer's OWN ledger frames through
//    `reduceLedger` — the caller (the shell, Task 14) passes the `ledger_update`
//    frames it extracts from `SessionView.items`; the reducer never re-reads the
//    transport. WHICH frames are the viewer's is decided HERE (myth-3xttt): the
//    fetched `CharacterFull` carries the character's name, and ledger frames key
//    on that same name, so the hook matches them itself. It used to take the name
//    as an argument, which no caller could actually supply — the party roster
//    carries no character name — so the play route had to feed the resolved
//    sheet's name back in as the argument on the next render to make the overlay
//    fold at all. Self-deriving deletes that loop. The consequence is honest: the
//    overlay is empty until the character read lands, which is exactly the window
//    where there is no sheet to overlay onto.
//  - The raw→CuratedSheet ADAPTER defaults to the canonical client-core reshape
//    (`toRevealViewModel(raw).curated`, promoted beside `sheetViewModel` in MYT-94)
//    so the hook is fully brain-side (R1) with no injection required. `adaptSheet`
//    stays OVERRIDABLE via `deps` for tests that pin a fixed curated fixture without
//    exercising the whole adapter; the default is a module-level stable ref so it
//    never re-fires the fetch effect.

import { useEffect, useMemo, useState } from 'react'
import { useApiContext } from '../api/client-context.tsx'
import type { ApiContext } from '../api/endpoint.ts'
import {
  getCharacter,
  getCharacters,
  type CharacterFull,
  type PartyRoster,
} from '../api/characters.ts'
import { toRevealViewModel } from '../character/sheet-adapter.ts'
import type { CuratedSheet } from '../contract/index.ts'
import { emptyOverlay, reduceLedger, type CharacterOverlay, type LedgerUpdateFrame } from './ledger-reducer.ts'

/** Fetches the campaign's party roster (member → persisted PC id). Defaults to the
 *  real `getCharacters` endpoint; injected by tests. */
export type FetchRoster = (ctx: ApiContext, campaignId: string) => Promise<PartyRoster>

/** Fetches one PC's full raw read. Defaults to the real `getCharacter` endpoint;
 *  injected by tests. */
export type FetchCharacter = (
  ctx: ApiContext,
  campaignId: string,
  charId: string,
) => Promise<CharacterFull>

/** Raw `CharacterFull` → the curated in-session sheet. Defaults to the canonical
 *  client-core adapter (see the module header); overridable via `deps` in tests. */
export type AdaptSheet = (raw: CharacterFull) => CuratedSheet

/** The default raw→curated adapter — the canonical client-core reshape. A
 *  module-level stable ref so it never re-fires the fetch effect. */
const defaultAdaptSheet: AdaptSheet = (raw) => toRevealViewModel(raw).curated

/** Injected dependencies — all OPTIONAL. `adaptSheet` defaults to the canonical
 *  client-core adapter; the two reads default to the real endpoints. Tests inject
 *  any subset. */
export interface SessionSheetDeps {
  readonly adaptSheet?: AdaptSheet
  readonly fetchRoster?: FetchRoster
  readonly fetchCharacter?: FetchCharacter
}

/** The in-session sheet state: the base curated sheet (the member's own character)
 *  + the live overlay folded from `ledger_update` frames. `sheet` is null before
 *  the first settle, when the viewer has no finalized character, or when a read
 *  failed — the tab renders its calm unavailable line in every null case. */
export interface SessionSheetState {
  readonly sheet: CuratedSheet | null
  readonly overlay: CharacterOverlay
  readonly loading: boolean
  readonly failed: boolean
}

interface SheetFetchState {
  readonly sheet: CuratedSheet | null
  /** The viewer's character name, off the raw read — the ledger frames' own key
   *  (myth-3xttt). Null until the read lands, or when there is nothing to read. */
  readonly characterName: string | null
  readonly loading: boolean
  readonly failed: boolean
}

const LOADING_FETCH_STATE: SheetFetchState = {
  sheet: null,
  characterName: null,
  loading: true,
  failed: false,
}
const EMPTY_FETCH_STATE: SheetFetchState = {
  sheet: null,
  characterName: null,
  loading: false,
  failed: true,
}

/** Resolve the viewer's own character, adapt it to the curated sheet, and report
 *  the character's NAME alongside (the raw read is the only place it exists — the
 *  roster carries display names only). Returns null when the viewer has no
 *  finalized character (no `characterId` on the roster) — the per-character read
 *  is skipped. Rejections propagate to the caller's `.catch` (→ the calm failed
 *  state). */
async function loadCuratedSheet(
  ctx: ApiContext,
  campaignId: string,
  viewerUserId: string,
  fetchRoster: FetchRoster,
  fetchCharacter: FetchCharacter,
  adaptSheet: AdaptSheet,
): Promise<{ sheet: CuratedSheet; characterName: string } | null> {
  const roster = await fetchRoster(ctx, campaignId)
  const characterId = roster.members.find((m) => m.userId === viewerUserId)?.characterId
  if (characterId === undefined) return null
  const raw = await fetchCharacter(ctx, campaignId, characterId)
  return { sheet: adaptSheet(raw), characterName: raw.character.name }
}

/**
 * The in-session character-sheet view-model. Fetches the viewer's own curated
 * sheet once on mount and folds their `ledger_update` frames into a live overlay.
 */
export function useSessionSheet(
  campaignId: string,
  viewerUserId: string,
  ledgerFrames: readonly LedgerUpdateFrame[],
  deps: SessionSheetDeps = {},
): SessionSheetState {
  const {
    adaptSheet = defaultAdaptSheet,
    fetchRoster = getCharacters,
    fetchCharacter = getCharacter,
  } = deps
  const ctx = useApiContext()
  const [fetchState, setFetchState] = useState<SheetFetchState>(LOADING_FETCH_STATE)

  useEffect(() => {
    let active = true
    void loadCuratedSheet(ctx, campaignId, viewerUserId, fetchRoster, fetchCharacter, adaptSheet)
      .then((loaded) => {
        if (!active) return
        // A resolved-but-null load (viewer has no finalized character) reads as
        // the same calm empty state as a failed read — both render the tab's
        // unavailable line.
        if (loaded === null) setFetchState(EMPTY_FETCH_STATE)
        else setFetchState({ ...loaded, loading: false, failed: false })
      })
      .catch(() => {
        if (active) setFetchState(EMPTY_FETCH_STATE)
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, viewerUserId, fetchRoster, fetchCharacter, adaptSheet])

  // The live overlay: fold ONLY the viewer's own ledger frames (a pure,
  // transport-agnostic reduce — recomputed only when the frames or the resolved
  // name change). Before the read lands the name is null, which matches no
  // frame's string name, so the overlay is simply empty — the same window in
  // which there is no sheet to overlay onto.
  const { characterName } = fetchState
  const overlay = useMemo(
    () =>
      ledgerFrames
        .filter((frame) => frame.characterName === characterName)
        .reduce(reduceLedger, emptyOverlay),
    [ledgerFrames, characterName],
  )

  return { sheet: fetchState.sheet, overlay, loading: fetchState.loading, failed: fetchState.failed }
}
