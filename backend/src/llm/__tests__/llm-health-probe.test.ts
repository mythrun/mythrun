// llm-outage-resilience Task 7 — recovery probe cycle + §3.2 promote fast-path.
//
// Pure unit suite over injected deps (design §2.2): the tracker, the per-model
// probe, and the promote scan are all mocked, so every transition arm —
// healthy no-op, empty-set fallback, all-succeed clear, single-failure reset —
// is drivable without Redis, Postgres, or the Anthropic API. The tracker's own
// Lua semantics are covered by llm-health.test.ts (real Redis); the worker
// wiring is pinned by worker.test.ts.
//
// models.js and ai.js are module-mocked so importing the probe module never
// constructs the real Anthropic provider, and so probeModelOnce's generateText
// opts (maxRetries: 0, 30s wall clock, mythrun stage binding) are assertable.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { ResumeStamp } from '../../repo/resume-stamps.js'
import { generateText } from '../ai.js'
import {
  createArmedStampPromoter,
  parseCharacterCreationJobId,
  parseSessionPrepJobId,
  probeModelOnce,
  PROBE_FALLBACK_MODEL_IDS,
  PROBE_TIMEOUT_MS,
  runProbeCycle,
  type ArmedStampPromoterDeps,
  type ProbeCycleDeps,
  type PromotableJobLike,
} from '../llm-health-probe.js'

vi.mock('../models.js', () => ({
  HAIKU: { modelId: 'test-haiku' },
  SONNET: { modelId: 'test-sonnet' },
  OPUS: { modelId: 'test-opus' },
}))

vi.mock('../ai.js', () => ({
  generateText: vi.fn((): Promise<{ text: string }> => Promise.resolve({ text: 'ok' })),
}))

// probeModelOnce logs through the shared module logger; silence it (its
// warn arm is asserted via the generateText call count, not log lines).
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

/** Pino logger writing JSON lines into an array so tests can assert the
 *  structured probe/promote events (mirrors llm-health.test.ts). */
function makeCapturedLogger(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const logger = pino(
    { level: 'debug' },
    {
      write: (line: string): void => {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      },
    },
  )
  return { logger, lines }
}

function makeTracker(overrides?: Partial<ProbeCycleDeps['tracker']>): ProbeCycleDeps['tracker'] {
  return {
    read: vi.fn(() => Promise.resolve({ state: 'ok' as const, since: null })),
    readModels: vi.fn(() => Promise.resolve([] as readonly string[])),
    probeSuccess: vi.fn(() => Promise.resolve('counting' as const)),
    probeFailure: vi.fn(() => Promise.resolve()),
    markPromotePending: vi.fn(() => Promise.resolve()),
    clearPromotePending: vi.fn(() => Promise.resolve()),
    hasPromotePending: vi.fn(() => Promise.resolve(false)),
    ...overrides,
  }
}

function makeDeps(overrides?: {
  tracker?: Partial<ProbeCycleDeps['tracker']>
  probe?: (modelId: string) => Promise<void>
}): ProbeCycleDeps & {
  probeMock: ReturnType<typeof vi.fn>
  promoteMock: ReturnType<typeof vi.fn>
  lines: Record<string, unknown>[]
} {
  const { logger, lines } = makeCapturedLogger()
  const probeMock = vi.fn(overrides?.probe ?? ((): Promise<void> => Promise.resolve()))
  const promoteMock = vi.fn((): Promise<void> => Promise.resolve())
  return {
    tracker: makeTracker(overrides?.tracker),
    models: { probe: probeMock as (modelId: string) => Promise<void> },
    promoteArmed: promoteMock as (scope: 'all' | 'past-due') => Promise<void>,
    logger,
    probeMock,
    promoteMock,
    lines,
  }
}

function degradedRead(): ProbeCycleDeps['tracker']['read'] {
  return vi.fn(() => Promise.resolve({ state: 'degraded' as const, since: 1_000 }))
}

