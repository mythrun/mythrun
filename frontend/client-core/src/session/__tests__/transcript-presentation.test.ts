import { describe, it, expect } from 'vitest'
import type { TranscriptItem } from '../transcript-types.ts'
import type { RollRevealView } from '../roll-reveal.ts'
import {
  DM_TOKEN,
  isDmSummon,
  orderForDisplay,
  buildTableTalkView,
} from '../transcript-presentation.ts'

// transcript-presentation (ux-run3) — the two pure display derivations the play
// route computes and passes to MessageStream as plain data (R1):
//   • orderForDisplay (myth-twraw): a RELEASED roll card settles into its CAUSAL
//     slot — before its own turn's prose — so the durable transcript never reads
//     effect-before-cause (the FT may stream prose before the roll tool call, so
//     arrival order can put the card AFTER the prose it caused).
//   • buildTableTalkView (myth-1msig): the @dm question + its answering DM turn
//     group into one marked TABLE TALK block, so the fiction/meta boundary
//     survives reread. Keyed off the explicit `@dm` token (a UI command — the
//     sanctioned ZFC exception), mirroring the backend summon classifier.

function dm(key: string, turnId: string, text = 'prose'): TranscriptItem {
  return { kind: 'dm', key, turnId, text, streaming: false }
}

function player(key: string, text: string): TranscriptItem {
  return {
    kind: 'player',
    key,
    turnId: null,
    seq: null,
    userId: 'u1',
    displayName: 'Ada',
    characterName: 'Corin',
    text,
    pending: false,
  }
}

function skillCheck(key: string, turnId: string): TranscriptItem {
  return {
    kind: 'skill_check',
    key,
    turnId,
    frame: {
      type: 'skill_check',
      turnId,
      characterName: 'Corin',
      skill: 'arcana',
      context: 'reading the cipher',
      roll: 11,
      roll2: null,
      rollType: 'normal',
      modifier: 5,
      total: 16,
      dc: 13,
      outcomeTier: 'success',
      constraint: 'seed',
    },
  }
}

function diceRoll(key: string, turnId: string): TranscriptItem {
  return {
    kind: 'dice_roll',
    key,
    turnId,
    frame: { type: 'dice_roll', turnId, count: 2, sides: 6, results: [3, 4], total: 7 },
  }
}

function reveal(phaseByKey: RollRevealView['phaseByKey']): RollRevealView {
  return { phaseByKey, gatedTurnIds: new Set<string>() }
}

describe('orderForDisplay (myth-twraw — the causal receipt slot)', () => {
  it('moves a released card before its own turn’s first prose segment', () => {
    const items = [player('p1', 'I read the cipher.'), dm('d1', 'T1'), skillCheck('c1', 'T1')]
    const out = orderForDisplay(items, reveal({ c1: 'released' }))
    expect(out.map((it) => it.key)).toEqual(['p1', 'c1', 'd1'])
  })

  it('leaves an un-released card in arrival order (the live gesture is untouched)', () => {
    const items = [player('p1', 'go'), dm('d1', 'T1'), skillCheck('c1', 'T1')]
    for (const phase of ['idle', 'revealed'] as const) {
      expect(orderForDisplay(items, reveal({ c1: phase }))).toBe(items)
    }
  })

  it('returns the same array when the card already sits in its causal slot', () => {
    const items = [player('p1', 'go'), skillCheck('c1', 'T1'), dm('d1', 'T1')]
    expect(orderForDisplay(items, reveal({ c1: 'released' }))).toBe(items)
  })

  it('files the card before the FIRST of several prose segments of its turn', () => {
    const items = [dm('d1', 'T1'), skillCheck('c1', 'T1'), dm('d2', 'T1')]
    const out = orderForDisplay(items, reveal({ c1: 'released' }))
    expect(out.map((it) => it.key)).toEqual(['c1', 'd1', 'd2'])
  })

  it('never crosses another turn’s items or player rows', () => {
    const items = [
      dm('d0', 'T0'),
      player('p1', 'go'),
      dm('d1', 'T1'),
      skillCheck('c1', 'T1'),
      dm('d2', 'T2'),
    ]
    const out = orderForDisplay(items, reveal({ c1: 'released' }))
    expect(out.map((it) => it.key)).toEqual(['d0', 'p1', 'c1', 'd1', 'd2'])
  })

  it('a released dice_roll (the flavor variant) files causally too', () => {
    const items = [dm('d1', 'T1'), diceRoll('r1', 'T1')]
    const out = orderForDisplay(items, reveal({ r1: 'released' }))
    expect(out.map((it) => it.key)).toEqual(['r1', 'd1'])
  })

  it('a turn with no prose leaves the card where it stands', () => {
    const items = [player('p1', 'go'), skillCheck('c1', 'T1')]
    expect(orderForDisplay(items, reveal({ c1: 'released' }))).toBe(items)
  })

  it('two released cards of one turn keep their relative order in the causal slot', () => {
    const items = [dm('d1', 'T1'), skillCheck('c1', 'T1'), diceRoll('r1', 'T1')]
    const out = orderForDisplay(items, reveal({ c1: 'released', r1: 'released' }))
    expect(out.map((it) => it.key)).toEqual(['c1', 'r1', 'd1'])
  })
})

