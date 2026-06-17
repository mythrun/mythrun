// MYT-67 T12 — the broker-side terminal `turn_error` subscriber
// (`session-turn-queue-events.ts`, spec §4.8, closes `myth-tvnb`).
//
// `buildSessionTurnQueueEvents` is boot-wiring around a `QueueEvents('session-turn')`
// subscriber: the broker `failed` event fires on EVERY worker container (including
// the `maxStalledCount`-exhaustion terminal that the in-process `worker.on('failed')`
// JS listener never sees), so this path publishes the terminal `turn_error`, gated
// on the same cross-container SET-NX latch the JS-listener path uses — so exactly
// one `turn_error` ships per terminal turn cluster-wide.
//
// To exercise the builder WITHOUT a broker, mock `bullmq`:
//   - `QueueEvents` captures the `.on('failed', handler)` registration + `close()`.
//   - `Queue` is an inert handle (only ever passed to `Job.fromId`).
//   - `Job.fromId` is a stub the test points at a fake failed job (or null).
// The builder constructs its OWN publisher (`createTurnPublisher`) + triggerState
// (`makeTriggerState`) over the injected `redisRealtime`, so the test asserts the
// real published frame by PSUBSCRIBing the per-campaign channel on ioredis-mock's
// process-wide broker (a fresh per-test KEY_PREFIX scopes the subscriber so cross-
// test publishes don't leak). The captured `'failed'` handler is fired directly;
// its async work is awaited so the assertions are race-free. Firing twice for one
// turnId exercises the REAL latch over ioredis-mock → exactly one publish.

import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionChannel, sessionChannelPattern } from '../../contract/session-channel.js'
import type { ServerFrame } from '../../contract/session-events.js'
import type { TurnJobPayload } from '../turn-queue.js'
import { buildSessionTurnQueueEvents } from '../session-turn-queue-events.js'

// The broker 'failed' event arg shape (bullmq QueueEventsListener['failed']).
type FailedHandler = (args: { jobId: string; failedReason: string }, id?: string) => unknown

// A minimal failed-job fake covering exactly the fields `publishTerminalTurnError`
// reads: `attemptsMade`, `opts.attempts`, `data`, plus `failedReason` for logging.
interface FakeFailedJob {
  attemptsMade: number
  opts: { attempts?: number }
  data: TurnJobPayload
  failedReason: string
}

// Module-level captures the mock writes through, reset per test.
const captured: {
  failedHandler: FailedHandler | null
  queueEventsClosed: number
  queueClosed: number
  fromIdResult: FakeFailedJob | null
  fromIdCalls: string[]
} = {
  failedHandler: null,
  queueEventsClosed: 0,
  queueClosed: 0,
  fromIdResult: null,
  fromIdCalls: [],
}

vi.mock('bullmq', () => ({
  // QueueEvents BRPOPs a stream — captures its 'failed' handler + close().
  QueueEvents: vi.fn().mockImplementation(() => ({
    on: (event: string, handler: FailedHandler) => {
      if (event === 'failed') captured.failedHandler = handler
    },
    close: () => {
      captured.queueEventsClosed += 1
      return Promise.resolve()
    },
  })),
  // The job-fetch handle. Inert; only ever passed to `Job.fromId`.
  Queue: vi.fn().mockImplementation(() => ({
    close: () => {
      captured.queueClosed += 1
      return Promise.resolve()
    },
  })),
  // `Job.fromId(queue, jobId)` → the test's fake (or null when the job was reaped).
  Job: {
    fromId: vi.fn().mockImplementation((_queue: unknown, jobId: string) => {
      captured.fromIdCalls.push(jobId)
      return Promise.resolve(captured.fromIdResult)
    }),
  },
}))

const CAMPAIGN = 'c-qe-1'
const TURN = 't-qe-1'

let keyPrefixCounter = 0

function makeJob(turnId = TURN): FakeFailedJob {
  return {
    attemptsMade: 3,
    opts: { attempts: 3 },
    data: {
      campaignId: CAMPAIGN,
      sessionId: 's-qe-1',
      turnId,
      triggerMessages: [],
      maxConsumedSeq: 0,
      trigger: { kind: 'auto' },
    },
    failedReason: 'stalled',
  }
}

