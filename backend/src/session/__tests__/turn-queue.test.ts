// MYT-66 Task 8 — session-turn producer (`enqueueTurn`) tests.
//
// `enqueueTurn` is a thin BullMQ producer whose CORRECTNESS is the
// add-a-waiting-job-with-a-round-tripping-payload semantics — that only exists
// against a real broker, so this runs against REAL BullMQ on the dev batch
// Redis (6380, the production queue Redis), a unique queue name per run, with a
// targeted `remove` in afterEach so no jobs leak across runs.
//
// Mirrors session-suspend.test.ts's broker block: unique queueName via
// Date.now()+pid, createBullmqRedisClient, and a TARGETED `queue.remove(...)`
// (NEVER `queue.obliterate()` — its full-keyspace SCAN times out on CI's shared
// batch Redis).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Redis } from 'ioredis'
import { Queue } from 'bullmq'
import { createBullmqRedisClient } from '../../redis/bullmq-client.js'
import { enqueueTurn, TURN_JOB_NAME, type TurnJobPayload } from '../turn-queue.js'

describe('enqueueTurn — real BullMQ waiting-job producer', () => {
  // Dev batch Redis (6380) is the production queue Redis. Unique queue name
  // per run so concurrent suites / re-runs never share jobs.
  const REDIS_BATCH_URL = process.env.REDIS_BATCH_URL ?? 'redis://127.0.0.1:6380'
  const queueName = `test-session-turn-${String(Date.now())}-${String(process.pid)}`
  let connection: Redis
  let queue: Queue<TurnJobPayload>
  let addedJobId: string | undefined

  beforeEach(() => {
    connection = createBullmqRedisClient(REDIS_BATCH_URL)
    // The wiring functions (buildSessionTurnQueue) are integration-tested later;
    // here a plain Queue with the same terminal-job pruning policy suffices.
    queue = new Queue<TurnJobPayload>(queueName, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    })
    addedJobId = undefined
  })

  afterEach(async () => {
    // Remove the single job by its (server-allocated) jobId rather than
    // queue.obliterate(). obliterate does a full-keyspace SCAN MATCH, which on
    // CI's shared batch Redis blows past the 10s hook timeout. A targeted O(1)
    // remove fully isolates each test without scanning. Then close the handle +
    // connection.
    if (addedJobId !== undefined) await queue.remove(addedJobId)
    await queue.close()
    await connection.quit()
  })

  const payload: TurnJobPayload = {
    campaignId: 'c-turn',
    sessionId: 's-turn',
    turnId: 't-turn',
    triggerMessages: [
      { userId: 'userA', characterName: 'Aria', text: 'I draw my blade.' },
    ],
  }

  it('adds exactly one waiting job whose payload round-trips (incl. turnId)', async () => {
    const job = await enqueueTurn(queue, payload)
    addedJobId = (job as { id?: string }).id

    expect(await queue.getWaitingCount()).toBe(1)
    expect(addedJobId).toBeDefined()
    const stored = await queue.getJob(addedJobId ?? '')
    expect(stored).toBeDefined()
    expect(stored?.name).toBe(TURN_JOB_NAME)
    expect(stored?.data).toEqual(payload)
  })
})
