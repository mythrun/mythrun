// MYT-67 T9 — the dm-trigger worker (`dm-trigger-worker.ts`, spec §4.3).
//
// `processDmTriggerJob(deps, job)` is the ORDERED decision shell that runs when
// the quiet-window debounce job matures: re-validate quiet → resolve the active
// session + build the batch → decide (dead-air / explicit / solo / auto) → guard
// against an in-flight turn → enqueue exactly one `session-turn` (or re-arm the
// debounce and exit). Every dependency is injected as a struct param, so the
// whole decision tree is unit-testable WITHOUT a broker, Redis, DB, or LLM —
// each case below passes plain recording/stub fakes and asserts the observable
// side effects (which queue was added to, with what payload; whether the
// classifier ran; whether the debounce was re-armed).

import IoRedisMock from 'ioredis-mock'
import type { Pool } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUIET_WINDOW_MS,
  DEAD_AIR_MS,
  DM_TRIGGER_JOB_NAME,
} from '../dm-trigger-config.js'
import type { DmTriggerClassification } from '../../llm/schemas/dm-trigger-classification.js'
import type { Repo } from '../../repo/index.js'
import type { SessionMessage } from '../../repo/types.js'
import type { TriggerMessage } from '../tiers/types.js'
import { TURN_JOB_NAME, QUEUE_SESSION_TURN, type TurnJobPayload } from '../turn-queue.js'
import type { DmTriggerPayload } from '../dm-trigger-queue.js'
import {
  processDmTriggerJob,
  makeDmTriggerDeps,
  buildDmTriggerWorker,
  type DmTriggerDepsParts,
  type DmTriggerProcessorDeps,
} from '../dm-trigger-worker.js'

// `buildDmTriggerWorker` constructs two `new Queue(...)` producers + the
// `new Worker(...)`. The mock captures the Worker processor so the test can
// drive it directly (the real boot path never invokes it), records the
// session-turn producer's `.add`, and stays inert otherwise. Scoped to the
// buildDmTriggerWorker describe — the processDmTriggerJob / makeDmTriggerDeps
// suites inject everything and never touch the broker.
type CapturedProcessor = (job: { data: DmTriggerPayload }) => Promise<void>
const bullmqCapture: {
  processor: CapturedProcessor | null
  turnAdds: { name: string; payload: unknown }[]
} = { processor: null, turnAdds: [] }

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: CapturedProcessor) => {
    bullmqCapture.processor = processor
    return { close: () => Promise.resolve(), on: vi.fn() }
  }),
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: (jobName: string, payload: unknown) => {
      if (name === QUEUE_SESSION_TURN) bullmqCapture.turnAdds.push({ name: jobName, payload })
      return Promise.resolve({})
    },
    close: () => Promise.resolve(),
  })),
}))

const CAMPAIGN = 'c-dt-1'
const SESSION = 's-dt-1'

const BATCH: TriggerMessage[] = [
  { userId: 'u1', characterName: 'Mara', text: 'I check the stall wares' },
]

/** Recording fakes for the two producers + the classifier, plus knobs for the
 *  trigger/session/member state each case sets up. The defaults describe the
 *  common "quiet, multiplayer, non-empty batch, no turn in flight" path; each
 *  test overrides only the fields it cares about. */
interface Recorders {
  readonly turnAdds: TurnJobPayload[]
  readonly debounceAdds: { delayMs: number }[]
  readonly classifyCalls: number
}

interface Knobs {
  lastActivityMs: number | null
  session: { id: string } | null
  batch: TriggerMessage[]
  maxSeq: number
  respondedSeq: number
  isResponding: boolean
  explicitPending: boolean
  acceptedMembers: number
  summary: string
  classification: DmTriggerClassification
  nowMs: number
}

function defaultClassification(): DmTriggerClassification {
  return {
    shouldRespond: true,
    intent: 'reactive',
    complexity: 'low',
    confidence: 0.9,
    reason: 'addressed an NPC',
  }
}

