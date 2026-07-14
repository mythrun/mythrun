// frontend/client-core/src/session/ledger-reducer.ts
//
// MYT-94 (spec §6) — fold the session's `ledger_update` frames into a live
// character-state OVERLAY for the in-session sheet (Task 6 `useSessionSheet`).
//
// The `ledger_update` frame (contract `events/session-events.ts`) is a
// post-mutation delta that carries AUTHORITATIVE post-values, never a raw delta:
// an `adjust_hp` turn emits `kind:'hp'` with the character's new `hp`+`maxHp`; a
// `take_rest` emits `kind:'rest'` ALSO carrying the post-rest `hp`+`maxHp`; a gold
// spend emits `kind:'gold'` with the new `gold`. So the reducer SETS whatever
// authoritative value fields the frame carries (it never adds) — re-applying a
// frame is idempotent by construction, which makes a reconnect replay (the same
// frame re-emitted with a `seq`) harmless. See the double-write
// authoritative-SET-not-delta rule.
//
// Design pins:
//  - Fold by FIELD PRESENCE, not by `kind`: any frame carrying `hp`/`maxHp`/
//    `gold` SETS it. This is deliberately broader than a `kind:'hp'`-only switch
//    because `kind:'rest'` ALSO carries authoritative `hp`/`maxHp` (a long rest
//    restores HP — a kind-switch would leave the live sheet stale after a rest;
//    see `buildRestPayloads` in backend `rules-lawyer-vitals.ts`). Only the
//    hp/gold resolvers populate these fields (contract), so presence == authority.
//  - Conditions carry `condition` + a prose `summary` but NO add/remove flag at
//    the frame boundary (the FT tool's `apply|clear` is dropped by the
//    publisher). A deterministic active-condition SET is therefore not derivable
//    without parsing the prose (a ZFC violation), so we keep a chronological
//    `conditionLog` of the summaries and let the sheet render it as recent
//    changes. A maintained active set is a filed follow-up (needs a wire flag).
//  - `seq` is IGNORED: the live intra-turn frame has none; the reconnect replay
//    carries it. The fold must be indifferent, so it never reads `seq`.
//  - The caller filters to the VIEWER's own character (matching `characterName`)
//    before folding — this stays a pure, transport-agnostic fold.

import type { ServerFrame } from '@mythrun/contract/events'

/** The `ledger_update` frame, narrowed from the shipped `ServerFrame` union
 *  (contract `events/session-events.ts`). Consumed, never redeclared. */
export type LedgerUpdateFrame = Extract<ServerFrame, { type: 'ledger_update' }>

/** The live character-state overlay folded from `ledger_update` frames — the
 *  authoritative post-mutation values for the viewer's own sheet. Every value is
 *  a SET (the frame carries post-values, not deltas), so re-applying a frame is
 *  idempotent; `conditionLog` is an append-only chronological list (see header). */
export interface CharacterOverlay {
  readonly hp: number | null
  readonly maxHp: number | null
  readonly gold: number | null
  readonly conditionLog: readonly string[]
}

/** The zero overlay — nothing folded yet, so the base sheet's own values stand. */
export const emptyOverlay: CharacterOverlay = {
  hp: null,
  maxHp: null,
  gold: null,
  conditionLog: [],
}

/** Fold one `ledger_update` frame into the overlay. Pure + allocation-light: SET
 *  any authoritative value the frame carries; append a condition summary to the
 *  chronological log. Never reads `seq` (replay-indifferent). */
export function reduceLedger(overlay: CharacterOverlay, frame: LedgerUpdateFrame): CharacterOverlay {
  return {
    hp: frame.hp ?? overlay.hp,
    maxHp: frame.maxHp ?? overlay.maxHp,
    gold: frame.gold ?? overlay.gold,
    conditionLog:
      frame.kind === 'condition'
        ? [...overlay.conditionLog, frame.summary]
        : overlay.conditionLog,
  }
}