describe('runProbeCycle', () => {
  it('healthy: one read, zero probes, no counter traffic — and the §3.2 fire-once scan runs', async () => {
    const deps = makeDeps()

    await expect(runProbeCycle(deps)).resolves.toBe('healthy-noop')

    expect(deps.tracker.read).toHaveBeenCalledTimes(1)
    expect(deps.probeMock).not.toHaveBeenCalled()
    expect(deps.tracker.readModels).not.toHaveBeenCalled()
    expect(deps.tracker.probeSuccess).not.toHaveBeenCalled()
    expect(deps.tracker.probeFailure).not.toHaveBeenCalled()
    // With no promote-pending flag, the healthy scan is lost-job recovery
    // only — PAST-DUE stamps — so a solo-world ladder delay in progress is
    // never hot-cycled. The flag is consulted, never cleared.
    expect(deps.promoteMock).toHaveBeenCalledTimes(1)
    expect(deps.promoteMock).toHaveBeenCalledWith('past-due')
    expect(deps.tracker.hasPromotePending).toHaveBeenCalledTimes(1)
    expect(deps.tracker.clearPromotePending).not.toHaveBeenCalled()
  })

  it('healthy with promote-pending armed: re-runs the FULL scan, then drops the flag', async () => {
    const deps = makeDeps({
      tracker: { hasPromotePending: vi.fn(() => Promise.resolve(true)) },
    })

    await expect(runProbeCycle(deps)).resolves.toBe('healthy-noop')

    expect(deps.promoteMock).toHaveBeenCalledTimes(1)
    expect(deps.promoteMock).toHaveBeenCalledWith('all')
    // Cleared only AFTER the scan resolved (fire-once semantics).
    const promoteOrder = deps.promoteMock.mock.invocationCallOrder[0] ?? Infinity
    const clearOrder =
      vi.mocked(deps.tracker.clearPromotePending).mock.invocationCallOrder[0] ?? -Infinity
    expect(clearOrder).toBeGreaterThan(promoteOrder)
    expect(deps.probeMock).not.toHaveBeenCalled()
  })

  it('healthy with promote-pending armed: a failing scan keeps the flag for the next cycle', async () => {
    const deps = makeDeps({
      tracker: { hasPromotePending: vi.fn(() => Promise.resolve(true)) },
    })
    deps.promoteMock.mockRejectedValueOnce(new Error('pg down'))

    await expect(runProbeCycle(deps)).rejects.toThrow('pg down')

    expect(deps.tracker.clearPromotePending).not.toHaveBeenCalled()
  })

  it('degraded: probes exactly the implicated models SET', async () => {
    const deps = makeDeps({
      tracker: {
        read: degradedRead(),
        readModels: vi.fn(() => Promise.resolve(['model-a', 'model-b'] as readonly string[])),
      },
    })

    await expect(runProbeCycle(deps)).resolves.toBe('still-degraded')

    expect(deps.probeMock).toHaveBeenCalledTimes(2)
    expect(deps.probeMock).toHaveBeenCalledWith('model-a')
    expect(deps.probeMock).toHaveBeenCalledWith('model-b')
    expect(deps.tracker.probeSuccess).toHaveBeenCalledTimes(1)
    expect(deps.tracker.probeFailure).not.toHaveBeenCalled()
    // Counting toward 3 is not a clear: no promote scan while still degraded.
    expect(deps.promoteMock).not.toHaveBeenCalled()
  })

  it('degraded + empty models SET: falls back to all three tier ids — never a vacuous success', async () => {
    const deps = makeDeps({ tracker: { read: degradedRead() } })

    await runProbeCycle(deps)

    expect(deps.probeMock).toHaveBeenCalledTimes(3)
    for (const id of PROBE_FALLBACK_MODEL_IDS) {
      expect(deps.probeMock).toHaveBeenCalledWith(id)
    }
    // The mocked tier constants from the models.js mock, in tier order.
    expect(PROBE_FALLBACK_MODEL_IDS).toEqual(['test-haiku', 'test-sonnet', 'test-opus'])
  })

  it('degraded: probes run in parallel (all dispatched before any settles)', async () => {
    let started = 0
    const resolvers: (() => void)[] = []
    const deps = makeDeps({
      tracker: {
        read: degradedRead(),
        readModels: vi.fn(() => Promise.resolve(['model-a', 'model-b'] as readonly string[])),
      },
      probe: () =>
        new Promise<void>((resolve) => {
          started += 1
          resolvers.push(resolve)
        }),
    })

    const cycle = runProbeCycle(deps)
    // Both probes must be in flight before either resolves — the cycle-under-
    // interval single-flight invariant (§2.2) depends on parallel dispatch.
    await vi.waitFor(() => {
      expect(started).toBe(2)
    })
    for (const resolve of resolvers) resolve()
    await expect(cycle).resolves.toBe('still-degraded')
  })

  it('all targets succeed and the counter clears: returns cleared + runs the promote scan', async () => {
    const deps = makeDeps({
      tracker: {
        read: degradedRead(),
        readModels: vi.fn(() => Promise.resolve(['model-a'] as readonly string[])),
        probeSuccess: vi.fn(() => Promise.resolve('cleared' as const)),
      },
    })

    await expect(runProbeCycle(deps)).resolves.toBe('cleared')

    expect(deps.tracker.probeSuccess).toHaveBeenCalledTimes(1)
    // The clearing cycle wakes EVERY armed stamp — the immediate post-recovery
    // wake is intended (each consumes its scheduled rung once).
    expect(deps.promoteMock).toHaveBeenCalledTimes(1)
    expect(deps.promoteMock).toHaveBeenCalledWith('all')
    // Fire-once net ordering: armed BEFORE the scan (a death mid-scan leaves
    // it up), dropped only AFTER the scan resolved.
    const markOrder =
      vi.mocked(deps.tracker.markPromotePending).mock.invocationCallOrder[0] ?? Infinity
    const promoteOrder = deps.promoteMock.mock.invocationCallOrder[0] ?? -Infinity
    const clearOrder =
      vi.mocked(deps.tracker.clearPromotePending).mock.invocationCallOrder[0] ?? -Infinity
    expect(markOrder).toBeLessThan(promoteOrder)
    expect(clearOrder).toBeGreaterThan(promoteOrder)
  })

  it('clearing cycle: a failing scan keeps promote-pending armed (the death-window net)', async () => {
    const deps = makeDeps({
      tracker: {
        read: degradedRead(),
        readModels: vi.fn(() => Promise.resolve(['model-a'] as readonly string[])),
        probeSuccess: vi.fn(() => Promise.resolve('cleared' as const)),
      },
    })
    deps.promoteMock.mockRejectedValueOnce(new Error('pg down'))

    await expect(runProbeCycle(deps)).rejects.toThrow('pg down')

    expect(deps.tracker.markPromotePending).toHaveBeenCalledTimes(1)
    expect(deps.tracker.clearPromotePending).not.toHaveBeenCalled()
  })

  it('any probe failure resets the counter and skips probeSuccess', async () => {
    const deps = makeDeps({
      tracker: {
        read: degradedRead(),
        readModels: vi.fn(
          () => Promise.resolve(['model-ok', 'model-down'] as readonly string[]),
        ),
      },
      probe: (modelId) =>
        modelId === 'model-down'
          ? Promise.reject(new Error('ECONNREFUSED'))
          : Promise.resolve(),
    })

    await expect(runProbeCycle(deps)).resolves.toBe('still-degraded')

    expect(deps.tracker.probeFailure).toHaveBeenCalledTimes(1)
    expect(deps.tracker.probeSuccess).not.toHaveBeenCalled()
    expect(deps.promoteMock).not.toHaveBeenCalled()
    const failedLine = deps.lines.find((l) => l['event'] === 'llm_health.probe_cycle_failed')
    // Per-model rejection reasons ride the line via the secret-free
    // describeErrorForLog descriptor (name/code/terminal/message only).
    expect(failedLine).toMatchObject({
      failedModels: ['model-down'],
      failures: [
        {
          modelId: 'model-down',
          err: { name: 'Error', code: null, terminal: false, message: 'ECONNREFUSED' },
        },
      ],
    })
  })
})

