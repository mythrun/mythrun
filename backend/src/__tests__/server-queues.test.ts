import { describe, it, expect, vi } from 'vitest'
import IoredisMock from 'ioredis-mock'
import { buildLlmHealthProbeQueue, buildSessionAnalysisQueue } from '../server-queues.js'
import { QUEUE_SESSION_ANALYSIS } from '../session/post-session-analysis.js'
import { QUEUE_LLM_HEALTH_PROBE } from '../llm/llm-health-probe.js'

// MYT-74b T14: lock in the session-analysis producer Queue's policy.
//
// The post-session-analysis processor is NOT total — it THROWS on transient
// failure expecting BullMQ to RETRY (the `summary IS NULL` write gate keeps the
// retry idempotent). A plain `new Queue(...)` defaults to `attempts: 1`, which
// makes that throw-to-retry design fictional. `buildSessionAnalysisQueue` is the
// single source of the `attempts: 5 + exponential backoff` policy; this test
// pins it so a future refactor that drops the retry config trips here. Mirrors
// the world-gen `queue-config.test.ts` shape (reads `bullmqQueue.opts`).
describe('buildSessionAnalysisQueue', () => {
  it('builds the session-analysis Queue with the attempts:5 retry policy', async () => {
    const { bullmqQueue, sessionAnalysisQueue } = buildSessionAnalysisQueue(new IoredisMock())

    expect(bullmqQueue.name).toBe(QUEUE_SESSION_ANALYSIS)
    const opts = bullmqQueue.opts.defaultJobOptions
    expect(opts?.attempts).toBe(5)
    expect(opts?.backoff).toEqual({ type: 'exponential', delay: 30000 })
    expect(opts?.removeOnComplete).toBe(true)
    expect(opts?.removeOnFail).toBe(true)

    // The returned adapter exposes the narrow producer surface (`add`).
    expect(typeof sessionAnalysisQueue.add).toBe('function')

    await bullmqQueue.close()
  })

  it('delegates sessionAnalysisQueue.add to the underlying bullmqQueue', async () => {
    const { bullmqQueue, sessionAnalysisQueue } = buildSessionAnalysisQueue(new IoredisMock())

    // Adapter passthrough: stub the BullMQ Queue's `add` (ioredis-mock can't run
    // BullMQ's cmsgpack Lua, so a real broker round-trip isn't viable in unit) and
    // assert the narrow adapter forwards (name, data, opts) verbatim — proving the
    // adapter is wired to bullmqQueue, not a no-op or a divergent shape.
    const addSpy = vi
      .spyOn(bullmqQueue, 'add')
      .mockResolvedValue({ id: 'analysis-s1' } as never)
    const payload = { campaignId: 'c1', sessionId: 's1' }
    await sessionAnalysisQueue.add('analysis', payload, { jobId: 'analysis-s1' })
    expect(addSpy).toHaveBeenCalledWith('analysis', payload, { jobId: 'analysis-s1' })

    await bullmqQueue.close()
  })
})

// llm-outage-resilience Task 7: lock in the probe Queue's policy. `attempts: 1`
// is load-bearing — the next 60s scheduler tick is the retry, and an
// in-interval BullMQ retry would violate the cycle-under-interval single-flight
// invariant (design §2.2). The {count: 0} pruning keeps a long outage from
// accumulating a terminal-job record per minute in Redis.
describe('buildLlmHealthProbeQueue', () => {
  it('builds the probe Queue single-attempt with terminal-job pruning', async () => {
    const { bullmqQueue } = buildLlmHealthProbeQueue(new IoredisMock())

    expect(bullmqQueue.name).toBe(QUEUE_LLM_HEALTH_PROBE)
    const opts = bullmqQueue.opts.defaultJobOptions
    expect(opts?.attempts).toBe(1)
    expect(opts?.removeOnComplete).toEqual({ count: 0 })
    expect(opts?.removeOnFail).toEqual({ count: 0 })

    await bullmqQueue.close()
  })
})
