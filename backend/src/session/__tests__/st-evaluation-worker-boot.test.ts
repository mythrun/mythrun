// MYT-69 Task 10 — `buildStEvaluationWorker` boot wiring, split from the main
// pipeline suite (st-evaluation-worker.test.ts) so the bullmq module mock and
// the 400-line file cap each stay in their lane.
//
// Exercise buildStEvaluationWorker against a mocked broker: assert it builds a
// Worker on QUEUE_ST_EVAL and drives the captured processor through the real
// closures (createRepo / makeSessionState / makeTriggerState). The fake pool
// answers the active-session read with a NON-matching session, so the processor
// reaches the no-op branch (it never touches the LLM) and returns cleanly.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Pool } from 'pg'
import { QUEUE_ST_EVAL, ST_EVAL_JOB_NAME, stEvalDedupId, type StEvalPayload } from '../st-eval-queue.js'
import { buildStEvaluationWorker } from '../st-evaluation-worker.js'
import type { TriggerState } from '../trigger-state.js'

const CAMPAIGN = 'c-st-boot-1'
const SESSION = 's-st-boot-1'

type CapturedProcessor = (job: { data: StEvalPayload }) => Promise<void>
const bullmqCapture: { processor: CapturedProcessor | null } = { processor: null }

// Records the constructed Queue's dedup/add calls so the re-arm-closure test can
// assert the removeDeduplicationKey → add ordering and args.
interface QueueCalls {
  removeDedup: string[]
  add: { name: string; payload: StEvalPayload; opts: unknown }[]
}
const queueCalls: QueueCalls = { removeDedup: [], add: [] }

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: CapturedProcessor) => {
    bullmqCapture.processor = processor
    return { close: () => Promise.resolve(), on: vi.fn() }
  }),
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: (jobName: string, payload: StEvalPayload, opts: unknown) => {
      queueCalls.add.push({ name: jobName, payload, opts })
      return Promise.resolve({})
    },
    removeDeduplicationKey: (id: string) => {
      queueCalls.removeDedup.push(id)
      return Promise.resolve(1)
    },
    close: () => Promise.resolve(),
  })),
}))

// A controllable TriggerState so the re-arm-closure test can advance the
// responded-seq watermark BETWEEN the processor's two reads (start snapshot vs
// end re-arm check) — the only way to drive the §2 self-re-arm branch through
// the boot wiring. The gate is mocked to throw so the processor reaches
// writeUsageAndReArm without an LLM call. All other methods throw (the gate-fail
// path never reaches them; an accidental call is loud).
const triggerCapture: { respondedSeqCalls: number; reArm: boolean } = {
  respondedSeqCalls: 0,
  reArm: true,
}
vi.mock('../trigger-state.js', () => ({
  // The gate-fail re-arm path touches respondedSeq + turnsSinceSt; the full-write
  // path additionally touches the read/write slots below (benign no-ops). Any
  // OTHER property is a loud thrower so an unexpected call surfaces. The cast
  // tolerates the partial surface (the unreached methods are never invoked).
  makeTriggerState: (): TriggerState => {
    const loud = (): never => {
      throw new Error('TriggerState method unexpected in this boot path')
    }
    // Only the methods the two boot paths touch; the Proxy fallback makes any
    // OTHER access return `loud` so an unexpected call surfaces. `surface` is
    // typed so the bracket-access in the trap is not `any` (no-unsafe-return).
    const surface: Record<string, () => Promise<unknown>> = {
      respondedSeq: () => {
        triggerCapture.respondedSeqCalls += 1
        // 1st read = start snapshot (5); 2nd = re-arm check (8 advances → re-arm).
        return Promise.resolve(triggerCapture.respondedSeqCalls === 1 ? 5 : triggerCapture.reArm ? 8 : 5)
      },
      turnsSinceSt: () => Promise.resolve(1),
      resetTurnsSinceSt: () => Promise.resolve(),
      readStandingDirection: () => Promise.resolve(null),
      peekOneShotDirection: () => Promise.resolve(null),
      setOneShotDirection: () => Promise.resolve(),
      setStandingDirection: () => Promise.resolve(),
      clearStandingDirection: () => Promise.resolve(),
    }
    return new Proxy(surface, {
      get: (target, prop): (() => Promise<unknown>) | (() => never) =>
        (typeof prop === 'string' ? target[prop] : undefined) ?? loud,
    }) as unknown as TriggerState
  },
}))

// Controllable Haiku gate. Default: throws → the gate catch arm runs
// writeUsageAndReArm (LLM-free) and reaches the boot reArm closure. The
// full-write test flips `gateThrows` off + returns needed:true so the processor
// runs the director and the boot's setRunningSummary/incrUsageSt deps closures.
const llmControl = { gateThrows: true }
vi.mock('../../llm/st-gate.js', () => ({
  runStGate: () =>
    llmControl.gateThrows
      ? Promise.reject(new Error('gate unavailable in boot test'))
      : Promise.resolve({
          result: { needed: true, confidence: 0.5, reason: 'rising' },
          usage: { totalTokens: 10, inputTokens: 10, outputTokens: 0 },
        }),
}))

