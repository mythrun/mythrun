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
//  - The overlay is a pure fold of the viewer's OWN ledger frames (filtered on
//    `characterName === viewerCharacterName`) through `reduceLedger` — the caller
//    (the shell, Task 14) passes the `ledger_update` frames it extracts from
//    `SessionView.items`; the reducer never re-reads the transport.
//  - The raw→CuratedSheet ADAPTER is INJECTED (deviation from the plan's hard
//    import — see the report). The canonical reshape (`toCharacterSheetSource` +
//    `sheetViewModel`) currently lives web-side (character-new/sheet-adapter.ts);
//    the composition passes `(raw) => toRevealViewModel(raw).curated`. Importing
//    it here would be a client-core → web dependency inversion (the web app
//    depends on client-core, not the reverse), so the hook takes it through
//    `deps.adaptSheet` — identical to how the sibling `knowledge-cache` injects
//    Task 4's not-yet-canonical `snapshotToGraph`. The controller promotes
//    `toCharacterSheetSource` into client-core at reconciliation, after which this
//    hook can default `adaptSheet` and be fully brain-side (R1).

import { useEffect, useMemo, useState } from 'react'
import { useApiContext } from '../api/client-context.tsx'
import type { ApiContext } from '../api/endpoint.ts'
import {
  getCharacter,
  getCharacters,
  type CharacterFull,
  type PartyRoster,
} from '../api/characters.ts'
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

/** Raw `CharacterFull` → the curated in-session sheet. Injected (see the module
 *  header): the composition passes `(raw) => toRevealViewModel(raw).curated`. */
export type AdaptSheet = (raw: CharacterFull) => CuratedSheet

/** Injected dependencies. `adaptSheet` is REQUIRED (there is no client-core default
 *  yet — see the header); the two reads default to the real endpoints and are
 *  injected only by tests. */
export interface SessionSheetDeps {
  readonly adaptSheet: AdaptSheet
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
  readonly loading: boolean
  readonly failed: boolean
}

const LOADING_FETCH_STATE: SheetFetchState = { sheet: null, loading: true, failed: false }

/** Resolve the viewer's own character and adapt it to the curated sheet. Returns
 *  null when the viewer has no finalized character (no `characterId` on the
 *  roster) — the per-character read is skipped. Rejections propagate to the
 *  caller's `.catch` (→ the calm failed state). */
async function loadCuratedSheet(
  ctx: ApiContext,
  campaignId: string,
  viewerUserId: string,
  fetchRoster: FetchRoster,
  fetchCharacter: FetchCharacter,
  adaptSheet: AdaptSheet,
): Promise<CuratedSheet | null> {
  const roster = await fetchRoster(ctx, campaignId)
  const characterId = roster.members.find((m) => m.userId === viewerUserId)?.characterId
  if (characterId === undefined) return null
  const raw = await fetchCharacter(ctx, campaignId, characterId)
  return adaptSheet(raw)
}

/**
 * The in-session character-sheet view-model. Fetches the viewer's own curated
 * sheet once on mount and folds their `ledger_update` frames into a live overlay.
 */
export function useSessionSheet(
  campaignId: string,
  viewerUserId: string,
  viewerCharacterName: string,
  ledgerFrames: readonly LedgerUpdateFrame[],
  deps: SessionSheetDeps,
): SessionSheetState {
  const { adaptSheet, fetchRoster = getCharacters, fetchCharacter = getCharacter } = deps
  const ctx = useApiContext()
  const [fetchState, setFetchState] = useState<SheetFetchState>(LOADING_FETCH_STATE)

  useEffect(() => {
    let active = true
    void loadCuratedSheet(ctx, campaignId, viewerUserId, fetchRoster, fetchCharacter, adaptSheet)
      .then((sheet) => {
        if (!active) return
        // A resolved-but-null sheet (viewer has no finalized character) reads as
        // the same calm empty state as a failed read — both render the tab's
        // unavailable line.
        setFetchState({ sheet, loading: false, failed: sheet === null })
      })
      .catch(() => {
        if (active) setFetchState({ sheet: null, loading: false, failed: true })
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, viewerUserId, fetchRoster, fetchCharacter, adaptSheet])

  // The live overlay: fold ONLY the viewer's own ledger frames (a pure,
  // transport-agnostic reduce — recomputed only when the frames or the viewer
  // name change).
  const overlay = useMemo(
    () =>
      ledgerFrames
        .filter((frame) => frame.characterName === viewerCharacterName)
        .reduce(reduceLedger, emptyOverlay),
    [ledgerFrames, viewerCharacterName],
  )

  return { sheet: fetchState.sheet, overlay, loading: fetchState.loading, failed: fetchState.failed }
}
