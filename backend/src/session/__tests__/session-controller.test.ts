// backend/src/session/__tests__/session-controller.test.ts
//
// MYT-68 Task 14 / MYT-69 Task 13 — the SessionController v2 (PG-direct turn
// model) suite, narrowed for the POST-HOC SlowThinker.
//
// The transcript now lives ONLY in session_messages. The controller loads the
// WHOLE FT context via `transcript.listFtContextRows(sessionId, maxConsumedSeq)`
// and maps it through the real `rowsToConversation` codec (§3.7). It no longer
// appends a trigger batch (the payload's triggerMessages serve only the MYT-67
// classifier, which the controller never sees), and it no longer publishes
// `turn_end` (that moved to the worker, after persist+flush+watermark). The
// single PG append in `persistTurn` is the durability point.
//
// MYT-69 retires the in-turn ST seam: the ST runs OFF the turn path in its own
// worker. The controller no longer has an `st` dep, no `applyEvaluation`, no
// summary handling, and no evaluation-based fusion. Directions arrive as
// worker-resolved deps: `pendingDirection` (one-shot, GETDEL'd by the worker
// and fused onto the last user message BEFORE the FT render) and
// `standingDirective` (threaded onto `FtTurnContext`; the FT appends the tail).
//
// Everything below is exercised against in-memory fakes — no Redis-mock for the
// turn-state writes (a recording fake SessionState proves `flushToRedis` writes
// exactly {usage}), and an in-memory TranscriptStore captures the
// listFtContextRows query + the appendDmTurn payload.

import { describe, expect, it, vi } from 'vitest'
import { rowsToConversation } from '../transcript-codec.js'
import {
  fuseDirectionIntoLastUserMessage,
  SessionController,
  type SessionControllerDeps,
  type TranscriptStore,
} from '../session-controller.js'
import type { SessionMessage } from '../../repo/types.js'
import type { SessionState, TurnState } from '../../redis/session-state.js'
import type {
  AssistantMessage,
  ConversationMessage,
  FastThinker,
  FtTurnContext,
  Scribe,
  ScribeResult,
  TurnEmitter,
} from '../tiers/types.js'

const CAMPAIGN = 'c-ctrl-1'
const SESSION = 's-ctrl-1'
const TURN = 't-ctrl-1'
const FT_CONTEXT = 'the enforced-ignorance-safe prep doc'

const ATTRIBUTION_NAMES: ReadonlyMap<string, string> = new Map([
  ['u1', 'Mara'],
  ['u2', 'Bram'],
])

/** Text of a ConversationMessage's first content part (the user/DM messages
 *  this suite inspects are single-text-part), or undefined. */
function firstTextPart(msg: FtTurnContext['ftHistory'][number] | undefined): string | undefined {
  const part = msg?.parts[0]
  return part?.kind === 'text' ? part.text : undefined
}

// ---------------------------------------------------------------------------
// Fixtures. session_messages rows that listFtContextRows returns; the real
// codec maps them, so the expected ftHistory is always built via the SAME
// `rowsToConversation` call on the SAME fixture — never hand-written.
// ---------------------------------------------------------------------------

function row(partial: Partial<SessionMessage> & { seq: number; messageType: string; content: string }): SessionMessage {
  return {
    id: `m-${String(partial.seq)}`,
    sessionId: SESSION,
    userId: partial.userId ?? null,
    turnId: partial.turnId ?? null,
    turnOrdinal: partial.turnOrdinal ?? null,
    createdAt: new Date(0),
    ...partial,
  }
}

const PLAYER_ROW = row({ seq: 1, userId: 'u1', messageType: 'player_message', content: 'I search the room' })

/** Two-message fixture: an earlier DM turn, then the player's current message. */
const HISTORY_ROWS: readonly SessionMessage[] = [
  row({ seq: 1, turnId: 'prior', turnOrdinal: 0, messageType: 'dm_text', content: 'You stand in the hall.' }),
  PLAYER_ROW,
]

// ---------------------------------------------------------------------------
// In-memory fakes.
// ---------------------------------------------------------------------------

interface AppendCapture {
  sessionId: string
  turnId: string
  rows: readonly { kind: string; content: string }[]
  seqs: readonly number[]
}

