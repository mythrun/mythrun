// MYT-65 Task 10 — session-suspend tests.
//
// Two surfaces, two harnesses:
//
//  1. The PROCESSOR (`processSuspendJob`) is the load-bearing self-validating
//     logic — on fire it RE-READS live presence and only suspends when presence
//     is genuinely zero. This neutralizes both a stale connection counter and
//     the BullMQ jobId-dedup footgun (a delayed job that "shouldn't" have fired
//     but did must not blindly suspend). It needs no BullMQ — drive it directly
//     over `makeSessionState` on `ioredis-mock` + a recording `CheckpointStore`
//     + a recording `sessions.update`.
//
//  2. `scheduleSuspend` / `cancelSuspend` are thin BullMQ wrappers whose
//     CORRECTNESS is the delayed-job + jobId-dedup semantics — those only exist
//     against a real broker, so this half runs against REAL BullMQ on the dev
//     batch Redis (6380, the production queue Redis), a unique queue name per
//     run, with drain/obliterate in afterEach so no jobs leak across runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { Queue } from 'bullmq'
import { createBullmqRedisClient } from '../../redis/bullmq-client.js'
import { makeSessionState, type CheckpointStore } from '../../redis/session-state.js'
import {
  cancelSuspend,
  processSuspendJob,
  scheduleSuspend,
  suspendJobId,
  type SuspendJobPayload,
  type SuspendProcessorDeps,
} from '../session-suspend.js'

const KEY_PREFIX = 'test:use1:'

// --- Processor: the self-validating suspend logic (ioredis-mock, no broker) ---

describe('processSuspendJob — self-validating presence re-read', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IoRedisMock()
    // ioredis-mock shares ONE in-memory keyspace per process; flush per test.
    await redis.flushall()
  })
  afterEach(async () => {
    await redis.quit()
  })

  function makeRecordingStore(): {
    store: CheckpointStore
    reads: string[]
    writes: { sessionId: string; envelope: string }[]
  } {
    const reads: string[] = []
    const writes: { sessionId: string; envelope: string }[] = []
    const store: CheckpointStore = {
      readMaxSeq: vi.fn((sessionId: string) => {
        reads.push(sessionId)
        return Promise.resolve(7)
      }),
      writeCheckpoint: vi.fn((sessionId: string, envelope: string) => {
        writes.push({ sessionId, envelope })
        return Promise.resolve()
      }),
    }
    return { store, reads, writes }
  }

  function makeDeps(redisClient: Redis, store: CheckpointStore) {
    const sessionState = makeSessionState(redisClient, KEY_PREFIX)
    const refreshTtls = vi.spyOn(sessionState, 'refreshTtls')
    const deps: SuspendProcessorDeps = { sessionState, store }
    return { deps, refreshTtls }
  }

  function fakeJob(payload: SuspendJobPayload): { data: SuspendJobPayload } {
    return { data: payload }
  }

  it('presence > 0 on fire → does NOT checkpoint (suspend is cancelled)', async () => {
    const campaignId = 'c-live'
    const sessionId = 's-live'
    const { store, reads, writes } = makeRecordingStore()
    const { deps, refreshTtls } = makeDeps(redis, store)

    // A live connection is present — the player reconnected (or never left) but
    // the cancel raced the fire. The job must self-validate and bail.
    await deps.sessionState.addPresence(campaignId, 'container-1', 'userA')

    const result = await processSuspendJob(deps, fakeJob({ sessionId, campaignId }))

    expect(result.suspended).toBe(false)
    expect(result.presence).toBe(1)
    expect(reads).toHaveLength(0) // no checkpoint read
    expect(writes).toHaveLength(0) // no checkpoint write
    expect(refreshTtls).not.toHaveBeenCalled()
  })

  it('presence == 0 on fire → checkpoints (durable maxSeq + state envelope) and extends TTLs', async () => {
    const campaignId = 'c-empty'
    const sessionId = 's-empty'
    const { store, reads, writes } = makeRecordingStore()
    const { deps, refreshTtls } = makeDeps(redis, store)

    // Seed live state so the checkpoint envelope captures it; no presence keys.
    await deps.sessionState.setState(campaignId, {
      participants: ['userA', 'userB'],
      mode: 'exploration',
      status: 'active',
    })

    const result = await processSuspendJob(deps, fakeJob({ sessionId, campaignId }))

    expect(result.suspended).toBe(true)
    expect(result.presence).toBe(0)
    // checkpoint() read the DURABLE max via the store, keyed by sessionId.
    expect(reads).toEqual([sessionId])
    expect(writes).toHaveLength(1)
    expect(writes[0]?.sessionId).toBe(sessionId)
    const parsed = JSON.parse(writes[0]?.envelope ?? '{}') as {
      kind?: string
      maxSeq?: number
      state?: { mode?: string } | null
    }
    expect(parsed.kind).toBe('myt65-checkpoint')
    expect(parsed.maxSeq).toBe(7)
    expect(parsed.state?.mode).toBe('exploration')
    // Redis keys held (~1h) for a cheap reconnect cold-start; status untouched
    // (suspend keeps status='active' — suspend != end).
    expect(refreshTtls).toHaveBeenCalledWith(campaignId)
  })

  it('keeps status active — the processor never writes session.status', async () => {
    const campaignId = 'c-status'
    const sessionId = 's-status'
    const sessionState = makeSessionState(redis, KEY_PREFIX)
    const writeCheckpoint = vi.fn(() => Promise.resolve())
    // The ONLY Postgres write a suspend makes is the checkpoint envelope (into
    // st_running_summary). There is no separate status flip — suspend keeps
    // status='active', which is already the live value, so nothing writes it.
    const deps: SuspendProcessorDeps = {
      sessionState,
      store: {
        readMaxSeq: vi.fn(() => Promise.resolve(0)),
        writeCheckpoint,
      },
    }

    const result = await processSuspendJob(deps, { data: { sessionId, campaignId } })
    expect(result.suspended).toBe(true)
    // Exactly one write — the checkpoint envelope. No separate status flip.
    expect(writeCheckpoint).toHaveBeenCalledTimes(1)
  })
})

