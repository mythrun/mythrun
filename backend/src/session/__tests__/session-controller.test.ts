import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSessionState, type SessionState } from '../../redis/session-state.js'
import { SessionController, type SessionControllerDeps } from '../session-controller.js'
import type {
  AssistantMessage,
  FastThinker,
  FtTurnContext,
  Scribe,
  ScribeResult,
  SlowThinker,
  StEvaluation,
  TokenUsage,
  TriggerMessage,
  TurnEmit,
} from '../tiers/types.js'
import type { TurnPublisher } from '../turn-publisher.js'

const KEY_PREFIX = 'test:use1:'
const CAMPAIGN = 'c-ctrl-1'
const TURN = 't-ctrl-1'

const TRIGGER: TriggerMessage = { userId: 'u1', characterName: 'Mara', text: 'I search the room' }

// ---------------------------------------------------------------------------
// Recording fakes. Each records the global call order into a shared array so a
// single assertion proves the conductor sequence (ST → FT → Scribe) and the
// turnEnd-before-scribe-resolves ordering.
// ---------------------------------------------------------------------------

interface Recorder {
  readonly order: string[]
}

function recordingSt(recorder: Recorder, evaluation: StEvaluation): SlowThinker {
  return {
    evaluate: vi.fn((): Promise<StEvaluation> => {
      recorder.order.push('st')
      return Promise.resolve(evaluation)
    }),
  }
}

function recordingFt(
  recorder: Recorder,
  message: AssistantMessage,
  capturedCtx: { value?: FtTurnContext },
): FastThinker {
  return {
    render: vi.fn(async (ctx: FtTurnContext, emit: TurnEmit): Promise<AssistantMessage> => {
      recorder.order.push('ft')
      capturedCtx.value = ctx
      // The FT seam streams text through the emit it is handed; exercise it so
      // the controller wiring of publisher.emitFor is covered end to end.
      await emit('chunk')
      return message
    }),
  }
}

function recordingScribe(recorder: Recorder, gate: { resolved: boolean }): Scribe {
  return {
    extract: vi.fn((): Promise<ScribeResult> => {
      recorder.order.push('scribe')
      gate.resolved = true
      return Promise.resolve({ workingSetDeltas: [] })
    }),
  }
}

function throwingScribe(): Scribe {
  return {
    extract: vi.fn((): Promise<ScribeResult> => Promise.reject(new Error('scribe boom'))),
  }
}

/** A Scribe whose `extract` throws SYNCHRONOUSLY (before returning a promise) —
 *  models a future non-async implementation. The controller's fire-and-forget
 *  wrapper must capture this into the same `.catch`, so it never escapes the
 *  turn. */
function synchronouslyThrowingScribe(): Scribe {
  return {
    extract: vi.fn((): Promise<ScribeResult> => {
      throw new Error('sync scribe boom')
    }),
  }
}

function fakePublisher(recorder: Recorder, emitted: string[]): TurnPublisher {
  const emit: TurnEmit = (text: string): Promise<void> => {
    emitted.push(text)
    return Promise.resolve()
  }
  return {
    dmThinking: vi.fn((): Promise<void> => Promise.resolve()),
    textDelta: vi.fn((): Promise<void> => Promise.resolve()),
    turnEnd: vi.fn((): Promise<void> => {
      recorder.order.push('turnEnd')
      return Promise.resolve()
    }),
    turnError: vi.fn((): Promise<void> => Promise.resolve()),
    emitFor: vi.fn((): TurnEmit => emit),
  }
}

const ASSISTANT: AssistantMessage = {
  role: 'assistant',
  content: 'The room is silent.',
  usage: { input: 5, output: 7 },
}

function makeDeps(overrides: Partial<SessionControllerDeps>, base: {
  sessionState: SessionState
  st: SlowThinker
  ft: FastThinker
  scribe: Scribe
  publisher: TurnPublisher
}): SessionControllerDeps {
  return { ...base, ...overrides }
}