function fakeTranscript(
  rows: readonly SessionMessage[],
  capture: { listArgs?: { sessionId: string; maxPlayerSeq: number }; append?: AppendCapture },
): TranscriptStore {
  return {
    listFtContextRows: vi.fn((sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]> => {
      capture.listArgs = { sessionId, maxPlayerSeq }
      return Promise.resolve([...rows])
    }),
    appendDmTurn: vi.fn((input: AppendCapture): Promise<void> => {
      capture.append = input
      return Promise.resolve()
    }),
  }
}

function fakeFt(message: AssistantMessage, captured: { ctx?: FtTurnContext }): FastThinker {
  return {
    render: vi.fn(async (ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> => {
      captured.ctx = ctx
      await emit.emitText('chunk')
      return message
    }),
  }
}

function fakeScribe(): Scribe {
  return { extract: vi.fn((): Promise<ScribeResult> => Promise.resolve({ workingSetDeltas: [] })) }
}

function rejectingScribe(): Scribe {
  return { extract: vi.fn((): Promise<ScribeResult> => Promise.reject(new Error('scribe boom'))) }
}

/** Records every emitText so a test can assert the FT (and ONLY the FT) drove
 *  the emitter — there is no turn_end emission anywhere in the controller. */
function recordingEmitter(emitted: string[]): TurnEmitter {
  return {
    emitText: (text: string): Promise<void> => {
      emitted.push(text)
      return Promise.resolve()
    },
    emitSkillCheck: vi.fn((): Promise<void> => Promise.resolve()),
    emitDiceRoll: vi.fn((): Promise<void> => Promise.resolve()),
  }
}

/** What `flushToRedis` writes as of MYT-69: usage only (the `:summary` key is
 *  the ST job's artifact now — `flushTurnState`'s narrowed signature). */
interface FlushedTurnState {
  readonly usage: TurnState['usage']
}

/** A recording SessionState: only loadTurnState/flushTurnState are exercised by
 *  the controller (MYT-68: participants are a per-turn DEP now, not a getState
 *  read — so getState joins the `unused` throwers and an accidental call is
 *  loud). The rest throw so an accidental call is loud. */
function fakeSessionState(opts: {
  turnState?: TurnState
  flushed: { value?: FlushedTurnState }
}): SessionState {
  const unused = (name: string) => (): never => {
    throw new Error(`SessionState.${name} must not be called by the controller`)
  }
  return {
    loadTurnState: vi.fn((): Promise<TurnState> =>
      Promise.resolve(opts.turnState ?? { summary: '', usage: { input: 0, output: 0 } }),
    ),
    flushTurnState: vi.fn((_campaignId: string, ts: { readonly usage: TurnState['usage'] }): Promise<void> => {
      opts.flushed.value = ts
      return Promise.resolve()
    }),
    getState: unused('getState'),
    nextSeq: unused('nextSeq'),
    reseedSeq: unused('reseedSeq'),
    addPresence: unused('addPresence'),
    dropPresence: unused('dropPresence'),
    countPresence: unused('countPresence'),
    setState: unused('setState'),
    refreshTtls: unused('refreshTtls'),
    checkpoint: unused('checkpoint'),
    // MYT-69 §7 additions — the ST job owns these; the controller never calls
    // them, so they stay as throwing stubs.
    setRunningSummary: unused('setRunningSummary'),
    incrUsageSt: unused('incrUsageSt'),
    totalUsageTokens: unused('totalUsageTokens'),
    resetSessionSpend: unused('resetSessionSpend'),
  }
}

const ASSISTANT: AssistantMessage = {
  role: 'assistant',
  parts: [{ kind: 'text', text: 'The room is silent.' }],
  usage: { input: 5, output: 7 },
}

/** A scripted seq allocator: returns START, START+1, START+2, … in call order.
 *  Lets a test assert seqs are allocated SEQUENTIALLY (order matters). */
function scriptedAllocSeq(start: number): () => Promise<number> {
  let next = start
  return (): Promise<number> => Promise.resolve(next++)
}

interface BuildOpts {
  rows?: readonly SessionMessage[]
  pendingDirection?: string
  standingDirective?: string
  assistant?: AssistantMessage
  scribe?: Scribe
  turnState?: TurnState
  participants?: readonly string[]
  ftContext?: string
  allocStart?: number
  logger?: { warn: ReturnType<typeof vi.fn> }
}

function build(opts: BuildOpts = {}): {
  controller: SessionController
  capturedFtCtx: { ctx?: FtTurnContext }
  transcriptCapture: { listArgs?: { sessionId: string; maxPlayerSeq: number }; append?: AppendCapture }
  emitted: string[]
  flushed: { value?: FlushedTurnState }
  emitter: TurnEmitter
  deps: SessionControllerDeps
} {
  const capturedFtCtx: { ctx?: FtTurnContext } = {}
  const transcriptCapture: { listArgs?: { sessionId: string; maxPlayerSeq: number }; append?: AppendCapture } = {}
  const emitted: string[] = []
  const flushed: { value?: FlushedTurnState } = {}

  const emitter = recordingEmitter(emitted)
  const deps: SessionControllerDeps = {
    sessionState: fakeSessionState({
      ...(opts.turnState !== undefined ? { turnState: opts.turnState } : {}),
      flushed,
    }),
    ft: fakeFt(opts.assistant ?? ASSISTANT, capturedFtCtx),
    scribe: opts.scribe ?? fakeScribe(),
    emitter,
    transcript: fakeTranscript(opts.rows ?? HISTORY_ROWS, transcriptCapture),
    attributionNames: ATTRIBUTION_NAMES,
    // MYT-68: the FT prompt roster is now a per-turn dep (worker-resolved from
    // session_participants), not a getState read. Default to [].
    participants: opts.participants ?? [],
    ftContext: opts.ftContext ?? FT_CONTEXT,
    allocSeq: scriptedAllocSeq(opts.allocStart ?? 100),
    // §6 worker-resolved direction deps (conditionally spread —
    // exactOptionalPropertyTypes: a missing dep is ABSENT, never `undefined`).
    ...(opts.pendingDirection !== undefined ? { pendingDirection: opts.pendingDirection } : {}),
    ...(opts.standingDirective !== undefined ? { standingDirective: opts.standingDirective } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  }

  const controller = new SessionController(deps, CAMPAIGN, SESSION, TURN)
  return { controller, capturedFtCtx, transcriptCapture, emitted, flushed, emitter, deps }
}

describe('SessionController (PG-direct, MYT-68 §3.7)', () => {
  it('loads the WHOLE FT context via listFtContextRows(sessionId, maxConsumedSeq) and hands the codec output to the FT', async () => {
    const { controller, capturedFtCtx, transcriptCapture } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(7)

    // The query was scoped to this session + the consumed watermark.
    expect(transcriptCapture.listArgs).toEqual({ sessionId: SESSION, maxPlayerSeq: 7 })
    // ctx.ftHistory is EXACTLY rowsToConversation's output on the same fixture —
    // no extra trigger batch appended by the controller.
    const expected = rowsToConversation(HISTORY_ROWS, ATTRIBUTION_NAMES)
    expect(capturedFtCtx.ctx?.ftHistory).toEqual(expected)
  })

  it('fuses the worker-resolved pendingDirection onto the LAST user message in-memory only (never persisted)', async () => {
    const { controller, capturedFtCtx, transcriptCapture } = build({
      pendingDirection: 'D',
    })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)
    await controller.persistTurn()

    // The last user message's single text part ends with the fused direction.
    const history = capturedFtCtx.ctx?.ftHistory ?? []
    const lastUser = [...history].reverse().find((m) => m.role === 'user')
    expect(firstTextPart(lastUser)).toBe('I search the room\n\n[DM direction: D]')

    // Earlier (DM) message untouched.
    const firstAssistant = history.find((m) => m.role === 'assistant')
    expect(firstTextPart(firstAssistant)).toBe('You stand in the hall.')

    // The direction never reaches what persistTurn writes (DM rows only, no
    // mention of the direction).
    const writtenContents = (transcriptCapture.append?.rows ?? []).map((r) => r.content)
    expect(writtenContents.join('\n')).not.toContain('DM direction')
  })

  it('does NOT fuse anything when no pendingDirection is injected (raw codec output reaches the FT)', async () => {
    const { controller, capturedFtCtx } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    // ctx.ftHistory is EXACTLY rowsToConversation's output — no [DM direction:]
    // tail anywhere.
    const expected = rowsToConversation(HISTORY_ROWS, ATTRIBUTION_NAMES)
    expect(capturedFtCtx.ctx?.ftHistory).toEqual(expected)
    const fusedAnywhere = (capturedFtCtx.ctx?.ftHistory ?? []).some((m) =>
      m.parts.some((p) => p.kind === 'text' && p.text.includes('[DM direction:')),
    )
    expect(fusedAnywhere).toBe(false)
  })

  it('has no `st` tier dep: the FT (besides the Scribe) is the only tier invoked', async () => {
    const { controller, capturedFtCtx, deps } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    // Type-level + runtime: the post-hoc model removed the in-turn ST seam.
    expect('st' in deps).toBe(false)
    // The FT still ran (it captured the ctx + drove the emitter); that is the
    // only reasoning tier on the turn path now.
    expect(capturedFtCtx.ctx).toBeDefined()
  })

  it('fusion on a MULTI-PART last user message suffixes the first text part and preserves the rest verbatim', () => {
    // The §3.7 codec only ever produces single-text-part user messages, so this
    // shape is unreachable through processDmTurn — the exported pure function is
    // exercised directly to pin the multi-part preservation arm.
    const trailing = { kind: 'text', text: 'a second part' } as const
    const history: ConversationMessage[] = [
      { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'Earlier narration.' }] },
      {
        v: 1,
        role: 'user',
        parts: [{ kind: 'text', text: 'I open the chest' }, trailing],
        characterName: 'Mara',
      },
    ]

    expect(fuseDirectionIntoLastUserMessage(history, 'D')).toBe(true)

    const fused = history[1]
    expect(fused?.parts).toHaveLength(2)
    expect(fused?.parts[0]).toEqual({ kind: 'text', text: 'I open the chest\n\n[DM direction: D]' })
    // The trailing part is preserved verbatim (same value, untouched).
    expect(fused?.parts[1]).toEqual(trailing)
    // The earlier (assistant) message is untouched.
    expect(firstTextPart(history[0])).toBe('Earlier narration.')
  })

  it('fusion returns false on a history with no user message (caller owns the warn)', () => {
    const history: ConversationMessage[] = [
      { v: 1, role: 'assistant', parts: [{ kind: 'text', text: 'Only the DM has spoken.' }] },
    ]
    expect(fuseDirectionIntoLastUserMessage(history, 'D')).toBe(false)
    // Nothing was mutated.
    expect(firstTextPart(history[0])).toBe('Only the DM has spoken.')
  })

  it('passes the injected ftContext through and exposes NO runningSummary key', async () => {
    const { controller, capturedFtCtx } = build({ ftContext: 'INJECTED' })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    expect(capturedFtCtx.ctx?.ftContext).toBe('INJECTED')
    expect('runningSummary' in (capturedFtCtx.ctx ?? {})).toBe(false)
  })

  it('buildContext carries standingDirective onto the FT context when the dep is set', async () => {
    const { controller, capturedFtCtx } = build({ standingDirective: 'keep scenes short' })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    expect(capturedFtCtx.ctx?.standingDirective).toBe('keep scenes short')
  })

  it('buildContext OMITS the standingDirective key when the dep is absent (exactOptionalPropertyTypes — key ABSENT, not undefined)', async () => {
    const { controller, capturedFtCtx } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    // The key must be ABSENT, not present-with-undefined.
    expect('standingDirective' in (capturedFtCtx.ctx ?? {})).toBe(false)
  })

  it('emits NO turn_end: only the FT drives the injected emitter; there is no publisher dep', async () => {
    const { controller, emitted, deps } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    // The only emission is the FT fake's own 'chunk'; the controller never emits
    // anything itself (no turn_end, no other frame).
    expect(emitted).toEqual(['chunk'])
    // Type-level: there is no `publisher` on the deps surface at all.
    expect('publisher' in deps).toBe(false)
  })

  it('persistTurn appends the codec rows with sequentially-allocated seqs, in order', async () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'first' },
        { kind: 'tool_call', toolCallId: 'tc1', toolName: 'roll_dice', input: { sides: 20 } },
        { kind: 'tool_result', toolCallId: 'tc1', toolName: 'roll_dice', output: { total: 14 } },
        { kind: 'text', text: 'second' },
      ],
      usage: { input: 1, output: 2 },
    }
    const { controller, transcriptCapture } = build({ assistant, allocStart: 100 })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)
    await controller.persistTurn()

    const append = transcriptCapture.append
    expect(append?.sessionId).toBe(SESSION)
    expect(append?.turnId).toBe(TURN)
    // text → dm_text, tool_call+tool_result pair → ONE dice_roll row, text → dm_text.
    expect(append?.rows.map((r) => r.kind)).toEqual(['dm_text', 'dice_roll', 'dm_text'])
    // Seqs allocated sequentially from the scripted allocator: [100, 101, 102].
    expect(append?.seqs).toEqual([100, 101, 102])
  })

  it('persistTurn is a no-op when the assistant produced no rows (empty parts)', async () => {
    const empty: AssistantMessage = { role: 'assistant', parts: [], usage: { input: 0, output: 0 } }
    const { controller, transcriptCapture } = build({ assistant: empty })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)
    await controller.persistTurn()

    // No payload captured — the fake records every appendDmTurn call into
    // `capture.append`, so its absence proves the append was never invoked.
    expect(transcriptCapture.append).toBeUndefined()
  })

  it('persistTurn before processDmTurn is a programmer error (throws)', async () => {
    const { controller } = build()
    await controller.loadFromRedis()
    await expect(controller.persistTurn()).rejects.toThrow()
  })

  it('flushToRedis writes exactly {usage} (no summary — that key is the ST job\'s artifact now)', async () => {
    const { controller, flushed } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(1)
    await controller.flushToRedis()

    // The ST no longer runs on the turn path, so the only usage is the FT's
    // {5,7} from the ASSISTANT fixture.
    expect(flushed.value).toEqual<FlushedTurnState>({ usage: { input: 5, output: 7 } })
    // Exactly the one key — no summary, no stray ftHistory / participants leakage.
    expect(Object.keys(flushed.value ?? {})).toEqual(['usage'])
  })

  it('does not throw out of processDmTurn when the Scribe rejects; logger.warn is called', async () => {
    const warn = vi.fn()
    const { controller } = build({ scribe: rejectingScribe(), logger: { warn } })
    await controller.loadFromRedis()

    await expect(controller.processDmTurn(1)).resolves.toBeUndefined()
    // Let the fire-and-forget rejection settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
  })

  it('propagates TranscriptCorruptError from the codec out of processDmTurn (crash-loud)', async () => {
    // A roll row with non-JSON content makes rowsToConversation throw.
    const corrupt: readonly SessionMessage[] = [
      row({ seq: 1, turnId: 'prior', turnOrdinal: 0, messageType: 'dice_roll', content: 'not json' }),
    ]
    const { controller } = build({ rows: corrupt })
    await controller.loadFromRedis()
    await expect(controller.processDmTurn(1)).rejects.toThrow(/transcript corrupt/)
  })

  it('skips pendingDirection fusion (with a warn) when the batch holds no user message', async () => {
    const warn = vi.fn()
    // DM-only rows: no player_message, so rowsToConversation yields no user msg.
    const dmOnly: readonly SessionMessage[] = [
      row({ seq: 1, turnId: 'prior', turnOrdinal: 0, messageType: 'dm_text', content: 'You wait.' }),
    ]
    const { controller, capturedFtCtx } = build({
      rows: dmOnly,
      pendingDirection: 'be terse',
      logger: { warn },
    })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    // No user message to fuse onto → nothing carries the direction; warn fired.
    const hasDirection = (capturedFtCtx.ctx?.ftHistory ?? []).some((m) =>
      m.parts.some((p) => p.kind === 'text' && p.text.includes('be terse')),
    )
    expect(hasDirection).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('defaults participants to [] (and workingSet to []) when none are injected', async () => {
    const { controller, capturedFtCtx } = build()
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    expect(capturedFtCtx.ctx?.participants).toEqual([])
    expect(capturedFtCtx.ctx?.workingSet).toEqual([])
  })

  it('carries the injected participants dep through to the FT context (MYT-68: deps → ctx)', async () => {
    // The roster is a per-turn DEP now (worker-resolved from session_participants
    // in deterministic order), not a getState read. The fake SessionState throws
    // if getState is called, so this also pins that the controller never reads it.
    const { controller, capturedFtCtx } = build({ participants: ['Bryn', 'Arin'] })
    await controller.loadFromRedis()
    await controller.processDmTurn(1)

    expect(capturedFtCtx.ctx?.participants).toEqual(['Bryn', 'Arin'])
  })
})