function recordingLogger(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() }
}

// The injected finalize backstop (MYT-74b §1.3). A vi.fn so tests assert the
// call (or its absence) + the args shape `{ campaignId; sessionId; worldId }`.
function finalizeSpy(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(undefined)
}

// A farewell-kind failed job. Pass `worldId: null` for the no-worldId variant
// (the backstop's warn-and-skip arm); omit for the default-worldId happy path.
function makeFarewellJob(worldId: string | null = 'w1', turnId = TURN): FakeFailedJob {
  const job = makeJob(turnId)
  job.data = { ...job.data, trigger: { kind: 'farewell' }, ...(worldId == null ? {} : { worldId }) }
  return job
}

// A fresh ioredis-mock whose `.duplicate()` + `.quit()` are observable: duplicate()
// returns the SAME instance (so `close()`'s `connection.quit()` lands on this
// recorder), and quit() bumps `quitCalls`.
function makeRedis(): Redis & { quitCalls: { n: number } } {
  const r = new IoRedisMock() as unknown as Redis & { quitCalls: { n: number } }
  const quitCalls = { n: 0 }
  r.quitCalls = quitCalls
  const origQuit = r.quit.bind(r)
  r.quit = async () => {
    quitCalls.n += 1
    return origQuit()
  }
  r.duplicate = () => r
  return r
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

describe('buildSessionTurnQueueEvents', () => {
  let subscriber: Redis
  let received: ServerFrame[]
  let KEY_PREFIX: string

  beforeEach(async () => {
    captured.failedHandler = null
    captured.queueEventsClosed = 0
    captured.queueClosed = 0
    captured.fromIdResult = null
    captured.fromIdCalls = []

    keyPrefixCounter += 1
    KEY_PREFIX = `qe${String(keyPrefixCounter)}:`
    subscriber = new IoRedisMock()
    received = []
    subscriber.on('pmessage', (_pattern: string, _channel: string, payload: string) => {
      received.push(JSON.parse(payload) as ServerFrame)
    })
    await subscriber.psubscribe(sessionChannelPattern(KEY_PREFIX))
  })

  afterEach(async () => {
    await subscriber.quit()
    vi.clearAllMocks()
  })

  it('registers a broker failed handler and exposes queueEvents + close', () => {
    const sub = buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, recordingLogger(), finalizeSpy())

    expect(captured.failedHandler).toBeTypeOf('function')
    expect(sub.queueEvents).toBeDefined()
    expect(typeof sub.close).toBe('function')
  })

  it('publishes a terminal turn_error for a broker failed job', async () => {
    const logger = recordingLogger()
    captured.fromIdResult = makeJob()
    buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, logger, finalizeSpy())

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'j1', failedReason: 'stalled' })
    await tick()

    expect(captured.fromIdCalls).toEqual(['j1'])
    expect(received).toEqual([{ type: 'turn_error', turnId: TURN, message: 'The turn failed. Please try again.' }])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('targets the per-campaign channel', async () => {
    captured.fromIdResult = makeJob()
    const realtime = makeRedis()
    buildSessionTurnQueueEvents(makeRedis(), realtime, KEY_PREFIX, recordingLogger(), finalizeSpy())

    const channels: string[] = []
    subscriber.on('pmessage', (_p: string, channel: string) => {
      channels.push(channel)
    })
    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'j1', failedReason: 'stalled' })
    await tick()

    expect(channels).toContain(sessionChannel(KEY_PREFIX, CAMPAIGN))
  })

  it('gates on the shared SET-NX latch so exactly one turn_error ships per turn', async () => {
    // A single realtime store backs the latch across BOTH fires, so the REAL
    // `claimTurnErrorPublish` dedups — firing the broker handler twice for one
    // turnId publishes exactly once.
    captured.fromIdResult = makeJob()
    const realtime = makeRedis()
    buildSessionTurnQueueEvents(makeRedis(), realtime, KEY_PREFIX, recordingLogger(), finalizeSpy())

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'j1', failedReason: 'stalled' })
    await fire?.({ jobId: 'j1', failedReason: 'stalled' })
    await tick()

    expect(received).toEqual([{ type: 'turn_error', turnId: TURN, message: 'The turn failed. Please try again.' }])
  })

  it('warns and skips publish when the failed job was already reaped (fromId null)', async () => {
    const logger = recordingLogger()
    captured.fromIdResult = null
    buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, logger, finalizeSpy())

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'gone', failedReason: 'stalled' })
    await tick()

    expect(received).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('logs an error (and never rejects) when the Job.fromId fetch throws', async () => {
    // The floating-promise guard wraps `handleFailed` in `.catch`. handleFailed
    // awaits `Job.fromId`, so a fetch rejection is the realistic way to reach the
    // catch arm — assert it routes to logger.error with the jobId and does not
    // escape the callback.
    const logger = recordingLogger()
    ;(Job.fromId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis read failed'))
    buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, logger, finalizeSpy())

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'boom', failedReason: 'stalled' })
    await tick()

    expect(received).toEqual([])
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'boom' }),
      'failed to handle session-turn broker failed event',
    )
  })

  it('close() closes the queueEvents subscriber, its connection, and the queue handle', async () => {
    // duplicate() returns redisBatch itself, so the dedicated connection's quit
    // lands on redisBatch's quit recorder.
    const redisBatch = makeRedis()
    const sub = buildSessionTurnQueueEvents(redisBatch, makeRedis(), KEY_PREFIX, recordingLogger(), finalizeSpy())

    await sub.close()

    expect(captured.queueEventsClosed).toBe(1)
    expect(redisBatch.quitCalls.n).toBe(1)
    expect(captured.queueClosed).toBe(1)
  })

  // ── MYT-74b §1.3 — the unconditional-finalize backstop ────────────────────

  it('runs the finalize backstop for a terminally-failed farewell turn (after the turn_error)', async () => {
    // A farewell whose holder crashed terminally fires NO 'failed' JS event, so
    // this broker subscriber is the only surface that finalizes the session.
    captured.fromIdResult = makeFarewellJob('w1')
    const finalize = finalizeSpy()
    buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, recordingLogger(), finalize)

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'jf', failedReason: 'stalled' })
    await tick()

    // The terminal turn_error still ships for the farewell turn.
    expect(received).toEqual([{ type: 'turn_error', turnId: TURN, message: 'The turn failed. Please try again.' }])
    // …and the finalize backstop fires with the payload's worldId.
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith({ campaignId: CAMPAIGN, sessionId: 's-qe-1', worldId: 'w1' })
  })

  it('does NOT run the finalize backstop for a non-farewell terminal turn', async () => {
    // The attempts-exhaustion terminal for a normal turn: the turn-worker finally
    // already finalized (if relevant), so the backstop must stay out of it.
    captured.fromIdResult = makeJob() // trigger.kind: 'auto'
    const finalize = finalizeSpy()
    buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, recordingLogger(), finalize)

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'ja', failedReason: 'stalled' })
    await tick()

    // turn_error still ships for the non-farewell terminal…
    expect(received).toEqual([{ type: 'turn_error', turnId: TURN, message: 'The turn failed. Please try again.' }])
    // …but the finalize backstop is farewell-only.
    expect(finalize).not.toHaveBeenCalled()
  })

  it('skips the finalize backstop and warns when a failed farewell carries no worldId', async () => {
    // worldId rides the farewell payload (T3). If it's somehow absent we can't run
    // the reconcile-needing finalize — log + skip rather than finalize with a bad arg.
    const logger = recordingLogger()
    captured.fromIdResult = makeFarewellJob(null)
    const finalize = finalizeSpy()
    buildSessionTurnQueueEvents(makeRedis(), makeRedis(), KEY_PREFIX, logger, finalize)

    const fire = captured.failedHandler
    expect(fire).toBeTypeOf('function')
    await fire?.({ jobId: 'jfnw', failedReason: 'stalled' })
    await tick()

    // turn_error still ships; the finalize is the only thing skipped.
    expect(received).toEqual([{ type: 'turn_error', turnId: TURN, message: 'The turn failed. Please try again.' }])
    expect(finalize).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'jfnw' }),
      'farewell turn failed without worldId; cannot finalize via backstop',
    )
  })
})
