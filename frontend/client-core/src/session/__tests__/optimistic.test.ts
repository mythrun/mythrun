import { describe, it, expect } from 'vitest'
import type { ServerFrame } from '@mythrun/contract/events'
import type { TranscriptItem, TranscriptState } from '../transcript-types.ts'
import { emptyTranscript } from '../transcript-types.ts'
import { addPending, reduceFrameReconciling, unconfirmedPending } from '../optimistic.ts'

// --- typed ServerFrame builders (mirrors transcript-reducer.test.ts) ---

type F<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>

const VIEWER = 'me'

const player = (
  seq: number,
  text: string,
  userId = VIEWER,
  displayName = 'Dee',
  characterName = 'Cee',
): F<'player_message'> => ({ type: 'player_message', seq, userId, displayName, characterName, text })

const textDelta = (turnId: string, text: string): F<'text_delta'> => ({ type: 'text_delta', turnId, text })

const reconnect = (messages: ServerFrame[]): F<'session_reconnect'> => ({
  type: 'session_reconnect',
  messages,
  participants: [],
  mode: 'exploration',
})

const pendingInput = (localId: string, text: string, viewerUserId = VIEWER) => ({
  localId,
  text,
  viewerUserId,
  displayName: 'Dee',
  characterName: 'Cee',
})

const isPlayer = (i: TranscriptItem): i is Extract<TranscriptItem, { kind: 'player' }> => i.kind === 'player'
const playerItems = (s: TranscriptState): Extract<TranscriptItem, { kind: 'player' }>[] => s.items.filter(isPlayer)

describe('addPending', () => {
  it('(a) appends a pending own player item keyed on the localId', () => {
    const s = addPending(emptyTranscript, pendingInput('L1', 'hi'))
    expect(s.items).toMatchObject([
      {
        kind: 'player',
        key: 'pending:L1',
        turnId: null,
        seq: null,
        userId: 'me',
        displayName: 'Dee',
        characterName: 'Cee',
        text: 'hi',
        pending: true,
      },
    ])
    // pending items do not consume a minted key — nextId / seqSeen are untouched.
    expect(s.nextId).toBe(0)
    expect(s.seqSeen.size).toBe(0)
  })
})

describe('reduceFrameReconciling — own-echo reconcile', () => {
  it('(b) confirms the matching pending item in place, records the seq, and adds no duplicate', () => {
    const pending = addPending(emptyTranscript, pendingInput('L1', 'hi'))
    const s = reduceFrameReconciling(pending, player(5, 'hi', VIEWER, 'DeeServer', 'CeeServer'), VIEWER)
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({
      kind: 'player',
      key: 'pending:L1', // key preserved so React reuses the node
      pending: false,
      seq: 5,
      displayName: 'DeeServer', // server-authoritative identity overwrites the optimistic guess
      characterName: 'CeeServer',
      text: 'hi',
      turnId: null,
    })
    expect(s.seqSeen.has(5)).toBe(true) // seqSeen invariant held: a redelivered echo now dedups
  })

  it('(c) two pending "hi" reconcile FIFO — the first echo confirms the first pending', () => {
    let s = addPending(emptyTranscript, pendingInput('A', 'hi'))
    s = addPending(s, pendingInput('B', 'hi'))

    s = reduceFrameReconciling(s, player(5, 'hi'), VIEWER)
    let items = playerItems(s)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'pending:A', pending: false, seq: 5 })
    expect(items[1]).toMatchObject({ key: 'pending:B', pending: true, seq: null })

    s = reduceFrameReconciling(s, player(6, 'hi'), VIEWER)
    items = playerItems(s)
    expect(items[1]).toMatchObject({ key: 'pending:B', pending: false, seq: 6 })
  })

  it('(d) a same-text player_message from ANOTHER user appends a new item and leaves ours pending', () => {
    const pending = addPending(emptyTranscript, pendingInput('A', 'hi'))
    const s = reduceFrameReconciling(pending, player(7, 'hi', 'other', 'Oth', 'OthChar'), VIEWER)
    const items = playerItems(s)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'pending:A', pending: true, userId: 'me' })
    expect(items[1]).toMatchObject({ pending: false, seq: 7, userId: 'other' })
  })

  it('an own echo with no matching pending appends a confirmed item (delegates to reduceFrame)', () => {
    const s = reduceFrameReconciling(emptyTranscript, player(3, 'orphan'), VIEWER)
    expect(s.items).toMatchObject([{ kind: 'player', pending: false, seq: 3, text: 'orphan' }])
    expect(s.seqSeen.has(3)).toBe(true)
  })

  it('delegates a non-player frame to reduceFrame and leaves pending items untouched', () => {
    const pending = addPending(emptyTranscript, pendingInput('A', 'hi'))
    const s = reduceFrameReconciling(pending, textDelta('T', 'dm text'), VIEWER)
    expect(playerItems(s)).toHaveLength(1)
    expect(playerItems(s)[0]).toMatchObject({ pending: true })
    expect(s.items.some((i) => i.kind === 'dm')).toBe(true)
  })
})

describe('reduceFrameReconciling — own echo INSIDE a session_reconnect batch', () => {
  it('(f) reconciles the pending item against its echo in the batch (no duplicate)', () => {
    const pending = addPending(emptyTranscript, pendingInput('A', 'hi'))
    // The whole-turn-replace prune keeps turnId:null items (our pending survives),
    // then the batch fold routes the own echo through the reconciling folder.
    const s = reduceFrameReconciling(pending, reconnect([player(5, 'hi', VIEWER, 'DeeServer', 'CeeServer')]), VIEWER)
    const items = playerItems(s)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'pending:A', pending: false, seq: 5, displayName: 'DeeServer', text: 'hi' })
    expect(s.seqSeen.has(5)).toBe(true)
  })

  it('(f-variant) another user\'s message in the batch appends normally and our pending survives for the resend', () => {
    const pending = addPending(emptyTranscript, pendingInput('A', 'hi'))
    const s = reduceFrameReconciling(pending, reconnect([player(6, 'hi', 'other', 'Oth', 'OthChar')]), VIEWER)
    const items = playerItems(s)
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.key === 'pending:A')).toMatchObject({ pending: true })
    expect(items.find((i) => i.userId === 'other')).toMatchObject({ pending: false, seq: 6 })
    expect(unconfirmedPending(s, VIEWER)).toEqual([{ localId: 'A', text: 'hi' }])
  })
})

describe('unconfirmedPending', () => {
  it('(e) lists only still-pending own items (localId recovered from the key)', () => {
    let s = addPending(emptyTranscript, pendingInput('A', 'first'))
    s = addPending(s, pendingInput('X', 'theirs', 'other')) // pending, but a DIFFERENT user
    s = reduceFrameReconciling(s, player(1, 'settled'), VIEWER) // own echo w/ no pending match → confirmed own
    s = reduceFrameReconciling(s, textDelta('T', 'dm text'), VIEWER) // a non-player (dm) item

    expect(unconfirmedPending(s, VIEWER)).toEqual([{ localId: 'A', text: 'first' }])
  })

  it('returns an empty list when nothing of the viewer is pending', () => {
    const s = reduceFrameReconciling(emptyTranscript, player(1, 'done'), VIEWER)
    expect(unconfirmedPending(s, VIEWER)).toEqual([])
  })
})