describe('SessionController', () => {
  let redis: Redis
  let sessionState: SessionState

  beforeEach(async () => {
    redis = new IoRedisMock()
    await redis.flushall()
    sessionState = makeSessionState(redis, KEY_PREFIX)
  })
  afterEach(async () => {
    await redis.quit()
  })

  it('runs the conductor in order ST → FT → Scribe, turnEnd before scribe resolves', async () => {
    const recorder: Recorder = { order: [] }
    const gate = { resolved: false }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, { intervene: false })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, gate)
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    await controller.processDmTurn([TRIGGER])

    // turnEnd must be recorded before scribe — scribe is fire-and-forget and
    // must not gate the turn's completion.
    const turnEndIdx = recorder.order.indexOf('turnEnd')
    expect(recorder.order.slice(0, turnEndIdx + 1)).toEqual(['st', 'ft', 'turnEnd'])
    // Let the fire-and-forget scribe settle, then confirm it ran last.
    await Promise.resolve()
    await Promise.resolve()
    expect(recorder.order).toEqual(['st', 'ft', 'turnEnd', 'scribe'])
    expect(gate.resolved).toBe(true)
  })

  it('appends trigger as a user message then the assistant message; usage sums tiers', async () => {
    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, { intervene: false, usage: { input: 3, output: 2 } })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, { resolved: false })
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    await controller.processDmTurn([TRIGGER])
    await controller.flushToRedis()

    const reloaded = await sessionState.loadTurnState(CAMPAIGN)
    expect(reloaded.ftHistory).toEqual([
      { role: 'user', content: 'I search the room', characterName: 'Mara' },
      { role: 'assistant', content: 'The room is silent.' },
    ])
    // ST usage {3,2} + FT usage {5,7} = {8,9}.
    expect(reloaded.usage).toEqual<TokenUsage>({ input: 8, output: 9 })
  })

  it('applies summaryUpdate but does NOT inject direction when intervene is false', async () => {
    // The running-summary update is DECOUPLED from `intervene` (runtime spec §6
    // step 2): summaryUpdate is applied whenever present. Only the stage
    // `direction` is gated on intervene. This stub carries both; we assert the
    // summary IS updated while the direction is NOT fused into the user message.
    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, {
      intervene: false,
      direction: 'ignored',
      summaryUpdate: 'applied even without intervene',
    })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, { resolved: false })
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    await controller.processDmTurn([TRIGGER])
    await controller.flushToRedis()

    const reloaded = await sessionState.loadTurnState(CAMPAIGN)
    // No direction text fused into the user message (direction IS gated).
    expect(reloaded.ftHistory[0]?.content).toBe('I search the room')
    expect(reloaded.ftHistory[0]?.content).not.toContain('ignored')
    // Summary IS updated despite intervene:false (summary is NOT gated).
    expect(reloaded.summary).toBe('applied even without intervene')
  })

  it('APPENDS a new summaryUpdate onto an existing summary (newline-joined), not overwriting it', async () => {
    // applyEvaluation's append branch: when the controller loads a session that
    // ALREADY has a running summary (a later turn), a fresh summaryUpdate is
    // newline-joined onto it rather than replacing it. Seed a prior summary into
    // Redis so loadFromRedis hydrates a non-empty `this.summary` before the ST's
    // update arrives.
    await sessionState.flushTurnState(CAMPAIGN, {
      ftHistory: [],
      summary: 'turn one summary',
      usage: { input: 0, output: 0 },
    })

    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, {
      intervene: false,
      summaryUpdate: 'turn two summary',
    })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, { resolved: false })
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    await controller.processDmTurn([TRIGGER])
    await controller.flushToRedis()

    const reloaded = await sessionState.loadTurnState(CAMPAIGN)
    // Both summaries present, newline-joined in order (old\nnew) — the prior
    // summary was NOT overwritten.
    expect(reloaded.summary).toBe('turn one summary\nturn two summary')
  })

  it('injects ST direction into the last user message AND appends summary when intervene is true', async () => {
    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, {
      intervene: true,
      direction: 'be terse',
      summaryUpdate: 'x',
    })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, { resolved: false })
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    await controller.processDmTurn([TRIGGER])
    await controller.flushToRedis()

    const reloaded = await sessionState.loadTurnState(CAMPAIGN)
    // Direction must be present in the (sole) user message's content.
    expect(reloaded.ftHistory[0]?.role).toBe('user')
    expect(reloaded.ftHistory[0]?.content).toContain('I search the room')
    expect(reloaded.ftHistory[0]?.content).toContain('be terse')
    // Summary appended.
    expect(reloaded.summary).toContain('x')
    // The FT must have seen the direction-injected history, not the bare one.
    // (The captured ftHistory is the live array reference, which the controller
    // mutates in place — so we locate the user message, not `.at(-1)`, since the
    // assistant message gets pushed onto that same array after render returns.)
    const userMsg = capturedCtx.value?.ftHistory.find((m) => m.role === 'user')
    expect(userMsg?.content).toContain('be terse')
  })

  it('does not throw out of processDmTurn when the Scribe rejects', async () => {
    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const warn = vi.fn()
    const st = recordingSt(recorder, { intervene: false })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = throwingScribe()
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      makeDeps({ logger: { warn } }, { sessionState, st, ft, scribe, publisher }),
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()

    await expect(controller.processDmTurn([TRIGGER])).resolves.toBeUndefined()
    // Let the rejected fire-and-forget settle and confirm the swallow logged.
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
  })

  it('does not throw out of processDmTurn when the Scribe throws SYNCHRONOUSLY', async () => {
    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const warn = vi.fn()
    const st = recordingSt(recorder, { intervene: false })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = synchronouslyThrowingScribe()
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      makeDeps({ logger: { warn } }, { sessionState, st, ft, scribe, publisher }),
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()

    // A SYNCHRONOUS throw inside extract() must be captured by the wrapper, not
    // propagate out of processDmTurn.
    await expect(controller.processDmTurn([TRIGGER])).resolves.toBeUndefined()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
  })

  it('round-trips mutated state through load → process → flush → reload', async () => {
    // Seed pre-existing turn state + participants so load actually carries them.
    await sessionState.flushTurnState(CAMPAIGN, {
      ftHistory: [{ role: 'assistant', content: 'Earlier.' }],
      summary: 'prior summary',
      usage: { input: 100, output: 200 },
    })
    await sessionState.setState(CAMPAIGN, {
      participants: ['Mara', 'Bram'],
      mode: 'exploration',
      status: 'active',
    })

    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, { intervene: false, usage: { input: 1, output: 1 } })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, { resolved: false })
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    // The loaded participants must reach the tiers via the context.
    await controller.processDmTurn([TRIGGER])
    await controller.flushToRedis()

    expect(capturedCtx.value?.participants).toEqual(['Mara', 'Bram'])

    const reloaded = await sessionState.loadTurnState(CAMPAIGN)
    expect(reloaded.ftHistory).toEqual([
      { role: 'assistant', content: 'Earlier.' },
      { role: 'user', content: 'I search the room', characterName: 'Mara' },
      { role: 'assistant', content: 'The room is silent.' },
    ])
    expect(reloaded.summary).toBe('prior summary')
    // 100/200 prior + ST 1/1 + FT 5/7 = 106/208.
    expect(reloaded.usage).toEqual<TokenUsage>({ input: 106, output: 208 })
  })

  it('defaults participants to [] when no :state blob is set', async () => {
    const recorder: Recorder = { order: [] }
    const capturedCtx: { value?: FtTurnContext } = {}
    const st = recordingSt(recorder, { intervene: false })
    const ft = recordingFt(recorder, ASSISTANT, capturedCtx)
    const scribe = recordingScribe(recorder, { resolved: false })
    const publisher = fakePublisher(recorder, [])

    const controller = new SessionController(
      { sessionState, st, ft, scribe, publisher },
      CAMPAIGN,
      TURN,
    )
    await controller.loadFromRedis()
    await controller.processDmTurn([TRIGGER])

    expect(capturedCtx.value?.participants).toEqual([])
    expect(capturedCtx.value?.workingSet).toEqual([])
  })
})
