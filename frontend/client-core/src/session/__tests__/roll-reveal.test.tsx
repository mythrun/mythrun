import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ServerFrame } from '@mythrun/contract/events'
import type { TranscriptItem } from '../transcript-types.ts'
import {
  emptyRollReveal,
  rollRevealReducer,
  cardPhase,
  buildRevealView,
  useRollReveal,
  type CardItem,
} from '../roll-reveal.ts'

// --- typed frame + item builders (live = no seq; replayed row = +seq) ---

type F<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>

const skillFrame = (turnId: string, seq?: number): F<'skill_check'> => ({
  type: 'skill_check',
  turnId,
  ...(seq === undefined ? {} : { seq }),
  characterName: 'Cee',
  skill: 'perception',
  context: 'a tense moment',
  roll: 12,
  roll2: null,
  rollType: 'normal',
  modifier: 2,
  total: 14,
  dc: 12,
  outcomeTier: 'success',
  constraint: 'you notice the tripwire',
})

const diceFrame = (turnId: string, seq?: number): F<'dice_roll'> => ({
  type: 'dice_roll',
  turnId,
  ...(seq === undefined ? {} : { seq }),
  count: 2,
  sides: 6,
  results: [3, 5],
  total: 8,
})

const skillCard = (key: string, turnId: string, seq?: number): CardItem => ({
  kind: 'skill_check',
  key,
  turnId,
  frame: skillFrame(turnId, seq),
})

const diceCard = (key: string, turnId: string, seq?: number): CardItem => ({
  kind: 'dice_roll',
  key,
  turnId,
  frame: diceFrame(turnId, seq),
})

const dmItem = (key: string, turnId: string): TranscriptItem => ({
  kind: 'dm',
  key,
  turnId,
  text: 'prose',
  streaming: false,
})

const playerItem = (key: string): TranscriptItem => ({
  kind: 'player',
  key,
  turnId: null,
  seq: 1,
  userId: 'u1',
  displayName: 'Dee',
  characterName: 'Cee',
  text: 'hi',
  pending: false,
})

describe('rollRevealReducer', () => {
  it('(a) roll adds the key to rolled; a second roll is a no-op returning the same reference', () => {
    const s1 = rollRevealReducer(emptyRollReveal, { type: 'roll', key: 'k1' })
    expect(s1.rolled.has('k1')).toBe(true)
    expect(s1.continued.has('k1')).toBe(false)
    const s2 = rollRevealReducer(s1, { type: 'roll', key: 'k1' })
    expect(s2).toBe(s1) // idempotent — no state churn
  })

  it('(b) continue adds to continued AND ensures rolled even with no prior roll; idempotent', () => {
    const s1 = rollRevealReducer(emptyRollReveal, { type: 'continue', key: 'k1' })
    expect(s1.continued.has('k1')).toBe(true)
    expect(s1.rolled.has('k1')).toBe(true) // a direct continue still lands rolled
    const s2 = rollRevealReducer(s1, { type: 'continue', key: 'k1' })
    expect(s2).toBe(s1) // idempotent — no state churn
  })

  it('(b) continue after a prior roll reuses the existing rolled set', () => {
    const rolled = rollRevealReducer(emptyRollReveal, { type: 'roll', key: 'k1' })
    const continued = rollRevealReducer(rolled, { type: 'continue', key: 'k1' })
    expect(continued.rolled).toBe(rolled.rolled) // already-rolled → reuse, no rebuild
    expect(continued.continued.has('k1')).toBe(true)
  })
})

describe('cardPhase', () => {
  it('(c) a LIVE card (no seq): idle with no interaction, revealed after roll, released after continue', () => {
    const card = skillCard('sc1', 'T')
    expect(cardPhase(card, emptyRollReveal)).toBe('idle')
    const rolled = rollRevealReducer(emptyRollReveal, { type: 'roll', key: 'sc1' })
    expect(cardPhase(card, rolled)).toBe('revealed')
    const continued = rollRevealReducer(rolled, { type: 'continue', key: 'sc1' })
    expect(cardPhase(card, continued)).toBe('released')
  })

  it('(d) a REPLAYED card (frame.seq set) is released regardless of reveal state', () => {
    const replayed = skillCard('sc1', 'T', 12)
    expect(cardPhase(replayed, emptyRollReveal)).toBe('released')
    // Even a stray reveal interaction cannot re-theater a replayed row — seq wins.
    const continued = rollRevealReducer(emptyRollReveal, { type: 'continue', key: 'sc1' })
    expect(cardPhase(replayed, continued)).toBe('released')
  })
})

describe('buildRevealView', () => {
  it('(e) phases every card and gates only un-released skill_checks (dice never gates, released does not)', () => {
    const items: readonly TranscriptItem[] = [
      playerItem('p1'), // non-card, BEFORE the card — never demotes it
      skillCard('sc3', 'T3', 9), // replayed → released → does not gate
      skillCard('sc1', 'T1'), // live, idle, at the tail → gates T1
      dmItem('dm1', 'T1'), // same-turn prose — gated (invisible), not a demotion
    ]
    const view = buildRevealView(items, emptyRollReveal)
    expect(view.phaseByKey).toEqual({ sc1: 'idle', sc3: 'released' })
    expect(view.gatedTurnIds.has('T1')).toBe(true) // un-released skill_check gates
    expect(view.gatedTurnIds.has('T3')).toBe(false) // released skill_check does not gate
  })

  it('(f) a turn with TWO skill_checks (shared turnId) stays gated until BOTH are released', () => {
    const items: readonly TranscriptItem[] = [skillCard('a', 'T'), skillCard('b', 'T')]

    expect(buildRevealView(items, emptyRollReveal).gatedTurnIds.has('T')).toBe(true)

    let state = rollRevealReducer(emptyRollReveal, { type: 'continue', key: 'a' })
    expect(buildRevealView(items, state).gatedTurnIds.has('T')).toBe(true) // b still un-released

    state = rollRevealReducer(state, { type: 'continue', key: 'b' })
    expect(buildRevealView(items, state).gatedTurnIds.has('T')).toBe(false) // both released → open
  })
})

