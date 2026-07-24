// MYT-73 T10 — `buildScribeWorker` boot wiring, split from the main processor
// suite (scribe-worker.test.ts) so the bullmq module mock and the file-size cap
// each stay in their lane (mirrors st-evaluation-worker-boot.test.ts).
//
// Exercise buildScribeWorker against a mocked broker: assert it builds a Worker
// on QUEUE_SCRIBE and drives the captured processor through the REAL closures
// (createRepo / makeWorkingSetRepo / makeTriggerState). The fake pool answers
// the active-session read with NO active session, so the processor reaches the
// FAIL-LOUD branch (empty/unresolvable playbook) and returns cleanly without an
// LLM call — exercising the boot deps closures (repo.sessions / sessionPreps /
// triggerState / workingSet) without a real tripwire/retcon.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Pool } from 'pg'
import { QUEUE_SCRIBE, type ScribeJobPayload } from '../scribe-queue.js'
import { buildScribeWorker } from '../scribe-worker.js'
import type { VoyageEmbedder } from '../../llm/embed.js'

const CAMPAIGN = 'c-scribe-boot-1'
const SESSION = 's-scribe-boot-1'
const WORLD = 'w-scribe-boot-1'

type CapturedProcessor = (job: { data: ScribeJobPayload }) => Promise<void>
const bullmqCapture: { processor: CapturedProcessor | null; workerName: string | null } = {
  processor: null,
  workerName: null,
}

vi.mock('bullmq', () => ({
  Worker: vi
    .fn()
    .mockImplementation((name: string, processor: CapturedProcessor) => {
      bullmqCapture.processor = processor
      bullmqCapture.workerName = name
      return { close: () => Promise.resolve(), on: vi.fn() }
    }),
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: (jobName: string, payload: unknown) => {
      queueAdds.push({ name: jobName, payload })
      return Promise.resolve({})
    },
    close: () => Promise.resolve(),
  })),
}))

const queueAdds: { name: string; payload: unknown }[] = []

// Controllable tripwire/retcon. Default OFF (throw) so the fail-loud-path tests
// surface an accidental call; the breach-path test flips them on to drive the
// boot wiring's getRespondedSeq + runRetcon closures + the real enqueueTurn.
const llmControl: {
  tripwire: 'throw' | 'clean' | 'breach'
} = { tripwire: 'throw' }
vi.mock('../../llm/secret-tripwire.js', () => ({
  runSecretTripwire: () => {
    if (llmControl.tripwire === 'throw') {
      return Promise.reject(new Error('tripwire must not run on the fail-loud path'))
    }
    const breached = llmControl.tripwire === 'breach'
    return Promise.resolve({
      result: {
        severity: breached ? 'hard_reveal' : 'none',
        confidence: 0.9,
        secretRef: breached ? '[SECRET-1]' : null,
      },
      usage: { totalTokens: 5 },
      repairAttempted: false,
    })
  },
}))
vi.mock('../../llm/retcon-author.js', () => ({
  runRetconAuthor: () =>
    Promise.resolve({
      result: { retconText: 'Open correction.', supersededContent: 'the false thing', tier: 'known' },
      usage: { totalTokens: 200 },
      repairAttempted: false,
    }),
}))

const embedder: VoyageEmbedder = {
  embedDocuments: () => Promise.resolve([]),
  embedQuery: () => Promise.resolve([]),
}

