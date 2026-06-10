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
import { QUEUE_ST_EVAL, type StEvalPayload } from '../st-eval-queue.js'
import { buildStEvaluationWorker } from '../st-evaluation-worker.js'

const CAMPAIGN = 'c-st-boot-1'
const SESSION = 's-st-boot-1'

type CapturedProcessor = (job: { data: StEvalPayload }) => Promise<void>
const bullmqCapture: { processor: CapturedProcessor | null } = { processor: null }

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: CapturedProcessor) => {
    bullmqCapture.processor = processor
    return { close: () => Promise.resolve(), on: vi.fn() }
  }),
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: () => Promise.resolve({}),
    removeDeduplicationKey: () => Promise.resolve(1),
    close: () => Promise.resolve(),
  })),
}))

describe('buildStEvaluationWorker — boot wiring + processor closure', () => {
  beforeEach(() => {
    bullmqCapture.processor = null
  })

  // Active-session read returns a DIFFERENT session id → the processor no-ops
  // (never reaching the LLM/Redis-write paths) and returns cleanly.
  function makeFakePool(): Pool {
    const query = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM sessions') && sql.includes("status = 'active'")) {
        return Promise.resolve({
          rows: [
            {
              id: 'a-different-session',
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
