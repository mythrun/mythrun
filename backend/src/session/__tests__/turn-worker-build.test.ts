// Split from the original monolithic turn-worker.test.ts along its thematic
// describe/it seams. Shared pure-mock builders live in ./_helpers/turn-worker-
// harness.ts + ./_helpers/turn-worker-deps.ts. No DB / scoped fixtures here (this
// suite is pure in-memory mocks), so the CONVENTIONS.md isolation pattern is N/A.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { sessionChannelPattern } from '../../contract/session-channel.js'
import { makeTriggerState } from '../trigger-state.js'
import type { TurnJobPayload } from '../turn-queue.js'
import { type TerminalFailureJob, buildSessionTurnWorker } from '../turn-worker.js'
import type { VoyageEmbedder } from '../../llm/embed.js'
import { CAMPAIGN, SESSION, payload, terminalFailureJob } from './_helpers/turn-worker-harness.js'

// `buildSessionTurnWorker` is boot-wiring around `new BullmqWorker(...)`. To
// exercise its body WITHOUT a broker, mock `bullmq` so the `Worker` constructor
// captures the processor fn + every `.on(event, handler)` registration. The
// captured processor is then invoked with a real payload (running `processTurnJob`
// over ioredis-mock, which covers the `makeTiers` closure), and the captured
// `'failed'` handler is invoked directly (covering the arrow that delegates to
// `publishTerminalTurnError`). The `processTurnJob` unit tests above don't touch
// `bullmq` at runtime (the module only imports the type), so this mock is inert
// for them.
//
// The captured processor + handlers are typed structurally (not as bullmq's
// `Job`): the builder passes a `(job: Job | undefined, err) => void`, but every
// field the 'failed' arrow reads is already on `TerminalFailureJob`, so storing
// the handler against that narrower view lets us invoke it with a plain fake —
// no `as Job` cast. The mock's `on` accepts `unknown` args so the wider builder
// handler still type-checks at the registration call site.
type ProcessorFn = (job: { data: TurnJobPayload }) => Promise<{ ran: boolean }>
type FailedHandler = (job: TerminalFailureJob | undefined, err: Error) => void
interface CapturedWorker {
  readonly processor: ProcessorFn
  readonly handlers: Map<string, FailedHandler>
}
const captured: { worker: CapturedWorker | null } = { worker: null }

// Every `add(name, data)` the builder's explicit-drain `Queue` receives, so the
// buildSessionTurnWorker drain path is assertable without a broker.
const capturedQueueAdds: { name: string; data: TurnJobPayload }[] = []

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: ProcessorFn) => {
    const handlers = new Map<string, FailedHandler>()
    const instance = {
      processor,
      handlers,
      on: (event: string, handler: FailedHandler) => {
        handlers.set(event, handler)
      },
    }
    captured.worker = { processor, handlers }
    return instance
  }),
  // The builder constructs ONE `Queue` for the explicit drain. Mock it as a thin
  // recorder so `new Queue(...)` doesn't touch a real connection.
  Queue: vi.fn().mockImplementation(() => ({
    add: (name: string, data: TurnJobPayload) => {
      capturedQueueAdds.push({ name, data })
      return Promise.resolve(undefined)
    },
  })),
  // The §5 latch-terminal arm throws `UnrecoverableError`; the processor + tests
  // both reference it, so the mock must export a real throwable subclass (not a
  // bare vi.fn) so `instanceof` checks hold.
  UnrecoverableError: class UnrecoverableError extends Error {},
}))

/** A fake `pg.Pool` for the builder tests: the builder calls `createRepo(pool)`
 *  (no queries at construction). `query` is routed so the §5 converge probe
 *  (`turnRowsExist` → `SELECT 1 … LIMIT 1`) reports a durable turn — the
 *  processor then converges (turn_end + watermark) WITHOUT constructing/​running
 *  the now-REAL SonnetFastThinker, so no real LLM call fires in a unit test. Any
 *  other query resolves empty. Cast to `Pool` (the builder only ever calls
 *  `.query`). */
/** A fake Voyage embedder for the builder tests. The builder threads it into the
 *  (c8-ignored, real-LLM) makeTiers closure ONLY; the converge-path builder tests
 *  never construct the FT, so this is never invoked — a typed stub suffices. */
function fakeEmbedder(): VoyageEmbedder {
  return {
    embedDocuments: () => Promise.resolve([]),
    embedQuery: () => Promise.resolve([]),
  }
}

