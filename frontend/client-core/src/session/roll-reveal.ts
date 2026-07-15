import { useCallback, useReducer } from 'react'
import type { TranscriptItem } from './transcript-types.ts'

// Reveal state for the dice/skill-check theater (MYT-93, spec §5). PRESENTATION
// ONLY — the roll is already server-resolved (the skill_check/dice_roll frame
// carries the WHOLE result); this layer just delays the DISPLAY of an
// already-received number and gates the post-check outcome prose behind an
// explicit "Continue". It NEVER sends anything to the server: there is no
// client→server roll frame (roll_complete is deliberately excluded — contract
// §5). useSession is UNTOUCHED — the "buffer" is a render gate over the
// transcript the hook already produces, not a hold-back in the hook.
//
// A card's phase is DERIVED, never stored per frame:
//   • a REPLAYED card (frame carries a `seq` — a persisted reconnect row) is
//     HISTORY → renders already-`released` (no theater on backlog/reconnect).
//   • a LIVE card (no seq): `idle` (Roll) → `revealed` (numbers + Continue) →
//     `released` (prose gate opens). The spin itself is a LOCAL DieSpin
//     transition; the reducer tracks only the two COMMITTED interactions by key.

/** A skill_check or dice_roll transcript item — the two card kinds. */
export type CardItem = Extract<TranscriptItem, { kind: 'skill_check' } | { kind: 'dice_roll' }>

export type RollPhase = 'idle' | 'revealed' | 'released'

export interface RollRevealState {
  /** Item keys the player has rolled (spin committed). */
  readonly rolled: ReadonlySet<string>
  /** Item keys the player has continued (prose released). */
  readonly continued: ReadonlySet<string>
}

export const emptyRollReveal: RollRevealState = {
  rolled: new Set<string>(),
  continued: new Set<string>(),
}

export type RollRevealAction = { type: 'roll'; key: string } | { type: 'continue'; key: string }

export function rollRevealReducer(state: RollRevealState, action: RollRevealAction): RollRevealState {
  switch (action.type) {
    case 'roll':
      if (state.rolled.has(action.key)) return state
      return { ...state, rolled: new Set(state.rolled).add(action.key) }
    case 'continue': {
      if (state.continued.has(action.key)) return state
      // Continue implies rolled (a reduced-motion instant-land, or a defensive
      // direct-continue, still lands both).
      const rolled = state.rolled.has(action.key) ? state.rolled : new Set(state.rolled).add(action.key)
      return { rolled, continued: new Set(state.continued).add(action.key) }
    }
  }
}

/** Derive a card's phase. A replayed row (persisted `seq`) is history → released. */
export function cardPhase(item: CardItem, state: RollRevealState): RollPhase {
  if (item.frame.seq !== undefined) return 'released'
  if (state.continued.has(item.key)) return 'released'
  if (state.rolled.has(item.key)) return 'revealed'
  return 'idle'
}

/** The plain derived data MessageStream renders against (R1: no UI-side runtime
 *  import of this module — the route computes this and passes it as a prop). */
export interface RollRevealView {
  readonly phaseByKey: Readonly<Record<string, RollPhase>>
  /** turnIds whose outcome prose is still gated (any un-released SKILL_CHECK). */
  readonly gatedTurnIds: ReadonlySet<string>
}

export function buildRevealView(items: readonly TranscriptItem[], state: RollRevealState): RollRevealView {
  const phaseByKey: Record<string, RollPhase> = {}
  const gated = new Set<string>()
  for (const it of items) {
    if (it.kind !== 'skill_check' && it.kind !== 'dice_roll') continue
    const phase = cardPhase(it, state)
    phaseByKey[it.key] = phase
    // dice_roll is the flavor variant — it never gates prose (spec §5).
    if (it.kind === 'skill_check' && phase !== 'released') gated.add(it.turnId)
  }
  return { phaseByKey, gatedTurnIds: gated }
}

export interface RollReveal {
  readonly state: RollRevealState
  roll(key: string): void
  advance(key: string): void
}

export function useRollReveal(): RollReveal {
  const [state, dispatch] = useReducer(rollRevealReducer, emptyRollReveal)
  const roll = useCallback((key: string) => {
    dispatch({ type: 'roll', key })
  }, [])
  const advance = useCallback((key: string) => {
    dispatch({ type: 'continue', key })
  }, [])
  return { state, roll, advance }
}