function stamp(
  pipeline: ResumeStamp['pipeline'],
  entityId: string,
  // Past due by default so the matching-mechanics tests hold under either scope.
  nextResumeAt: Date | null = new Date(Date.now() - 1_000),
): ResumeStamp {
  return {
    pipeline,
    entityId,
    resumeAttempt: 1,
    nextResumeAt,
    parkConsumedMs: 30_000,
    lastErrorClass: 'connectivity',
  }
}

function fakeJob(id: string | undefined): PromotableJobLike & { promote: ReturnType<typeof vi.fn> } {
  return { id, promote: vi.fn(() => Promise.resolve()) }
}

function makePromoterDeps(args: {
  stamps: readonly ResumeStamp[]
  worldGenDelayed?: PromotableJobLike[]
  sessionPrepDelayed?: PromotableJobLike[]
  characterCreationDelayed?: PromotableJobLike[]
  concept?: { id: string } | null
}): ArmedStampPromoterDeps & {
  getDelayedMocks: Record<'worldGen' | 'sessionPrep' | 'characterCreation', ReturnType<typeof vi.fn>>
  conceptLookup: ReturnType<typeof vi.fn>
  lines: Record<string, unknown>[]
} {
  const { logger, lines } = makeCapturedLogger()
  const getDelayedMocks = {
    worldGen: vi.fn(() => Promise.resolve(args.worldGenDelayed ?? [])),
    sessionPrep: vi.fn(() => Promise.resolve(args.sessionPrepDelayed ?? [])),
    characterCreation: vi.fn(() => Promise.resolve(args.characterCreationDelayed ?? [])),
  }
  const conceptLookup = vi.fn(() => Promise.resolve(args.concept ?? null))
  return {
    stamps: { listArmed: vi.fn(() => Promise.resolve(args.stamps)) },
    concepts: {
      getByCampaignAndUser: conceptLookup as (
        campaignId: string,
        userId: string,
      ) => Promise<{ readonly id: string } | null>,
    },
    queues: {
      worldGen: { getDelayed: getDelayedMocks.worldGen },
      sessionPrep: { getDelayed: getDelayedMocks.sessionPrep },
      characterCreation: { getDelayed: getDelayedMocks.characterCreation },
    },
    logger,
    getDelayedMocks,
    conceptLookup,
    lines,
  }
}