// Controllable Opus director — returns a full intervene+set+summary result so
// the boot wiring's setRunningSummary + incrUsageSt deps closures run (against
// the real makeSessionState over ioredis-mock).
vi.mock('../../llm/st-director.js', () => ({
  runStDirector: () =>
    Promise.resolve({
      result: {
        reasoning: 'decision point',
        intervene: true,
        direction: 'D',
        standingDirective: { action: 'set', text: 'S' },
        summaryUpdate: 'NEW SUMMARY',
      },
      usage: { totalTokens: 100, inputTokens: 100, outputTokens: 0 },
      repairAttempted: false,
    }),
}))

describe('buildStEvaluationWorker — boot wiring + processor closure', () => {
  beforeEach(() => {
    bullmqCapture.processor = null
    queueCalls.removeDedup = []
    queueCalls.add = []
    triggerCapture.respondedSeqCalls = 0
    triggerCapture.reArm = true
    llmControl.gateThrows = true
  })

  // Active-session read returns `activeSessionId` (default: a NON-matching id, so
  // the processor no-ops before any LLM/Redis-write path). Pass SESSION to drive
  // the matching path. Every other query answers empty (sdPlaybook → '', empty
  // history + roster), which is fine for the gate-fail re-arm path.
  function makeFakePool(activeSessionId = 'a-different-session'): Pool {
    const query = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM sessions') && sql.includes("status = 'active'")) {
        return Promise.resolve({
          rows: [
            {
              id: activeSessionId,
              campaign_id: CAMPAIGN,
              session_number: 1,
              status: 'active',
              started_at: new Date(0),
              ended_at: null,
              summary: null,
              st_running_summary: null,
              handoff: null,
            },
          ],
        })
      }
      return Promise.resolve({ rows: [] })
    }
    return { query } as unknown as Pool
  }

  it('builds an st-evaluation Worker and drives the captured processor', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const worker = buildStEvaluationWorker(redis, redis, 'st:', makeFakePool(), logger)
    expect(worker).toBeDefined()

    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')
    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION } })

    // No matching active session → the no-op info log fired.
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('the boot reArm closure clears its own dedup key THEN re-adds with the dedup option', async () => {
    // Matching active session + the gate mocked to throw → the processor reaches
    // writeUsageAndReArm; the controllable triggerState advances the watermark
    // (5 → 8) between the two respondedSeq reads, so the §2 self-re-arm fires
    // through the REAL boot closure (queue.removeDeduplicationKey → enqueueStEval).
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildStEvaluationWorker(redis, redis, 'st:', makeFakePool(SESSION), logger)
    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')
    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION } })

    // removeDeduplicationKey(stEvalDedupId(cId)) ran exactly once...
    expect(queueCalls.removeDedup).toEqual([stEvalDedupId(CAMPAIGN)])
    // ...THEN the re-add with the dedup option (enqueueStEval's shape).
    expect(queueCalls.add).toEqual([
      {
        name: ST_EVAL_JOB_NAME,
        payload: { campaignId: CAMPAIGN, sessionId: SESSION },
        opts: { deduplication: { id: stEvalDedupId(CAMPAIGN) } },
      },
    ])
  })

  it('the boot reArm closure does NOT fire when the watermark is unchanged', async () => {
    triggerCapture.reArm = false // both respondedSeq reads return 5 → no advance.
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildStEvaluationWorker(redis, redis, 'st:', makeFakePool(SESSION), logger)
    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')
    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION } })

    expect(queueCalls.removeDedup).toEqual([])
    expect(queueCalls.add).toEqual([])
  })

  it('the full-write boot path drives the real setRunningSummary + incrUsageSt deps closures', async () => {
    // Gate returns needed:true (no throw) → the director runs (mocked full result)
    // → writeStOutputs + writeUsageAndReArm. This exercises the boot wiring's
    // sessionState.setRunningSummary + sessionState.incrUsageSt closures, which
    // delegate to the REAL makeSessionState over ioredis-mock. Watermark
    // unchanged (5 → 5) so no re-arm; assert the summary + usage:st landed.
    llmControl.gateThrows = false
    triggerCapture.reArm = false
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildStEvaluationWorker(redis, redis, 'st:', makeFakePool(SESSION), logger)
    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')
    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION } })

    // setRunningSummary closure → :summary SET on the real session-state shape.
    expect(await redis.get(`st:session:${CAMPAIGN}:summary`)).toBe('NEW SUMMARY')
    // incrUsageSt closure → :usage:st INCRBY of gate(10)+director(100) = 110.
    expect(await redis.get(`st:session:${CAMPAIGN}:usage:st`)).toBe('110')
  })

  it('builds the Worker on the QUEUE_ST_EVAL queue name', () => {
    const redis = new IoRedisMock()
    buildStEvaluationWorker(redis, redis, 'st:', makeFakePool(), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })
    expect(QUEUE_ST_EVAL).toBe('st-evaluation')
  })
})