function makeHarness(overrides: Partial<Knobs> = {}): {
  deps: DmTriggerProcessorDeps
  rec: Recorders
  knobs: Knobs
} {
  const knobs: Knobs = {
    // now − lastActivity = 5000 ≥ QUIET_WINDOW_MS (4000) → quiet, but < DEAD_AIR.
    lastActivityMs: 5_000,
    session: { id: SESSION },
    batch: BATCH,
    maxSeq: 7,
    respondedSeq: 3,
    isResponding: false,
    explicitPending: false,
    acceptedMembers: 3,
    summary: 'A crowded market square at dusk.',
    classification: defaultClassification(),
    nowMs: 10_000,
    ...overrides,
  }

  const turnAdds: TurnJobPayload[] = []
  const debounceAdds: { delayMs: number }[] = []
  const counters = { classifyCalls: 0 }

  const deps: DmTriggerProcessorDeps = {
    triggerState: {
      lastActivityMs: () => Promise.resolve(knobs.lastActivityMs),
      respondedSeq: () => Promise.resolve(knobs.respondedSeq),
      isResponding: () => Promise.resolve(knobs.isResponding),
      takeExplicitPending: () => Promise.resolve(knobs.explicitPending),
    },
    repo: {
      sessions: {
        getActiveByCampaign: () => Promise.resolve(knobs.session),
      },
      campaigns: {
        countAcceptedMembers: () => Promise.resolve(knobs.acceptedMembers),
      },
    },
    sessionState: {
      loadTurnState: () =>
        Promise.resolve({ summary: knobs.summary, ftHistory: [], usage: { input: 0, output: 0 } }),
    },
    buildTurnBatch: () => Promise.resolve({ batch: knobs.batch, maxSeq: knobs.maxSeq }),
    classify: () => {
      counters.classifyCalls += 1
      return Promise.resolve(knobs.classification)
    },
    enqueueTurn: (payload) => {
      turnAdds.push(payload)
      return Promise.resolve()
    },
    rescheduleDebounce: (_campaignId, delayMs) => {
      debounceAdds.push({ delayMs })
      return Promise.resolve()
    },
    randomTurnId: () => 'turn-fixed',
    now: () => knobs.nowMs,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }

  const rec: Recorders = {
    turnAdds,
    debounceAdds,
    get classifyCalls() {
      return counters.classifyCalls
    },
  }

  return { deps, rec, knobs }
}

const job = { data: { campaignId: CAMPAIGN } satisfies DmTriggerPayload }

describe('processDmTriggerJob — late-reset re-validation (spec §4.3 step 1)', () => {
  it('re-arms the debounce and does not enqueue when a reset landed during pickup', async () => {
    // sinceLastActivity = now(10_000) − lastActivity(8_000) = 2_000 < QUIET_WINDOW_MS.
    const { deps, rec } = makeHarness({ lastActivityMs: 8_000 })

    await processDmTriggerJob(deps, job)

    expect(rec.turnAdds).toHaveLength(0)
    expect(rec.classifyCalls).toBe(0)
    expect(rec.debounceAdds).toHaveLength(1)
    // re-arm for the remaining quiet: QUIET_WINDOW_MS − sinceLastActivity.
    expect(rec.debounceAdds[0]?.delayMs).toBe(QUIET_WINDOW_MS - 2_000)
  })

  it('treats a missing last-activity stamp as 0 (full quiet elapsed)', async () => {
    // lastActivityMs null → `?? 0`, so sinceLastActivity = now(10_000) ≥ QUIET,
    // and the decision proceeds normally (no early re-arm).
    const { deps, rec } = makeHarness({ lastActivityMs: null })

    await processDmTriggerJob(deps, job)

    expect(rec.debounceAdds).toHaveLength(0)
    expect(rec.turnAdds).toHaveLength(1)
  })
})

describe('processDmTriggerJob — empty batch / no active session (spec §4.3 step 2)', () => {
  it('exits without enqueue or re-arm when there is no active session', async () => {
    const { deps, rec } = makeHarness({ session: null })

    await processDmTriggerJob(deps, job)

    expect(rec.turnAdds).toHaveLength(0)
    expect(rec.debounceAdds).toHaveLength(0)
    expect(rec.classifyCalls).toBe(0)
  })

  it('exits without enqueue when the batch is empty (no-monologue guard)', async () => {
    const { deps, rec } = makeHarness({ batch: [] })

    await processDmTriggerJob(deps, job)

    expect(rec.turnAdds).toHaveLength(0)
    expect(rec.classifyCalls).toBe(0)
  })
})