describe('createArmedStampPromoter', () => {
  it('no armed stamps: one listArmed, zero queue traffic', async () => {
    const deps = makePromoterDeps({ stamps: [] })

    await createArmedStampPromoter(deps)('all')

    expect(deps.stamps.listArmed).toHaveBeenCalledTimes(1)
    expect(deps.getDelayedMocks.worldGen).not.toHaveBeenCalled()
    expect(deps.getDelayedMocks.sessionPrep).not.toHaveBeenCalled()
    expect(deps.getDelayedMocks.characterCreation).not.toHaveBeenCalled()
  })

  it('world_gen: promotes the delayed job whose jobId IS the stamp entityId, leaves others parked', async () => {
    const campaignId = randomUUID()
    const parked = fakeJob(campaignId)
    const unrelated = fakeJob(randomUUID())
    const deps = makePromoterDeps({
      stamps: [stamp('world_gen', campaignId)],
      worldGenDelayed: [parked, unrelated],
    })

    await createArmedStampPromoter(deps)('all')

    expect(parked.promote).toHaveBeenCalledTimes(1)
    expect(unrelated.promote).not.toHaveBeenCalled()
    // Only the pipeline with an armed stamp is scanned.
    expect(deps.getDelayedMocks.sessionPrep).not.toHaveBeenCalled()
    expect(deps.getDelayedMocks.characterCreation).not.toHaveBeenCalled()
    expect(
      deps.lines.find((l) => l['event'] === 'llm_health.resume_promoted'),
    ).toMatchObject({ pipeline: 'world_gen', jobId: campaignId })
  })

  it('session_prep: matches sp-<campaignId>-<n> by fixed-width parse against the stamp campaignId', async () => {
    const campaignId = randomUUID()
    const parked = fakeJob(`sp-${campaignId}-3`)
    const otherCampaign = fakeJob(`sp-${randomUUID()}-3`)
    const malformed = fakeJob(`sp-${campaignId.slice(0, 20)}-3`)
    const deps = makePromoterDeps({
      stamps: [stamp('session_prep', campaignId)],
      sessionPrepDelayed: [parked, otherCampaign, malformed],
    })

    await createArmedStampPromoter(deps)('all')

    expect(parked.promote).toHaveBeenCalledTimes(1)
    expect(otherCampaign.promote).not.toHaveBeenCalled()
    expect(malformed.promote).not.toHaveBeenCalled()
  })

  it('character_creation: parses cc-<campaignId>-<userId>, resolves the concept, matches its id', async () => {
    const campaignId = randomUUID()
    const userId = randomUUID()
    const conceptId = randomUUID()
    const parked = fakeJob(`cc-${campaignId}-${userId}`)
    const malformed = fakeJob(`cc-${campaignId}`)
    const deps = makePromoterDeps({
      stamps: [stamp('character_creation', conceptId)],
      characterCreationDelayed: [parked, malformed],
      concept: { id: conceptId },
    })

    await createArmedStampPromoter(deps)('all')

    expect(deps.conceptLookup).toHaveBeenCalledWith(campaignId, userId)
    // The malformed id never reaches the concept lookup, let alone promote.
    expect(deps.conceptLookup).toHaveBeenCalledTimes(1)
    expect(parked.promote).toHaveBeenCalledTimes(1)
    expect(malformed.promote).not.toHaveBeenCalled()
  })

  it('character_creation: a concept miss or id mismatch leaves the job parked', async () => {
    const conceptId = randomUUID()
    const missJob = fakeJob(`cc-${randomUUID()}-${randomUUID()}`)
    const missDeps = makePromoterDeps({
      stamps: [stamp('character_creation', conceptId)],
      characterCreationDelayed: [missJob],
      concept: null,
    })
    await createArmedStampPromoter(missDeps)('all')
    expect(missJob.promote).not.toHaveBeenCalled()

    const mismatchJob = fakeJob(`cc-${randomUUID()}-${randomUUID()}`)
    const mismatchDeps = makePromoterDeps({
      stamps: [stamp('character_creation', conceptId)],
      characterCreationDelayed: [mismatchJob],
      concept: { id: randomUUID() },
    })
    await createArmedStampPromoter(mismatchDeps)('all')
    expect(mismatchJob.promote).not.toHaveBeenCalled()
  })

  it('catch-and-continue per job: a promote race on one job does not stop the scan (§3.2)', async () => {
    const idA = randomUUID()
    const idB = randomUUID()
    const racing = fakeJob(idA)
    racing.promote.mockRejectedValue(new Error('Job is not in the delayed state'))
    const second = fakeJob(idB)
    const deps = makePromoterDeps({
      stamps: [stamp('world_gen', idA), stamp('world_gen', idB)],
      worldGenDelayed: [racing, second],
    })

    await createArmedStampPromoter(deps)('all')

    expect(second.promote).toHaveBeenCalledTimes(1)
    expect(
      deps.lines.find((l) => l['event'] === 'llm_health.resume_promote_failed'),
    ).toMatchObject({ pipeline: 'world_gen', jobId: idA })
  })

  it('catch-and-continue per job: a concept-lookup failure skips that job only', async () => {
    const conceptId = randomUUID()
    const failing = fakeJob(`cc-${randomUUID()}-${randomUUID()}`)
    const campaignId = randomUUID()
    const userId = randomUUID()
    const matching = fakeJob(`cc-${campaignId}-${userId}`)
    const deps = makePromoterDeps({
      stamps: [stamp('character_creation', conceptId)],
      characterCreationDelayed: [failing, matching],
    })
    deps.conceptLookup
      .mockRejectedValueOnce(new Error('pg down'))
      .mockResolvedValueOnce({ id: conceptId })

    await createArmedStampPromoter(deps)('all')

    expect(failing.promote).not.toHaveBeenCalled()
    expect(matching.promote).toHaveBeenCalledTimes(1)
  })

  it('a getDelayed failure on one queue does not stop the other pipelines', async () => {
    const worldCampaignId = randomUUID()
    const spCampaignId = randomUUID()
    const spJob = fakeJob(`sp-${spCampaignId}-1`)
    const deps = makePromoterDeps({
      stamps: [stamp('world_gen', worldCampaignId), stamp('session_prep', spCampaignId)],
      sessionPrepDelayed: [spJob],
    })
    deps.getDelayedMocks.worldGen.mockRejectedValue(new Error('redis blip'))

    await createArmedStampPromoter(deps)('all')

    expect(spJob.promote).toHaveBeenCalledTimes(1)
    expect(
      deps.lines.find((l) => l['event'] === 'llm_health.resume_scan_failed'),
    ).toMatchObject({ pipeline: 'world_gen' })
  })

  it("scope 'past-due' (healthy cycle): promotes only overdue stamps — an in-progress ladder delay stays parked", async () => {
    const overdueCampaign = randomUUID()
    const futureCampaign = randomUUID()
    const overdueJob = fakeJob(overdueCampaign)
    const futureJob = fakeJob(futureCampaign)
    const deps = makePromoterDeps({
      stamps: [
        stamp('world_gen', overdueCampaign, new Date(Date.now() - 5_000)),
        // A solo-world park riding its §3.1 ladder while the site is healthy:
        // hot-cycling it every 60s would bypass the ladder and burn the park
        // budget at scheduled-rung rate (the spec amendment this pins).
        stamp('world_gen', futureCampaign, new Date(Date.now() + 60_000)),
        // Defensive: listArmed never returns a disarmed stamp, but a null
        // nextResumeAt must read as "not past due", never as eligible.
        stamp('session_prep', randomUUID(), null),
      ],
      worldGenDelayed: [overdueJob, futureJob],
    })

    await createArmedStampPromoter(deps)('past-due')

    expect(overdueJob.promote).toHaveBeenCalledTimes(1)
    expect(futureJob.promote).not.toHaveBeenCalled()
    // No eligible session_prep stamps → that queue is not scanned at all.
    expect(deps.getDelayedMocks.sessionPrep).not.toHaveBeenCalled()
  })

  it("scope 'all' (clearing cycle): promotes a future-dated stamp — the post-recovery wake is immediate", async () => {
    const campaignId = randomUUID()
    const futureJob = fakeJob(campaignId)
    const deps = makePromoterDeps({
      stamps: [stamp('world_gen', campaignId, new Date(Date.now() + 60_000))],
      worldGenDelayed: [futureJob],
    })

    await createArmedStampPromoter(deps)('all')

    expect(futureJob.promote).toHaveBeenCalledTimes(1)
  })

  it('a job with no id is skipped', async () => {
    const job = fakeJob(undefined)
    const deps = makePromoterDeps({
      stamps: [stamp('world_gen', randomUUID())],
      worldGenDelayed: [job],
    })
    await createArmedStampPromoter(deps)('all')
    expect(job.promote).not.toHaveBeenCalled()
  })
})