describe('buildScribeWorker — boot wiring + processor closure', () => {
  beforeEach(() => {
    bullmqCapture.processor = null
    bullmqCapture.workerName = null
    llmControl.tripwire = 'throw'
    queueAdds.length = 0
  })

  // `active` false → no active session row → resolvePlaybook returns null → the
  // processor FAILS LOUD. `active` true → an active session (number 3) + a prep
  // with a non-empty sd_playbook, so the tripwire runs through the boot closures.
  function makeFakePool(active = false): Pool {
    const query = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM sessions') && sql.includes("status = 'active'")) {
        if (!active) return Promise.resolve({ rows: [] })
        return Promise.resolve({
          rows: [
            {
              id: SESSION,
              campaign_id: CAMPAIGN,
              session_number: 3,
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
      if (sql.includes('FROM session_preps')) {
        return Promise.resolve({
          rows: [
            {
              id: 'prep-1',
              campaign_id: CAMPAIGN,
              session_number: 3,
              ft_context: 'public context',
              sd_playbook: 'The duke is the poisoner.',
              snapshot_id: null,
              created_at: new Date(0),
            },
          ],
        })
      }
      return Promise.resolve({ rows: [] })
    }
    return { query } as unknown as Pool
  }

  it('builds a Worker on QUEUE_SCRIBE and drives the captured processor to FAIL-LOUD', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const worker = buildScribeWorker(redis, redis, 'scribe:', makeFakePool(), embedder, logger)
    expect(worker).toBeDefined()
    expect(bullmqCapture.workerName).toBe(QUEUE_SCRIBE)

    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')
    await processor({
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: 't-boot-1',
        worldId: WORLD,
        prose: 'Some prose.',
        worldDelta: null,
        injections: [],
      },
    })

    // No active session → the FAIL-LOUD error log fired (scribe_tripwire_misconfigured).
    expect(logger.error).toHaveBeenCalledTimes(1)
    const msg = logger.error.mock.calls[0]?.[1] as string | undefined
    expect(msg).toContain('misconfigured')
  })

  it('the working-set append/evict closures run against the real working-set repo', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildScribeWorker(redis, redis, 'scribe:', makeFakePool(), embedder, logger)
    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')

    // One FT delta fact → embedded (empty vector from the fake embedder) + appended
    // through the real makeWorkingSetRepo RPUSH, then evictIfOver (no-op under cap).
    await processor({
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: 't-boot-2',
        worldId: WORLD,
        prose: 'Some prose.',
        worldDelta: { facts: [{ subject: 'x', content: 'a fact', kind: 'fact' }] },
        injections: [],
      },
    })

    const raw = await redis.lrange(`scribe:session:${CAMPAIGN}:workingset`, 0, -1)
    expect(raw).toHaveLength(1)
    const item = JSON.parse(raw[0] ?? '{}') as { source?: string; content?: string }
    expect(item.source).toBe('ft_delta')
    expect(item.content).toBe('a fact')
  })

  it('the breach path drives the boot getRespondedSeq + retcon + real enqueueTurn closures', async () => {
    // Active session + non-empty playbook + a breach verdict → the processor runs
    // the boot triggerState.getRespondedSeq closure (over the real makeTriggerState
    // / ioredis-mock), the runRetcon closure, and enqueues a correction turn
    // through the REAL enqueueTurn onto the boot-constructed (mocked) Queue.
    llmControl.tripwire = 'breach'
    const redis = new IoRedisMock()
    // Seed the responded-seq watermark so getRespondedSeq returns a known value.
    await redis.set(`scribe:session:${CAMPAIGN}:responded-seq`, '7')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildScribeWorker(redis, redis, 'scribe:', makeFakePool(true), embedder, logger)
    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')

    await processor({
      data: {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: 't-boot-3',
        worldId: WORLD,
        prose: 'A line that breaks the secret.',
        worldDelta: null,
        injections: [],
      },
    })

    // The correction turn landed on the session-turn queue via the real enqueueTurn.
    const turnAdd = queueAdds.find((a) => a.name === 'turn')
    expect(turnAdd).toBeDefined()
    const payload = turnAdd?.payload as {
      trigger?: { kind?: string }
      correctionText?: string
      maxConsumedSeq?: number
    }
    expect(payload.trigger?.kind).toBe('correction')
    expect(payload.correctionText).toBe('Open correction.')
    expect(payload.maxConsumedSeq).toBe(7)
  })
})