describe('processDmTriggerJob — dead-air ceiling (spec §4.3 step 3, dead-air)', () => {
  it('enqueues a proactive turn skipping the classifier after total silence', async () => {
    // sinceLastActivity = 65_000 ≥ DEAD_AIR_MS (60_000).
    const { deps, rec } = makeHarness({ nowMs: 70_000, lastActivityMs: 5_000 })

    await processDmTriggerJob(deps, job)

    expect(rec.classifyCalls).toBe(0)
    expect(rec.turnAdds).toHaveLength(1)
    const [p] = rec.turnAdds
    expect(p).toBeDefined()
    if (!p) return
    expect(p.trigger.kind).toBe('auto')
    expect(p.trigger.classification).toEqual({
      intent: 'proactive',
      complexity: 'high',
      confidence: 1,
    })
    expect(p.sessionId).toBe(SESSION)
    expect(p.triggerMessages).toEqual(BATCH)
    expect(p.maxConsumedSeq).toBe(7)
    expect(p.turnId).toBe('turn-fixed')
  })
})

describe('processDmTriggerJob — explicit pending (spec §4.3 step 3, explicit)', () => {
  it('enqueues an explicit turn skipping the classifier when the flag is set', async () => {
    const { deps, rec } = makeHarness({ explicitPending: true })

    await processDmTriggerJob(deps, job)

    expect(rec.classifyCalls).toBe(0)
    expect(rec.turnAdds).toHaveLength(1)
    expect(rec.turnAdds[0]?.trigger).toEqual({ kind: 'explicit' })
  })
})

describe('processDmTriggerJob — solo (spec §4.3 step 3, solo)', () => {
  it('enqueues a solo turn skipping the classifier for a 1-member campaign', async () => {
    const { deps, rec } = makeHarness({ acceptedMembers: 1 })

    await processDmTriggerJob(deps, job)

    expect(rec.classifyCalls).toBe(0)
    expect(rec.turnAdds).toHaveLength(1)
    expect(rec.turnAdds[0]?.trigger).toEqual({ kind: 'solo' })
  })
})

describe('processDmTriggerJob — auto respond (spec §4.3 step 3, auto)', () => {
  it('classifies and enqueues an auto turn carrying the classification when shouldRespond', async () => {
    const { deps, rec } = makeHarness()

    await processDmTriggerJob(deps, job)

    expect(rec.classifyCalls).toBe(1)
    expect(rec.turnAdds).toHaveLength(1)
    const [p] = rec.turnAdds
    expect(p).toBeDefined()
    if (!p) return
    expect(p.trigger.kind).toBe('auto')
    expect(p.trigger.classification).toEqual({
      intent: 'reactive',
      complexity: 'low',
      confidence: 0.9,
    })
  })

  it('passes the public batch + pacing + summary grounding to the classifier', async () => {
    const calls: unknown[] = []
    const { deps } = makeHarness()
    const wrapped: DmTriggerProcessorDeps = {
      ...deps,
      classify: (ctx) => {
        calls.push(ctx)
        return Promise.resolve(defaultClassification())
      },
    }

    await processDmTriggerJob(wrapped, job)

    expect(calls).toHaveLength(1)
    const ctx = calls[0] as {
      messages: { characterName: string; text: string }[]
      lastDmOutput: string | null
      turnsSinceLastDmBeat: number
      secondsSinceLastDmBeat: number
      sceneGrounding: string | null
    }
    expect(ctx.messages).toEqual([{ characterName: 'Mara', text: 'I check the stall wares' }])
    expect(ctx.lastDmOutput).toBe('A crowded market square at dusk.')
    expect(ctx.sceneGrounding).toBe('A crowded market square at dusk.')
    expect(ctx.turnsSinceLastDmBeat).toBe(1)
    // sinceLastActivity = 5_000ms → 5s.
    expect(ctx.secondsSinceLastDmBeat).toBe(5)
  })

  it('uses null grounding when the running summary is empty', async () => {
    const calls: { lastDmOutput: string | null; sceneGrounding: string | null }[] = []
    const { deps } = makeHarness({ summary: '' })
    const wrapped: DmTriggerProcessorDeps = {
      ...deps,
      classify: (ctx) => {
        calls.push({ lastDmOutput: ctx.lastDmOutput, sceneGrounding: ctx.sceneGrounding })
        return Promise.resolve(defaultClassification())
      },
    }

    await processDmTriggerJob(wrapped, job)

    expect(calls[0]?.lastDmOutput).toBeNull()
    expect(calls[0]?.sceneGrounding).toBeNull()
  })
})