describe('jobId parsers (fixed UUID widths — ids embed hyphens, never split)', () => {
  it('parses sp-<uuid>-<n>', () => {
    const campaignId = randomUUID()
    expect(parseSessionPrepJobId(`sp-${campaignId}-12`)).toEqual({
      campaignId,
      sessionNumber: 12,
    })
  })

  it('rejects malformed session-prep ids', () => {
    const campaignId = randomUUID()
    expect(parseSessionPrepJobId(`cc-${campaignId}-1`)).toBeNull()
    expect(parseSessionPrepJobId(`sp-${campaignId}`)).toBeNull()
    expect(parseSessionPrepJobId(`sp-${campaignId}-`)).toBeNull()
    expect(parseSessionPrepJobId(`sp-${campaignId}-x`)).toBeNull()
    expect(parseSessionPrepJobId(`sp-short-1`)).toBeNull()
  })

  it('parses cc-<uuid>-<uuid>', () => {
    const campaignId = randomUUID()
    const userId = randomUUID()
    expect(parseCharacterCreationJobId(`cc-${campaignId}-${userId}`)).toEqual({
      campaignId,
      userId,
    })
  })

  it('rejects malformed character-creation ids', () => {
    const campaignId = randomUUID()
    const userId = randomUUID()
    expect(parseCharacterCreationJobId(`sp-${campaignId}-${userId}`)).toBeNull()
    expect(parseCharacterCreationJobId(`cc-${campaignId}`)).toBeNull()
    expect(parseCharacterCreationJobId(`cc-${campaignId}-${userId}-extra`)).toBeNull()
    expect(parseCharacterCreationJobId(`cc-${campaignId}x${userId}`)).toBeNull()
  })
})

