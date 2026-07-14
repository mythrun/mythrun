import { describe, it, expect } from 'vitest'
import type { ServerFrame } from '@mythrun/contract/events'
import type { TranscriptItem, TranscriptState } from '../transcript-types.ts'
import { emptyTranscript } from '../transcript-types.ts'
import { reduceFrame } from '../transcript-reducer.ts'

// --- typed ServerFrame builders (self-contained; live = no seq, row = +seq) ---

type F<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>

const textDelta = (turnId: string, text: string): F<'text_delta'> => ({ type: 'text_delta', turnId, text })
const turnEnd = (turnId: string): F<'turn_end'> => ({ type: 'turn_end', turnId })
const turnError = (turnId: string, message = 'boom'): F<'turn_error'> => ({ type: 'turn_error', turnId, message })
const dmMessage = (seq: number, turnId: string, text: string): F<'dm_message'> => ({ type: 'dm_message', seq, turnId, text })
const player = (seq: number, text: string, userId = 'u1'): F<'player_message'> => ({
  type: 'player_message', seq, userId, displayName: 'Dee', characterName: 'Cee', text,
})

const skillLive = (turnId: string): F<'skill_check'> => ({
  type: 'skill_check', turnId, characterName: 'Cee', skill: 'perception', context: 'a tense moment',
  roll: 12, roll2: null, rollType: 'normal', modifier: 2, total: 14, dc: 12,
  outcomeTier: 'success', constraint: 'you notice the tripwire',
})
const skillRow = (seq: number, turnId: string): F<'skill_check'> => ({ ...skillLive(turnId), seq })
const diceLive = (turnId: string): F<'dice_roll'> => ({ type: 'dice_roll', turnId, count: 2, sides: 6, results: [3, 5], total: 8 })
const ledgerLive = (turnId: string): F<'ledger_update'> => ({ type: 'ledger_update', turnId, characterName: 'Cee', kind: 'hp', summary: '-3 hp', hp: 7, maxHp: 10 })
const modeNoTurn = (): F<'mode_change'> => ({ type: 'mode_change', from: 'exploration', to: 'combat', reason: 'ambush' })
const modeWithTurn = (turnId: string): F<'mode_change'> => ({ type: 'mode_change', turnId, from: 'exploration', to: 'combat', reason: 'ambush' })
const combatStartedLive = (turnId: string): F<'combat_started'> => ({
  type: 'combat_started', turnId,
  enemies: [{ name: 'Goblin', description: 'small + mean', count: 2 }],
  initiative: [{ combatant: 'Goblin', roll: 12 }],
})
const combatResolvedLive = (turnId: string): F<'combat_resolved'> => ({
  type: 'combat_resolved', turnId, narration: 'won', outcome: 'victory', casualties: [], hpChanges: [],
})
const reconnect = (messages: ServerFrame[]): F<'session_reconnect'> => ({
  type: 'session_reconnect', messages, participants: [], mode: 'exploration',
})

const dmThinking = (turnId: string): F<'dm_thinking'> => ({ type: 'dm_thinking', turnId })
const typingStart = (userId = 'u2'): F<'typing_start'> => ({ type: 'typing_start', userId })
const playerJoined = (): F<'player_joined'> => ({ type: 'player_joined', userId: 'u2', displayName: 'D2', characterName: 'C2' })
const errorFrame = (): F<'error'> => ({ type: 'error', message: 'oops' })

const fold = (frames: ServerFrame[]): TranscriptState => frames.reduce(reduceFrame, emptyTranscript)
const isDm = (i: TranscriptItem): i is Extract<TranscriptItem, { kind: 'dm' }> => i.kind === 'dm'
const dmItems = (s: TranscriptState): Extract<TranscriptItem, { kind: 'dm' }>[] => s.items.filter(isDm)

describe('reduceFrame — DM prose streaming', () => {
  it('(a) accumulates two same-turn text_deltas into one streaming dm item', () => {
    const s = fold([textDelta('T', 'Hello '), textDelta('T', 'world')])
    expect(dmItems(s)).toMatchObject([{ turnId: 'T', text: 'Hello world', streaming: true }])
    expect(s.items).toHaveLength(1)
  })

  it('(b) turn_end settles the matching dm item to streaming:false', () => {
    const s = fold([textDelta('T', 'hi'), turnEnd('T')])
    expect(dmItems(s)).toMatchObject([{ turnId: 'T', streaming: false }])
  })

  it('(b) turn_error also settles the matching dm item', () => {
    const s = fold([textDelta('T', 'hi'), turnError('T')])
    expect(dmItems(s)).toMatchObject([{ turnId: 'T', streaming: false }])
  })
})