// --- scheduleSuspend / cancelSuspend against a real BullMQ broker ---

describe('scheduleSuspend / cancelSuspend — real BullMQ delayed-job + jobId dedup', () => {
  // Dev batch Redis (6380) is the production queue Redis. Unique queue name
  // per run so concurrent suites / re-runs never share delayed jobs.
  const REDIS_BATCH_URL = process.env.REDIS_BATCH_URL ?? 'redis://127.0.0.1:6380'
  const queueName = `test-session-suspend-${String(Date.now())}-${String(process.pid)}`
  let connection: Redis
  let queue: Queue<SuspendJobPayload>

  beforeEach(() => {
    connection = createBullmqRedisClient(REDIS_BATCH_URL)
    // Mirror the production session-suspend queue's removeOnComplete/Fail policy
    // so a re-add with a live jobId is exercised under the real terminal-job
    // pruning behavior the footgun fix relies on.
    queue = new Queue<SuspendJobPayload>(queueName, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    })
  })

  afterEach(async () => {
    // Remove the single delayed job by its (constant) jobId rather than
    // queue.obliterate(). obliterate does a full-keyspace SCAN MATCH, which on
    // CI's shared batch Redis — every parallel test file hits 6380 at once —
    // blows past the 10s hook timeout. This block only ever creates the one
    // suspend job (deduped on suspendJobId), so a targeted O(1) remove fully
    // isolates each test without scanning. Then close the handle + connection.
    await queue.remove(suspendJobId(sessionId))
    await queue.close()
    await connection.quit()
  })

  const sessionId = 's-broker'
  const campaignId = 'c-broker'

  it('scheduleSuspend enqueues exactly one delayed job under the suspend jobId', async () => {
    await scheduleSuspend(queue, sessionId, campaignId)

    expect(await queue.getDelayedCount()).toBe(1)
    const job = await queue.getJob(suspendJobId(sessionId))
    expect(job).not.toBeNull()
    expect(job?.data).toEqual({ sessionId, campaignId })
    // The delay is the 5-minute grace window.
    expect(job?.opts.delay).toBe(5 * 60_000)
  })

  it('cancelSuspend removes the delayed job (reconnect path)', async () => {
    await scheduleSuspend(queue, sessionId, campaignId)
    expect(await queue.getDelayedCount()).toBe(1)

    await cancelSuspend(queue, sessionId)

    expect(await queue.getDelayedCount()).toBe(0)
    expect(await queue.getJob(suspendJobId(sessionId))).toBeUndefined()
  })

  it('schedule → cancel → schedule again yields exactly ONE delayed job (no silent dedup no-op)', async () => {
    // The footgun: BullMQ keeps terminal jobs by default, so a re-add with a
    // live jobId silently no-ops. cancelSuspend must REMOVE the job so the
    // re-schedule actually lands a fresh delayed job rather than dedup-skipping.
    await scheduleSuspend(queue, sessionId, campaignId)
    await cancelSuspend(queue, sessionId)
    await scheduleSuspend(queue, sessionId, campaignId)

    expect(await queue.getDelayedCount()).toBe(1)
    const job = await queue.getJob(suspendJobId(sessionId))
    expect(job).not.toBeNull()
    expect(job?.data).toEqual({ sessionId, campaignId })
  })
})