describe('probeModelOnce', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockClear()
  })

  it('probes single-attempt, 30s wall clock, thinking suppressed, health report skipped', async () => {
    await probeModelOnce('test-sonnet')

    expect(generateText).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(generateText).mock.calls[0]?.[0]
    expect(opts).toMatchObject({
      model: { modelId: 'test-sonnet' },
      maxRetries: 0,
      timeoutMs: PROBE_TIMEOUT_MS,
      callSite: 'llm-health-probe',
      // A probe failure must feed probeFailure() only — reported into the
      // arming window it would supply the callsite diversity for a spurious
      // sitewide outage.
      skipHealthReport: true,
      providerOptions: {
        // Adaptive thinking overrunning the 30s wall clock would fail-close
        // the strip against a healthy API.
        anthropic: { thinking: { type: 'disabled' } },
        mythrun: { stage: 'llm-health-probe' },
      },
    })
    expect(typeof opts?.prompt).toBe('string')
  })

  it('resolves each tier id in the fallback list', async () => {
    for (const id of PROBE_FALLBACK_MODEL_IDS) {
      await probeModelOnce(id)
    }
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('an unknown model id soft-succeeds without an API call (stale SET id after a tier bump)', async () => {
    await expect(probeModelOnce('claude-decommissioned-1')).resolves.toBeUndefined()
    expect(generateText).not.toHaveBeenCalled()
  })

  it('a probe failure propagates to the caller (the cycle counts it via probeFailure)', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('UND_ERR_CONNECT_TIMEOUT'))
    await expect(probeModelOnce('test-opus')).rejects.toThrow('UND_ERR_CONNECT_TIMEOUT')
  })
})
