// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { type SessionState, makeSessionState } from '../../redis/session-state.js'
import type { SessionMessage } from '../../repo/types.js'
import { SessionController } from '../session-controller.js'
import { StubFastThinker } from '../tiers/stubs.js'
import type { FtTurnContext } from '../tiers/types.js'
import type { SessionLockHandle } from '../session-lock.js'
import { type TriggerState, makeTriggerState } from '../trigger-state.js'
import type { TurnPublisher } from '../turn-publisher.js'
import { type TurnProcessorDeps, processTurnJob } from '../turn-worker.js'
import { CAMPAIGN, KEY_PREFIX, SESSION, TURN, fakeHandle, fakeLock, fakeRepo, installSlowProcessDmTurn, makeTiers, newCalls, payload, recordingPublisher, silentLogger } from './_helpers/turn-worker-harness.js'
import { inertCombatLedger, inertDmTriggerQueue, inertEndSession, inertFinalize, inertLedgerTx, inertScribeQueue, inertStEvalQueue, inertTurnQueue } from './_helpers/turn-worker-deps.js'

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock exports a real throwable subclass (not a bare
  // vi.fn) so `instanceof` checks hold. This suite never constructs a Worker/Queue.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

describe('processTurnJob — lock lifecycle', () => {
  let redis: Redis
  let sessionState: SessionState
  let triggerState: TriggerState

  beforeEach(async () => {
    redis = new IoRedisMock()
    await redis.flushall()
    sessionState = makeSessionState(redis, KEY_PREFIX)
    triggerState = makeTriggerState(redis, KEY_PREFIX)
  })
  afterEach(async () => {
    await redis.quit()
    vi.clearAllMocks()
  })

  it('happy path: acquires the lock, runs the turn, flushes state, releases', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // dm_thinking precedes the streamed delta(s) which precede turn_end.
    expect(calls.order[0]).toBe('dm_thinking')
    expect(calls.order).toContain('text_delta')
    expect(calls.order[calls.order.length - 1]).toBe('turn_end')
    expect(calls.order).not.toContain('turn_error')

    // The mutated turn state was flushed (turn_end above is the cross-process
    // completion signal). ft_history retired — PG-direct (MYT-68 §3.7); only
    // summary/usage round-trip through Redis, and the stub tiers leave them at
    // their zero values.
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })

    expect(release).toHaveBeenCalledTimes(1)
    // The heartbeat timer is cleared in `finally` — no leaked interval.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('contention: tryAcquire returns null → {ran:false}, no publish, no flush', async () => {
    const calls = newCalls()
    const deps: TurnProcessorDeps = {
      lock: fakeLock(null),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: false })
    expect(calls.order).toEqual([])

    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
  })

  it('lock-lost at the FIRST checkpoint (right after loadFromRedis) aborts before processDmTurn', async () => {
    // The L118 checkpoint: lock loss detected immediately after loadFromRedis.
    // Make loadFromRedis slow so the tiny-interval heartbeat (extend→false)
    // flips lockLost DURING the load — the turn then throws LockLostError at
    // L118, before processDmTurn ever runs.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    const loadSpy = vi
      .spyOn(SessionController.prototype, 'loadFromRedis')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve()
            }, 40)
          }),
      )
    const processSpy = vi.spyOn(SessionController.prototype, 'processDmTurn')

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(loadSpy).toHaveBeenCalled()
    // Aborted at L118 — processDmTurn was never reached.
    expect(processSpy).not.toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_error')
    expect(release).toHaveBeenCalledTimes(1)

    // Restore the prototype spies HERE (not via a describe-wide restoreAllMocks,
    // which would also tear down the module-level `bullmq` Worker mock the
    // buildSessionTurnWorker suite depends on).
    loadSpy.mockRestore()
    processSpy.mockRestore()
  })

  it('heartbeat extend() REJECTS → treated as lock-lost: warns, aborts without flushing, releases', async () => {
    // The heartbeat's `.catch` arm (a rejected `extend()`, distinct from a
    // resolved `false`): we can no longer prove we hold the lock, so the flag
    // flips lost and the turn aborts at its next checkpoint — same observable
    // outcome as extend()→false, but reached through the catch path.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle: SessionLockHandle = {
      token: 'tok',
      extend: vi.fn((): Promise<boolean> => Promise.reject(new Error('redis down'))),
      release,
    }

    // A slow render step so the tiny-interval heartbeat fires (flipping
    // lockLost via the rejecting extend) BEFORE the turn body reaches its next
    // lockLost checkpoint.
    const processSpy = installSlowProcessDmTurn()

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    expect(calls.order).not.toContain('turn_error')
    // The catch arm logs the heartbeat failure (L106) AND the lock-lost abort.
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, turnId: TURN }),
      'turn lock heartbeat failed',
    )
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
    expect(release).toHaveBeenCalledTimes(1)

    processSpy.mockRestore()
  })

  it('a real (non-lock-lost) error RETHROWS so BullMQ owns the retry; lock still released', async () => {
    // The catch arm's `throw err` (L135) + its `instanceof LockLostError ||
    // isLockLost()` false branch: a tier throws a plain Error while the lock is
    // healthy (extend→true). processTurnJob must propagate it (not swallow it),
    // and finally still clears the heartbeat + releases the lock.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })

    const boom = new Error('fast thinker exploded')
    const ft = new StubFastThinker()
    vi.spyOn(ft, 'render').mockRejectedValue(boom)

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ ft, combatEvents: [] }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    await expect(processTurnJob(deps, payload())).rejects.toThrow('fast thinker exploded')

    // Not a lock-lost abort: never published turn_error, never flushed.
    expect(calls.order).not.toContain('turn_error')
    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })
    // finally still released the lock on the error path.
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('myth-dwyuw: augments ft_context with canon entity cards using the RESOLVED worldId, and renders with the augmented string', async () => {
    // Proves the wire-up: the fresh-run arm calls augmentFtContextWithEntityCards
    // with the resolved worldId ('w-fake' from campaigns.getWorldId) and threads
    // its result into the SessionController's ftContext (→ the FT's ctx). The
    // augment BEHAVIOUR itself is covered in turn-context.test.ts; this is the
    // integration seam only.
    const calls = newCalls()
    const handle = fakeHandle({ extendReturns: true, release: vi.fn((): Promise<void> => Promise.resolve()) })

    // Capture the ft_context the FT is rendered with.
    let renderedFtContext: string | undefined
    const ft = new StubFastThinker()
    vi.spyOn(ft, 'render').mockImplementation((ctx: FtTurnContext) => {
      renderedFtContext = ctx.ftContext
      return Promise.resolve({
        role: 'assistant' as const,
        parts: [{ kind: 'text' as const, text: 'ok' }],
        usage: { input: 1, output: 1 },
      })
    })

    // A transcript row naming a canon NPC the prep doc did NOT ground → augment
    // appends a card.
    const namingRow: SessionMessage = {
      id: '01900000-0000-7000-8000-00000000da01',
      sessionId: SESSION,
      seq: 1,
      userId: null,
      messageType: 'dm_text',
      content: 'Marsen Roud waited at the quay for the tide.',
      createdAt: new Date(0),
      turnId: '01900000-0000-7000-8000-00000000da02',
      turnOrdinal: 0,
      triggerKind: null,
    }
    const augmentWorldIds: string[] = []

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo({
        ftContext: 'Base prep doc.',
        ftContextRows: [namingRow],
        canonEntities: [{ id: 'e-roud', name: 'Marsen Roud', entityType: 'npc' }],
        canonFacts: [{ entityId: 'e-roud', content: 'the senior customs broker' }],
        augmentWorldIds,
      }),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers: () => ({ ft, combatEvents: [] }),
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    await processTurnJob(deps, payload())

    // (a) augment ran with the RESOLVED worldId.
    expect(augmentWorldIds).toContain('w-fake')
    // (b) the controller rendered with the AUGMENTED ft_context: base preserved
    // as a prefix, and the canon card appended.
    expect(renderedFtContext).toBeDefined()
    expect(renderedFtContext).toContain('Base prep doc.')
    expect(renderedFtContext).not.toBe('Base prep doc.')
    expect(renderedFtContext).toContain('Marsen Roud')
  })

  it('lock-lost: heartbeat extend()→false aborts the turn without flushing; release still called', async () => {
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: false, release })

    // A slow render step so the tiny-interval heartbeat fires (flipping lockLost)
    // BEFORE the turn body reaches its next lockLost checkpoint.
    const processSpy = installSlowProcessDmTurn()

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher: recordingPublisher(calls),
      makeTiers,
      heartbeatMs: 5,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    // It ran but aborted on lock loss: never flushed, never published turn_error.
    expect(result).toEqual({ ran: true })
    expect(processSpy).toHaveBeenCalled()
    expect(calls.order).not.toContain('turn_error')

    const turnState = await sessionState.loadTurnState(CAMPAIGN)
    // ft_history retired — PG-direct (MYT-68 §3.7); the no-flush invariant now
    // reads on summary/usage staying at the pre-turn (zero) snapshot.
    expect(turnState.summary).toBe('')
    expect(turnState.usage).toEqual({ input: 0, output: 0 })

    // The lock-lost branch warns and still releases in finally.
    expect(silentLogger.warn).toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)

    processSpy.mockRestore()
  })

  it('sets dm_responding during the turn body and clears it after release (§4.7)', async () => {
    // The drain guard: the worker flags `dm_responding` while a turn runs so the
    // dm-trigger worker won't enqueue a colliding turn, then clears it on
    // release. Observe "set during the body" by reading the flag inside the
    // publisher's dmThinking (which runs AFTER setResponding, inside the body),
    // and "cleared after" by reading it once processTurnJob resolves.
    const calls = newCalls()
    const release = vi.fn((): Promise<void> => Promise.resolve())
    const handle = fakeHandle({ extendReturns: true, release })
    let respondingDuringBody: boolean | null = null
    // Override dmThinking (which runs in the body, AFTER setResponding) to snapshot
    // the flag — typed via spread so no `any` cast is needed.
    const publisher: TurnPublisher = {
      ...recordingPublisher(calls),
      dmThinking: vi.fn(async (): Promise<void> => {
        respondingDuringBody = await triggerState.isResponding(CAMPAIGN)
        calls.order.push('dm_thinking')
      }),
    }

    const deps: TurnProcessorDeps = {
      lock: fakeLock(handle),
      sessionState,
      repo: fakeRepo(),
      triggerState,
      sessionTurnQueue: inertTurnQueue(),
      dmTriggerQueue: inertDmTriggerQueue(),
      stEvalQueue: inertStEvalQueue(),
      scribeQueue: inertScribeQueue(),
      endSession: inertEndSession(),
      finalizeEndedSession: inertFinalize(),
      combatLedger: inertCombatLedger(),
      ledgerTx: inertLedgerTx(),
      publisher,
      makeTiers,
      heartbeatMs: 10_000,
      logger: silentLogger,
    }

    const result = await processTurnJob(deps, payload())

    expect(result).toEqual({ ran: true })
    // dm_responding was live while the turn body ran…
    expect(respondingDuringBody).toBe(true)
    // …and is cleared once the turn (and its finally) completes.
    expect(await triggerState.isResponding(CAMPAIGN)).toBe(false)
  })

})
