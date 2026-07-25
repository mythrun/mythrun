import { describe, it, expect } from 'vitest'
import type { RollRevealView, TranscriptItem } from '@mythrun/client-core/contract'
import {
  composeSummon,
  composerGate,
  connectionLineStatus,
  resolveTypingNames,
  isDmWriting,
  latestLiveLongRestTurn,
  DM_TOKEN,
} from './session-compose.ts'

// The pure route-wire helpers behind the live-play shell (MYT-92 T16). No React —
// these fold transport-delivered data into the exact strings/names the shell hands
// the @mythrun/ui components.

describe('composeSummon', () => {
  it('prepends the @dm token to the typed text', () => {
    expect(composeSummon('open the door')).toBe('@dm open the door')
  })

  it('trims surrounding whitespace before composing', () => {
    expect(composeSummon('  look around  ')).toBe('@dm look around')
  })

  it('summons with the bare token when the field is empty or blank', () => {
    expect(composeSummon('')).toBe(DM_TOKEN)
    expect(composeSummon('   ')).toBe(DM_TOKEN)
  })
})

describe('connectionLineStatus', () => {
  it('maps the two live-trouble statuses to a line token', () => {
    expect(connectionLineStatus('reconnecting')).toBe('reconnecting')
    expect(connectionLineStatus('failed')).toBe('failed')
  })

  it('renders no line for the settled statuses', () => {
    expect(connectionLineStatus('connecting')).toBeNull()
    expect(connectionLineStatus('connected')).toBeNull()
    expect(connectionLineStatus('closed')).toBeNull()
  })
})

describe('resolveTypingNames', () => {
  const party = new Map([
    ['u1', 'Ada'],
    ['u2', 'Bram'],
  ])

  it('maps known ids to their roster display names', () => {
    expect(resolveTypingNames(['u1', 'u2'], party)).toEqual(['Ada', 'Bram'])
  })

  it('omits ids with no roster entry rather than rendering a raw id', () => {
    expect(resolveTypingNames(['u1', 'ghost'], party)).toEqual(['Ada'])
  })

  it('is empty when nobody is typing', () => {
    expect(resolveTypingNames([], party)).toEqual([])
  })
})

// ── myth-dd63v / myth-lhp99 transcript-derived play signals ──────────────────

function dm(key: string, streaming: boolean): TranscriptItem {
  return { kind: 'dm', key, turnId: `t-${key}`, text: 'The corridor bends.', streaming }
}
function rest(key: string, restType: 'short' | 'long', opts: { seq?: number } = {}): TranscriptItem {
  return {
    kind: 'ledger_update',
    key,
    turnId: `t-${key}`,
    frame: {
      type: 'ledger_update',
      turnId: `t-${key}`,
      characterName: 'Wren Osser',
      kind: 'rest',
      restType,
      summary: `Wren Osser finishes a ${restType} rest.`,
      ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    },
  }
}

const NO_GATE: ReadonlySet<string> = new Set()

describe('isDmWriting (myth-dd63v / myth-0q8jm)', () => {
  it('is true while the DM is thinking (pre-first-delta)', () => {
    expect(isDmWriting([], true, NO_GATE)).toBe(true)
  })

  it('is true while a dm row is still streaming (post-first-delta)', () => {
    expect(isDmWriting([dm('a', true)], false, NO_GATE)).toBe(true)
  })

  it('is false once the turn has settled (no thinking, no streaming row)', () => {
    expect(isDmWriting([dm('a', false)], false, NO_GATE)).toBe(false)
  })

  it('is false while the only streaming row is GATED (buffered prose is not visible writing)', () => {
    // myth-0q8jm: with a check pending, the post-check prose streams invisibly
    // behind the gate — "The DM is writing…" would tell the player to wait when
    // the game is waiting on THEM.
    expect(isDmWriting([dm('a', true)], false, new Set(['t-a']))).toBe(false)
  })
})