describe('reduceFrame — mechanical frames modeled first-class', () => {
  it('(c) skill_check appends a first-class item carrying the whole frame', () => {
    const frame = skillLive('T')
    const s = reduceFrame(emptyTranscript, frame)
    expect(s.items).toMatchObject([{ kind: 'skill_check', turnId: 'T', frame }])
    expect(s.items[0]?.key).toEqual(expect.any(String))
  })

  it('(c) dice_roll / ledger_update / combat_started / combat_resolved each append their kind', () => {
    const dice = diceLive('T')
    const ledger = ledgerLive('T')
    const cStart = combatStartedLive('T')
    const cEnd = combatResolvedLive('T')
    const s = fold([dice, ledger, cStart, cEnd])
    expect(s.items).toMatchObject([
      { kind: 'dice_roll', turnId: 'T', frame: dice },
      { kind: 'ledger_update', turnId: 'T', frame: ledger },
      { kind: 'combat_started', turnId: 'T', frame: cStart },
      { kind: 'combat_resolved', turnId: 'T', frame: cEnd },
    ])
  })

  it('(c) mode_change with a turnId carries it; turn-less mode_change items key turnId:null', () => {
    const withTurn = modeWithTurn('T')
    const noTurn = modeNoTurn()
    const s = fold([withTurn, noTurn])
    expect(s.items).toMatchObject([
      { kind: 'mode_change', turnId: 'T', frame: withTurn },
      { kind: 'mode_change', turnId: null, frame: noTurn },
    ])
  })
})

describe('reduceFrame — player messages', () => {
  it('(d) appends a confirmed player item and dedups a duplicate seq', () => {
    const s1 = reduceFrame(emptyTranscript, player(5, 'hi'))
    expect(s1.items).toMatchObject([
      { kind: 'player', seq: 5, userId: 'u1', displayName: 'Dee', characterName: 'Cee', text: 'hi', pending: false, turnId: null },
    ])
    const s2 = reduceFrame(s1, player(5, 'hi again'))
    expect(s2).toBe(s1) // duplicate seq returns the same state
  })
})

describe('reduceFrame — out-of-band frames are ignored (owned by useSession)', () => {
  it('(e) leaves the transcript unchanged for control/presence frames', () => {
    const base = fold([textDelta('T', 'hi')])
    for (const frame of [dmThinking('T'), typingStart(), playerJoined(), errorFrame()]) {
      expect(reduceFrame(base, frame)).toBe(base)
    }
  })
})

describe('reduceFrame — session_reconnect whole-turn replace', () => {
  it('(f) replaces a live partial turn with the seq-bearing replay so it renders once', () => {
    // Pre-state: a settled dm (turn A), a confirmed player, and a live streaming dm (turn T).
    const live = fold([dmMessage(2, 'A', 'alpha'), player(1, 'hi'), textDelta('T', 'partial')])
    expect(dmItems(live).filter((d) => d.turnId === 'T')).toMatchObject([{ streaming: true }])

    // Reconnect batch: a no-turn player + a turn-less combat ('') exercise the turnId
    // guards; the turn-T rows rebuild the turn settled.
    const batch: ServerFrame[] = [player(5, 'joined'), combatStartedLive(''), dmMessage(9, 'T', 'final'), skillRow(10, 'T')]
    const s = reduceFrame(live, reconnect(batch))

    const turnT = dmItems(s).filter((d) => d.turnId === 'T')
    expect(turnT).toMatchObject([{ turnId: 'T', text: 'final', streaming: false }]) // exactly one, settled
    expect(s.items.filter((i) => i.kind === 'skill_check')).toHaveLength(1)
    expect(dmItems(s).filter((d) => d.turnId === 'A')).toMatchObject([{ text: 'alpha' }]) // untouched turn survives
    expect(s.items.filter((i) => i.kind === 'player')).toHaveLength(2) // seq 1 kept + seq 5 added
    expect(s.items.filter((i) => i.kind === 'combat_started')).toHaveLength(1) // turnId '' not treated as a turn key
  })

  it('(g) first join: an empty transcript builds the mixed backlog in batch order', () => {
    const batch: ServerFrame[] = [player(1, 'a'), dmMessage(2, 'T1', 'x'), skillRow(3, 'T1'), player(4, 'b')]
    const s = reduceFrame(emptyTranscript, reconnect(batch))
    expect(s.items).toMatchObject([
      { kind: 'player', seq: 1, text: 'a' },
      { kind: 'dm', turnId: 'T1', text: 'x', streaming: false },
      { kind: 'skill_check', turnId: 'T1' },
      { kind: 'player', seq: 4, text: 'b' },
    ])
  })
})

describe('reduceFrame — delta targeting + settle among multiple items', () => {
  it('routes a delta to the right dm item and settles only the matching turn', () => {
    // items order: dm(A) streaming, player, dm(B) streaming
    let s = fold([textDelta('A', 'alpha'), player(1, 'hi'), textDelta('B', 'beta ')])
    s = reduceFrame(s, textDelta('B', 'more')) // appends to dm(B), scanning past dm(A) + player

    expect(dmItems(s)).toMatchObject([
      { turnId: 'A', text: 'alpha', streaming: true },
      { turnId: 'B', text: 'beta more', streaming: true },
    ])

    s = reduceFrame(s, turnEnd('B')) // settles only dm(B), leaving dm(A) streaming
    expect(dmItems(s)).toMatchObject([
      { turnId: 'A', streaming: true },
      { turnId: 'B', streaming: false },
    ])

    s = reduceFrame(s, turnError('A')) // settle dm(A) via the turn_error path
    expect(dmItems(s)).toMatchObject([
      { turnId: 'A', streaming: false },
      { turnId: 'B', streaming: false },
    ])
  })
})