describe('isDmSummon (the backend-mirrored token gate)', () => {
  it('matches the bare token, a prefixed question, leading whitespace, and any case', () => {
    expect(isDmSummon(DM_TOKEN)).toBe(true)
    expect(isDmSummon('@dm what does the key open?')).toBe(true)
    expect(isDmSummon('  @dm hello')).toBe(true)
    expect(isDmSummon('@DM hello')).toBe(true)
  })

  it('rejects ordinary in-fiction messages', () => {
    expect(isDmSummon('I walk the orrery floor.')).toBe(false)
    expect(isDmSummon('ask the @dm later')).toBe(false)
  })
})

describe('buildTableTalkView (myth-1msig — the marked OOC exchange)', () => {
  it('groups the @dm question with its answering turn’s prose segments', () => {
    const items = [
      player('q1', '@dm what does the key open?'),
      dm('a1', 'TT1', 'Not common knowledge at your tier.'),
      dm('a2', 'TT1', 'Back to you.'),
    ]
    const { blockByKey } = buildTableTalkView(items)
    expect(blockByKey.q1).toBe(0)
    expect(blockByKey.a1).toBe(0)
    expect(blockByKey.a2).toBe(0)
  })

  it('leaves ordinary player messages and un-summoned DM turns unframed', () => {
    const items = [player('p1', 'I read the cipher.'), dm('d1', 'T1')]
    expect(buildTableTalkView(items).blockByKey).toEqual({})
  })

  it('a different turn’s prose never joins the exchange', () => {
    const items = [player('q1', '@dm hello?'), dm('a1', 'TT1'), dm('d1', 'T2')]
    const { blockByKey } = buildTableTalkView(items)
    expect(blockByKey.a1).toBe(0)
    expect(blockByKey.d1).toBeUndefined()
  })

  it('an intervening in-fiction message ends the pending exchange (question framed alone)', () => {
    const items = [player('q1', '@dm hello?'), player('p1', 'I keep walking.'), dm('d1', 'T1')]
    const { blockByKey } = buildTableTalkView(items)
    expect(blockByKey.q1).toBe(0)
    expect(blockByKey.p1).toBeUndefined()
    expect(blockByKey.d1).toBeUndefined()
  })

  it('a mechanical item interrupts the exchange (the answer never spans a roll)', () => {
    const items = [player('q1', '@dm hello?'), skillCheck('c1', 'T1'), dm('d1', 'T1')]
    const { blockByKey } = buildTableTalkView(items)
    expect(blockByKey.q1).toBe(0)
    expect(blockByKey.d1).toBeUndefined()
  })

  it('two questions mint two distinct blocks', () => {
    const items = [
      player('q1', '@dm one?'),
      dm('a1', 'TT1'),
      player('q2', '@dm two?'),
      dm('a2', 'TT2'),
    ]
    const { blockByKey } = buildTableTalkView(items)
    expect(blockByKey.q1).toBe(0)
    expect(blockByKey.a1).toBe(0)
    expect(blockByKey.q2).toBe(1)
    expect(blockByKey.a2).toBe(1)
  })
})