// ── myth-0q8jm: the composer gate state machine ──────────────────────────────
//
// The status line must reflect the BLOCKING PARTY at every point of the turn
// state machine. The full enumeration:
//   idle          → nobody blocks; Send is live, no caption
//   dmWriting     → the DM blocks (thinking, or tokens VISIBLY streaming)
//   awaitRoll     → the player blocks: a check is issued, the d20 unrolled
//   awaitContinue → the player blocks: the roll is revealed, Continue pending
//   ending        → the session end is in flight; everything gates
describe('composerGate (myth-0q8jm)', () => {
  const check = (key: string, turnId: string): TranscriptItem => ({
    kind: 'skill_check',
    key,
    turnId,
    frame: {
      type: 'skill_check',
      turnId,
      characterName: 'Wren Osser',
      skill: 'investigation',
      context: 'reading the wall script',
      roll: 11,
      roll2: null,
      rollType: 'normal',
      modifier: 0,
      total: 11,
      dc: 12,
      outcomeTier: 'fail',
      constraint: 'the glyphs blur',
    },
  })
  const view = (phaseByKey: RollRevealView['phaseByKey'], gated: readonly string[] = []): RollRevealView => ({
    phaseByKey,
    gatedTurnIds: new Set(gated),
  })
  const EMPTY_VIEW = view({})

  it('idle: a settled transcript gates nothing', () => {
    expect(composerGate([dm('a', false)], false, EMPTY_VIEW, false)).toBe('idle')
  })

  it('dmWriting: while thinking, and while a dm row visibly streams', () => {
    expect(composerGate([], true, EMPTY_VIEW, false)).toBe('dmWriting')
    expect(composerGate([dm('a', true)], false, EMPTY_VIEW, false)).toBe('dmWriting')
  })

  it('awaitRoll: an idle check outranks the invisibly-streaming gated prose (the player blocks)', () => {
    const items = [check('sc1', 'T1'), { ...dm('x', true), turnId: 'T1' } as TranscriptItem]
    const gate = composerGate(items, false, view({ sc1: 'idle' }, ['T1']), false)
    expect(gate).toBe('awaitRoll')
  })

  it('awaitContinue: a revealed check names the real pending act', () => {
    const items = [check('sc1', 'T1')]
    expect(composerGate(items, false, view({ sc1: 'revealed' }, ['T1']), false)).toBe('awaitContinue')
  })

  it('after Continue (released) the gate falls through to the visible stream, then to idle', () => {
    const streamingTail = [check('sc1', 'T1'), { ...dm('x', true), turnId: 'T1' } as TranscriptItem]
    expect(composerGate(streamingTail, false, view({ sc1: 'released' }), false)).toBe('dmWriting')
    const settled = [check('sc1', 'T1'), { ...dm('x', false), turnId: 'T1' } as TranscriptItem]
    expect(composerGate(settled, false, view({ sc1: 'released' }), false)).toBe('idle')
  })

  it('ending outranks everything', () => {
    const items = [check('sc1', 'T1')]
    expect(composerGate(items, true, view({ sc1: 'idle' }, ['T1']), true)).toBe('ending')
  })

  it('a dice_roll (flavor) card never gates the composer', () => {
    const dice: TranscriptItem = {
      kind: 'dice_roll',
      key: 'dr1',
      turnId: 'T1',
      frame: { type: 'dice_roll', turnId: 'T1', count: 2, sides: 6, results: [3, 4], total: 7 },
    }
    expect(composerGate([dice], false, view({ dr1: 'idle' }), false)).toBe('idle')
  })
})

describe('latestLiveLongRestTurn (myth-lhp99)', () => {
  it('returns the turnId of a LIVE long rest', () => {
    expect(latestLiveLongRestTurn([rest('r1', 'long')])).toBe('t-r1')
  })

  it('ignores a short rest', () => {
    expect(latestLiveLongRestTurn([rest('r1', 'short')])).toBeNull()
  })

  it('ignores a REPLAYED long rest (carries a seq — a past rest must not re-offer)', () => {
    expect(latestLiveLongRestTurn([rest('r1', 'long', { seq: 42 })])).toBeNull()
  })

  it('collapses a per-participant burst to the single shared turnId', () => {
    // Two party members finish the same long rest — same turnId, one offer.
    const burst = [rest('rA', 'long'), { ...rest('rB', 'long'), turnId: 't-rA' } as TranscriptItem]
    expect(latestLiveLongRestTurn(burst)).toBe('t-rA')
  })

  it('is null when there is no rest at all', () => {
    expect(latestLiveLongRestTurn([dm('a', false)])).toBeNull()
  })
})