function convergePool(): Pool {
  const query = (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    // turnRowsExist: `SELECT 1 FROM session_messages WHERE turn_id = $1 LIMIT 1`.
    if (text.includes('FROM session_messages') && text.includes('turn_id')) {
      return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  return { query } as unknown as Pool
}

/** Like `convergePool`, but the §4.7 re-mature probe (`listAfterSeq` → `SELECT *
 *  … WHERE session_id = $1 AND seq > $2`) returns ONE unanswered player_message
 *  row, so the worker's `finally` re-arms the quiet window through the REAL
 *  builder-wired `dmTriggerQueue.add` arrow. */
function convergePoolWithTrailingPlayer(): Pool {
  const query = (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (text.includes('FROM session_messages') && text.includes('turn_id')) {
      return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 })
    }
    // listAfterSeq: a single trailing player row above the watermark.
    if (text.includes('FROM session_messages') && text.includes('seq >')) {
      return Promise.resolve({
        rows: [
          {
            id: 'm1',
            session_id: SESSION,
            seq: 1,
            user_id: 'u1',
            message_type: 'player_message',
            content: 'still here?',
            created_at: new Date(),
            turn_id: null,
            turn_ordinal: null,
          },
        ],
        rowCount: 1,
      })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  return { query } as unknown as Pool
}

describe('buildSessionTurnWorker', () => {
  let redisBatch: Redis
  let redisRealtime: Redis

  beforeEach(async () => {
    captured.worker = null
    capturedQueueAdds.length = 0
    redisBatch = new IoRedisMock()
    redisRealtime = new IoRedisMock()
    await redisRealtime.flushall()
  })
  afterEach(async () => {
    await redisBatch.quit()
    await redisRealtime.quit()
    vi.clearAllMocks()
  })

  it('runs a turn through the captured processor (converge path) and advances the watermark', async () => {
    // The builder now wires the REAL SonnetFastThinker via makeTiers, so a
    // FRESH-RUN turn would hit the real LLM — not a unit test. We instead drive
    // the §5 converge path: a fake pool reports the turnId already durable in PG,
    // so the processor converges (turn_end + watermark) WITHOUT constructing or
    // running the FT. This still exercises the builder's deps wiring (lock,
    // triggerState, repo, publisher) and the makeTiers closure is not reached —
    // the real-FT render is covered by the E2E smoke, not here.
    const logger = { warn: vi.fn(), error: vi.fn() }
    const worker = buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())
    expect(worker).not.toBeNull()

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    const job = payload()
    ;(job.data as { maxConsumedSeq: number }).maxConsumedSeq = 3

    const result = await cap.processor(job)
    expect(result).toEqual({ ran: true })

    // The §4.7 watermark advanced to maxConsumedSeq (proving triggerState was
    // wired into the deps and the converge arm advanced it).
    expect(await makeTriggerState(redisRealtime, 'bw:').respondedSeq(CAMPAIGN)).toBe(3)
  })

  it('wires triggerState + sessionTurnQueue: an in-flight explicit summon drains on release (§4.7)', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    // Seed the explicit-pending flag on the SAME keyspace the builder's
    // triggerState reads (redisRealtime), as the server would on an in-flight @dm.
    await makeTriggerState(redisRealtime, 'bw:').setExplicitPending(CAMPAIGN)

    const result = await cap.processor(payload())
    expect(result).toEqual({ ran: true })

    // The drain enqueued exactly one explicit follow-up on the builder's Queue.
    expect(capturedQueueAdds).toHaveLength(1)
    expect(capturedQueueAdds[0]?.data.trigger.kind).toBe('explicit')
    expect(capturedQueueAdds[0]?.data.campaignId).toBe(CAMPAIGN)
    expect(capturedQueueAdds[0]?.data.triggerMessages).toEqual([])
  })

  it('wires dmTriggerQueue: a trailing player row re-arms the quiet window on release (§4.7)', async () => {
    // The builder-constructed dm-trigger producer: a converged turn with an
    // unanswered player row above the watermark re-arms the debounce through the
    // REAL `dmTriggerQueue.add` arrow (the mocked Queue records the add).
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePoolWithTrailingPlayer(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')

    const result = await cap.processor(payload())
    expect(result).toEqual({ ran: true })

    // The re-mature enqueued the debounce job ('evaluate') on the builder's Queue.
    const rearm = capturedQueueAdds.find((a) => a.name === 'evaluate')
    expect(rearm).toBeDefined()
    expect((rearm?.data as unknown as { campaignId: string }).campaignId).toBe(CAMPAIGN)
  })

  it("registers a 'failed' handler that delegates to publishTerminalTurnError", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')
    const failedHandler = cap.handlers.get('failed')
    if (failedHandler === undefined) throw new Error("no 'failed' handler registered")

    // Invoke the captured arrow (L213) on a terminal (retries-exhausted) job.
    // It delegates to publishTerminalTurnError, which publishes a turn_error
    // frame on redisRealtime. Assert via a subscriber on the SAME ioredis-mock
    // instance the publisher uses (same-instance pub/sub delivers reliably).
    const sub = redisRealtime.duplicate()
    const messages: string[] = []
    sub.on('pmessage', (_pattern: string, _channel: string, message: string) => {
      messages.push(message)
    })
    await sub.psubscribe(sessionChannelPattern('bw:'))

    failedHandler(terminalFailureJob(3, 3), new Error('terminal turn failure'))

    await vi.waitFor(() => {
      expect(messages.some((m) => m.includes('turn_error'))).toBe(true)
    })
    await sub.quit()
  })

  it("the 'failed' handler is a no-op on a non-terminal job (retries remain)", () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    buildSessionTurnWorker(redisBatch, redisRealtime, 'bw:', logger, convergePool(), fakeEmbedder())

    const cap = captured.worker
    if (cap === null) throw new Error('Worker constructor was not captured')
    const failedHandler = cap.handlers.get('failed')
    if (failedHandler === undefined) throw new Error("no 'failed' handler registered")

    // attemptsMade < attempts → publishTerminalTurnError returns early; the
    // arrow still runs (covering L213) but publishes nothing.
    expect(() => {
      failedHandler(terminalFailureJob(1, 3), new Error('retryable failure'))
    }).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