describe('processDmTriggerJob — auto sit-back (spec §4.3 step 3, auto false)', () => {
  it('does not enqueue and re-arms toward the dead-air mark when shouldRespond is false', async () => {
    const { deps, rec } = makeHarness({
      classification: {
        shouldRespond: false,
        intent: 'reactive',
        complexity: 'low',
        confidence: 0.9,
        reason: 'grounded player-to-player RP',
      },
    })

    await processDmTriggerJob(deps, job)

    expect(rec.classifyCalls).toBe(1)
    expect(rec.turnAdds).toHaveLength(0)
    expect(rec.debounceAdds).toHaveLength(1)
    // re-arm to fire at the dead-air mark: DEAD_AIR_MS − sinceLastActivity(5_000).
    expect(rec.debounceAdds[0]?.delayMs).toBe(DEAD_AIR_MS - 5_000)
  })
})

describe('processDmTriggerJob — in-flight drain guard (spec §4.3 step 4)', () => {
  it('does not enqueue when a turn is already in flight, even on a respond decision', async () => {
    const { deps, rec } = makeHarness({ isResponding: true })

    await processDmTriggerJob(deps, job)

    expect(rec.turnAdds).toHaveLength(0)
  })

  it('does not enqueue a dead-air turn when a turn is already in flight', async () => {
    const { deps, rec } = makeHarness({
      nowMs: 70_000,
      lastActivityMs: 5_000,
      isResponding: true,
    })

    await processDmTriggerJob(deps, job)

    // dead-air checks isResponding before firing, so no enqueue.
    expect(rec.turnAdds).toHaveLength(0)
  })
})