describe('buildRevealView — moved-on demotion (myth-svmer)', () => {
  // The turn-state coherence law: nothing may render below a card still claiming
  // to be unresolved. When a VISIBLE item lands after an un-released card, the
  // card demotes to a historical record ('released') and its gate lifts.

  it('a player message after an un-released card demotes it (and lifts the gate) in the same paint', () => {
    const items: readonly TranscriptItem[] = [skillCard('sc1', 'T1'), dmItem('dm1', 'T1'), playerItem('p1')]
    const view = buildRevealView(items, emptyRollReveal)
    expect(view.phaseByKey.sc1).toBe('released')
    expect(view.gatedTurnIds.has('T1')).toBe(false)
  })

  it('a revealed (awaiting-Continue) card demotes the same way when the transcript moves on', () => {
    const rolled = rollRevealReducer(emptyRollReveal, { type: 'roll', key: 'sc1' })
    const items: readonly TranscriptItem[] = [skillCard('sc1', 'T1'), playerItem('p1')]
    expect(buildRevealView(items, rolled).phaseByKey.sc1).toBe('released')
  })

  it("a LATER turn's visible item demotes an earlier armed card", () => {
    const items: readonly TranscriptItem[] = [skillCard('sc1', 'T1'), dmItem('dm2', 'T2')]
    const view = buildRevealView(items, emptyRollReveal)
    expect(view.phaseByKey.sc1).toBe('released')
    expect(view.gatedTurnIds.size).toBe(0)
  })

  it("same-turn items never demote: the card's own gated prose and mechanical lines are the normal flow", () => {
    const ledger: TranscriptItem = {
      kind: 'ledger_update',
      key: 'lu1',
      turnId: 'T1',
      frame: {
        type: 'ledger_update',
        turnId: 'T1',
        characterName: 'Cee',
        kind: 'rest',
        restType: 'short',
        summary: 'Cee catches her breath.',
      },
    }
    const items: readonly TranscriptItem[] = [skillCard('sc1', 'T1'), dmItem('dm1', 'T1'), ledger]
    const view = buildRevealView(items, emptyRollReveal)
    expect(view.phaseByKey.sc1).toBe('idle') // the theatre stays armed
    expect(view.gatedTurnIds.has('T1')).toBe(true)
  })

  it('a gated dm item of ANOTHER un-released turn is invisible, so it does not demote', () => {
    // Two armed turns: T2's card + prose sit after T1's card, but T2's prose is
    // gated (invisible). T1's card sees only T2's CARD as visible → demotes; T2's
    // card is the tail → stays armed.
    const items: readonly TranscriptItem[] = [
      skillCard('sc1', 'T1'),
      skillCard('sc2', 'T2'),
      dmItem('dm2', 'T2'),
    ]
    const view = buildRevealView(items, emptyRollReveal)
    expect(view.phaseByKey.sc1).toBe('released') // T2's card is visible below it
    expect(view.phaseByKey.sc2).toBe('idle') // the tail card keeps its theatre
    expect(view.gatedTurnIds.has('T2')).toBe(true)
    expect(view.gatedTurnIds.has('T1')).toBe(false)
  })

  it("the demotion probe looks PAST a later turn's gated prose to that turn's own visible card", () => {
    // T2 streams its prose BEFORE its check card (the in-turn order). T1's card
    // must not stop at the invisible gated prose: the next VISIBLE item is T2's
    // card, which demotes T1's theatre; T2's own card stays armed at the tail.
    const items: readonly TranscriptItem[] = [
      skillCard('sc1', 'T1'),
      dmItem('dm2', 'T2'),
      skillCard('sc2', 'T2'),
    ]
    const view = buildRevealView(items, emptyRollReveal)
    expect(view.phaseByKey.sc1).toBe('released')
    expect(view.phaseByKey.sc2).toBe('idle')
    expect(view.gatedTurnIds.has('T2')).toBe(true)
    expect(view.gatedTurnIds.has('T1')).toBe(false)
  })

  it('an armed dice_roll (flavor) card also demotes when a later turn renders below it', () => {
    const items: readonly TranscriptItem[] = [diceCard('dr1', 'T1'), playerItem('p1')]
    expect(buildRevealView(items, emptyRollReveal).phaseByKey.dr1).toBe('released')
  })
})

describe('useRollReveal', () => {
  it('(g) exposes roll/advance that drive the reducer state', () => {
    const { result } = renderHook(() => useRollReveal())
    expect(result.current.state).toBe(emptyRollReveal)

    act(() => {
      result.current.roll('k1')
    })
    expect(result.current.state.rolled.has('k1')).toBe(true)

    act(() => {
      result.current.advance('k1')
    })
    expect(result.current.state.continued.has('k1')).toBe(true)
  })
})