// `makeDmTriggerDeps` is the wiring split out of `buildDmTriggerWorker` so the
// three forwarding closures (buildTurnBatch → the shared batch builder over the
// repo; enqueueTurn / rescheduleDebounce → the two BullMQ producers) are invoked
// directly here with recording fakes, rather than only constructed by the boot
// path. The fake queues are plain `{ add }` recorders — the producers only call
// `.add`, so no broker / bullmq mock is needed.
describe('makeDmTriggerDeps — forwarding closures', () => {
  function playerRow(seq: number, content: string): SessionMessage {
    return {
      id: `m-${String(seq)}`,
      sessionId: SESSION,
      seq,
      userId: 'u1',
      messageType: 'player_message',
      content,
      createdAt: new Date(0),
    }
  }

  function makeFakeRepo(): Repo {
    return {
      sessionMessages: {
        listAfterSeq: () => Promise.resolve([playerRow(4, 'I check the stall wares')]),
      },
      campaigns: {
        listMembersBasic: () => Promise.resolve([{ user_id: 'u1', display_name: 'Mara' }]),
      },
    } as unknown as Repo
  }

  function makeParts(): {
    parts: DmTriggerDepsParts
    turnAdds: { name: string; payload: unknown }[]
    debounceAdds: { name: string; payload: unknown; opts: unknown }[]
  } {
    const turnAdds: { name: string; payload: unknown }[] = []
    const debounceAdds: { name: string; payload: unknown; opts: unknown }[] = []
    const parts: DmTriggerDepsParts = {
      triggerState: {
        lastActivityMs: () => Promise.resolve(0),
        respondedSeq: () => Promise.resolve(0),
        isResponding: () => Promise.resolve(false),
        takeExplicitPending: () => Promise.resolve(false),
      },
      repo: {
        sessions: { getActiveByCampaign: () => Promise.resolve(null) },
        campaigns: { countAcceptedMembers: () => Promise.resolve(2) },
      },
      sessionState: { loadTurnState: () => Promise.resolve({ summary: '' }) },
      sessionTurnQueue: {
        add: (name: string, payload: unknown) => {
          turnAdds.push({ name, payload })
          return Promise.resolve({})
        },
      } as unknown as DmTriggerDepsParts['sessionTurnQueue'],
      dmTriggerQueue: {
        add: (name: string, payload: unknown, opts: unknown) => {
          debounceAdds.push({ name, payload, opts })
          return Promise.resolve({})
        },
      } as unknown as DmTriggerDepsParts['dmTriggerQueue'],
      classify: () => Promise.resolve(defaultClassification()),
      randomTurnId: () => 'turn-fixed',
      now: () => 123,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    return { parts, turnAdds, debounceAdds }
  }

  it('buildTurnBatch closure delegates to the shared builder over the repo', async () => {
    const { parts } = makeParts()
    const deps = makeDmTriggerDeps(makeFakeRepo(), parts)

    const { batch, maxSeq } = await deps.buildTurnBatch(CAMPAIGN, SESSION, 0)

    expect(batch).toEqual([{ userId: 'u1', characterName: 'Mara', text: 'I check the stall wares' }])
    expect(maxSeq).toBe(4)
  })

  it('enqueueTurn closure forwards to the session-turn producer', async () => {
    const { parts, turnAdds } = makeParts()
    const deps = makeDmTriggerDeps(makeFakeRepo(), parts)

    const payload: TurnJobPayload = {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: 'turn-fixed',
      triggerMessages: BATCH,
      maxConsumedSeq: 7,
      trigger: { kind: 'auto' },
    }
    await deps.enqueueTurn(payload)

    expect(turnAdds).toEqual([{ name: TURN_JOB_NAME, payload }])
  })

  it('rescheduleDebounce closure forwards to the dm-trigger producer', async () => {
    const { parts, debounceAdds } = makeParts()
    const deps = makeDmTriggerDeps(makeFakeRepo(), parts)

    await deps.rescheduleDebounce(CAMPAIGN, 2_000)

    expect(debounceAdds).toHaveLength(1)
    expect(debounceAdds[0]?.name).toBe(DM_TRIGGER_JOB_NAME)
    expect(debounceAdds[0]?.payload).toEqual({ campaignId: CAMPAIGN })
  })

  it('passes the scalar deps (clock, turn-id, logger) through unchanged', () => {
    const { parts } = makeParts()
    const deps = makeDmTriggerDeps(makeFakeRepo(), parts)

    expect(deps.now()).toBe(123)
    expect(deps.randomTurnId()).toBe('turn-fixed')
    expect(deps.logger).toBe(parts.logger)
    expect(deps.triggerState).toBe(parts.triggerState)
    expect(deps.sessionState).toBe(parts.sessionState)
  })
})

// Exercise `buildDmTriggerWorker` end-to-end against the mocked broker: assert it
// builds a Worker on QUEUE_DM_TRIGGER, then drive the captured processor through
// the production wiring (real `now`/`randomTurnId`/`createRepo` closures) so they
// are covered, not just constructed. The fake pool answers the four SQL reads the
// dead-air enqueue path issues; ioredis-mock backs the coordination reads (all
// unset → null/false), so a missing last-activity stamp drives the dead-air
// proactive turn that reaches the enqueue + `randomTurnId()`.
describe('buildDmTriggerWorker — boot wiring + processor closure', () => {
  // Reset captures in beforeEach (not the test body): an inline
  // `bullmqCapture.processor = null` would flow-narrow the later read to `null`,
  // then the not-null guard to `never` (the mock's reassignment is invisible to
  // TS control-flow). Resetting here keeps the read's static type the declared
  // union.
  beforeEach(() => {
    bullmqCapture.processor = null
    bullmqCapture.turnAdds = []
  })

  // SQL-discriminating fake pool — only the four reads the dead-air enqueue path
  // makes. Inert otherwise.
  function makeFakePool(): Pool {
    const query = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM sessions') && sql.includes("status = 'active'")) {
        return Promise.resolve({
          rows: [
            {
              id: SESSION,
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
      if (sql.includes('FROM session_messages') && sql.includes('seq >')) {
        return Promise.resolve({
          rows: [
            {
              id: 'm-1',
              session_id: SESSION,
              seq: 4,
              user_id: 'u1',
              message_type: 'player_message',
              content: 'I check the stall wares',
              created_at: new Date(0),
            },
          ],
        })
      }
      if (sql.includes('FROM campaign_members') && sql.includes('JOIN users')) {
        return Promise.resolve({ rows: [{ user_id: 'u1', display_name: 'Mara' }] })
      }
      // countAcceptedMembers + any other read — harmless defaults.
      return Promise.resolve({ rows: [{ n: '1' }] })
    }
    return { query } as unknown as Pool
  }

  it('builds a dm-trigger Worker and drives the captured processor through the real closures', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const worker = buildDmTriggerWorker(redis, redis, 'dt:', makeFakePool(), logger)
    expect(worker).toBeDefined()

    const processor: CapturedProcessor | null = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')
    // ioredis-mock has no last-activity stamp → lastActivity 0 → huge silence →
    // dead-air proactive turn → enqueue (reaches now() + randomTurnId()).
    await processor({ data: { campaignId: CAMPAIGN } })

    expect(bullmqCapture.turnAdds).toHaveLength(1)
    const [add] = bullmqCapture.turnAdds
    expect(add?.name).toBe(TURN_JOB_NAME)
    const payload = add?.payload as TurnJobPayload
    expect(payload.campaignId).toBe(CAMPAIGN)
    expect(payload.sessionId).toBe(SESSION)
    // randomTurnId() → a real randomUUID (not the test's fixed id).
    expect(payload.turnId).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.trigger.kind).toBe('auto')
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})
