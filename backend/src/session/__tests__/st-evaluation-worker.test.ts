// MYT-69 Task 10 — the SlowThinker pipeline worker (`st-evaluation-worker.ts`).
//
// `processStEvalJob(deps, job)` is the ORDERED background shell that runs when
// the st-evaluation debounce job matures: active-session check → deterministic
// policy (floor / wind-down) → Haiku gate → Opus evaluation → guarded writes →
// self-re-arm. Every dependency is injected as a struct param, so the whole
// decision tree is unit-testable WITHOUT a broker, Redis, DB, or LLM — each
// case passes plain recording/stub fakes and asserts the observable side
// effects (which slot was written, whether the gate/director ran, whether the
// debounce was re-armed, what usage was accumulated).
//
// The `buildStEvaluationWorker` boot wiring is exercised in the sibling file
// (st-evaluation-worker-boot.test.ts), which owns the bullmq module mock.
//
// GATE INDEPENDENCE (§8.2): the gate's verdict/reason NEVER reaches the
// director's input — structurally enforced by StDirectorInput having no gate
// field, and pinned by a capture assertion (case 8).

import type { LanguageModelUsage } from '../../llm/ai.js'
import type { StGateOutput } from '../../llm/st-gate.js'
import type { StDirectorInput, StDirectorOutput } from '../../llm/st-director.js'
import type { StDirectorResult } from '../../llm/schemas/st-director.js'
import type { SessionMessage } from '../../repo/types.js'
import { describe, expect, it, vi } from 'vitest'
import {
  ST_EVAL_FLOOR_TURNS,
  SESSION_TOKEN_BUDGET,
  WIND_DOWN_FRACTION,
} from '../st-config.js'
import type { StEvalPayload } from '../st-eval-queue.js'
import { processStEvalJob, type StEvalProcessorDeps } from '../st-evaluation-worker.js'

const CAMPAIGN = 'c-st-1'
const SESSION = 's-st-1'

function usage(total: number): LanguageModelUsage {
  return {
    inputTokens: total,
    outputTokens: 0,
    totalTokens: total,
    inputTokenDetails: { noCacheTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 },
  } as unknown as LanguageModelUsage
}

/** A usage blob WITHOUT totalTokens — exercises usageTokens' input+output
 *  fallback arm (case 16). */
function partialUsage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 },
  } as unknown as LanguageModelUsage
}

function defaultDirectorResult(overrides: Partial<StDirectorResult> = {}): StDirectorResult {
  return {
    reasoning: 'the party is at a decision point',
    intervene: true,
    direction: 'D',
    standingDirective: { action: 'set', text: 'S' },
    summaryUpdate: 'updated running summary',
    ...overrides,
  }
}

/** Recording fakes + knobs. Defaults: an active matching session, policy NOT
 *  tripped (turnsSinceSt low, usage well under wind-down), gate fires
 *  (needed:true), director returns a full intervene+set result, watermark
 *  unchanged (no re-arm). Each test overrides only the fields it cares about. */
interface Knobs {
  session: { id: string; sessionNumber: number } | null
  turnsSinceSt: number
  totalUsed: number
  startWatermark: number
  endWatermark: number
  standing: string | null
  pending: string | null
  gate: StGateOutput
  gateThrows: boolean
  director: StDirectorOutput
  directorThrows: boolean
}

interface Recorders {
  setOneShot: string[]
  setStanding: string[]
  clearStandingCalls: number
  setSummary: string[]
  incrUsage: number[]
  resetTurnsCalls: number
  reArmCalls: { campaignId: string; sessionId: string }[]
  gateCalls: number
  directorInputs: StDirectorInput[]
}

function makeHarness(overrides: Partial<Knobs> = {}): {
  deps: StEvalProcessorDeps
  rec: Recorders
  knobs: Knobs
} {
  const knobs: Knobs = {
    session: { id: SESSION, sessionNumber: 1 },
    turnsSinceSt: 1,
    totalUsed: 1_000,
    startWatermark: 5,
    endWatermark: 5,
    standing: null,
    pending: null,
    gate: { result: { needed: true, confidence: 0.5, reason: 'tension rising' }, usage: usage(10) },
    gateThrows: false,
    director: {
      result: defaultDirectorResult(),
      usage: usage(100),
      repairAttempted: false,
    },
    directorThrows: false,
    ...overrides,
  }

  const rec: Recorders = {
    setOneShot: [],
    setStanding: [],
    clearStandingCalls: 0,
    setSummary: [],
    incrUsage: [],
    resetTurnsCalls: 0,
    reArmCalls: [],
    gateCalls: 0,
    directorInputs: [],
  }

  // respondedSeq is asked twice: at start (snapshot) then at end (re-arm check).
  let respondedCalls = 0

  const deps: StEvalProcessorDeps = {
    repo: {
      sessions: { getActiveByCampaign: () => Promise.resolve(knobs.session) },
      sessionPreps: { getBy: () => Promise.resolve({ sdPlaybook: 'PLAYBOOK SECRETS' }) },
      sessionMessages: {
        listFtContextRows: (): Promise<SessionMessage[]> => Promise.resolve([]),
      },
      characters: {
        listSessionParticipantRoster: () =>
          Promise.resolve([{ name: 'Mara', characterClass: 'rogue', background: 'criminal' }]),
        listSessionParticipantCharacters: () =>
          Promise.resolve([{ userId: 'u1', name: 'Mara' }]),
      },
    },
    sessionState: {
      loadTurnState: () => Promise.resolve({ summary: 'running summary' }),
      setRunningSummary: (_c, s) => {
        rec.setSummary.push(s)
        return Promise.resolve()
      },
      totalUsageTokens: () => Promise.resolve(knobs.totalUsed),
      incrUsageSt: (_c, t) => {
        rec.incrUsage.push(t)
        return Promise.resolve()
      },
    },
    triggerState: {
      setOneShotDirection: (_c, text) => {
        rec.setOneShot.push(text)
        return Promise.resolve()
      },
      setStandingDirection: (_c, text) => {
        rec.setStanding.push(text)
        return Promise.resolve()
      },
      clearStandingDirection: () => {
        rec.clearStandingCalls += 1
        return Promise.resolve()
      },
      readStandingDirection: () => Promise.resolve(knobs.standing),
      peekOneShotDirection: () => Promise.resolve(knobs.pending),
      turnsSinceSt: () => Promise.resolve(knobs.turnsSinceSt),
      resetTurnsSinceSt: () => {
        rec.resetTurnsCalls += 1
        return Promise.resolve()
      },
      respondedSeq: () => {
        respondedCalls += 1
        return Promise.resolve(respondedCalls === 1 ? knobs.startWatermark : knobs.endWatermark)
      },
    },
    runGate: () => {
      rec.gateCalls += 1
      if (knobs.gateThrows) return Promise.reject(new Error('gate boom'))
      return Promise.resolve(knobs.gate)
    },
    runDirector: (input: StDirectorInput) => {
      rec.directorInputs.push(input)
      if (knobs.directorThrows) return Promise.reject(new Error('director boom'))
      return Promise.resolve(knobs.director)
    },
    reArm: (campaignId, sessionId) => {
      rec.reArmCalls.push({ campaignId, sessionId })
      return Promise.resolve()
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }

  return { deps, rec, knobs }
}

const job = { data: { campaignId: CAMPAIGN, sessionId: SESSION } satisfies StEvalPayload }

describe('processStEvalJob — active-session gate (§ pipeline step 1)', () => {
  it('case 1: no active session → no gate, no director, no writes, no re-arm', async () => {
    const { deps, rec } = makeHarness({ session: null })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(0)
    expect(rec.directorInputs).toHaveLength(0)
    expect(rec.setOneShot).toHaveLength(0)
    expect(rec.setSummary).toHaveLength(0)
    expect(rec.incrUsage).toHaveLength(0)
    expect(rec.reArmCalls).toHaveLength(0)
  })

  it('case 2: active session id ≠ payload sessionId → no-op', async () => {
    const { deps, rec } = makeHarness({ session: { id: 'other-session', sessionNumber: 1 } })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(0)
    expect(rec.directorInputs).toHaveLength(0)
    expect(rec.reArmCalls).toHaveLength(0)
  })
})

describe('processStEvalJob — deterministic policy (§ step 2)', () => {
  it('case 3: turnsSinceSt ≥ floor → gate SKIPPED, director runs, turns reset', async () => {
    const { deps, rec } = makeHarness({ turnsSinceSt: ST_EVAL_FLOOR_TURNS })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(0)
    expect(rec.directorInputs).toHaveLength(1)
    expect(rec.resetTurnsCalls).toBe(1)
  })

  it('case 4: usage ≥ wind-down fraction → director called with windDown:true', async () => {
    const overBudget = Math.ceil(WIND_DOWN_FRACTION * SESSION_TOKEN_BUDGET)
    const { deps, rec } = makeHarness({ turnsSinceSt: 1, totalUsed: overBudget })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(0)
    expect(rec.directorInputs).toHaveLength(1)
    expect(rec.directorInputs[0]?.windDown).toBe(true)
  })
})

describe('processStEvalJob — the Haiku gate (§ step 3)', () => {
  it('case 5: gate confident-no → director NOT called; no writes; gate usage still INCRBYd', async () => {
    const { deps, rec } = makeHarness({
      gate: { result: { needed: false, confidence: 0.9, reason: 'quiet' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    expect(rec.gateCalls).toBe(1)
    expect(rec.directorInputs).toHaveLength(0)
    expect(rec.setOneShot).toHaveLength(0)
    expect(rec.setSummary).toHaveLength(0)
    expect(rec.incrUsage).toEqual([10])
  })

  it('case 6: gate needed:true → director called', async () => {
    const { deps, rec } = makeHarness({
      gate: { result: { needed: true, confidence: 0.5, reason: 'fire' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    expect(rec.directorInputs).toHaveLength(1)
  })

  it('case 7: gate needed:false but confidence below floor → director called (fail-toward-oversight)', async () => {
    const { deps, rec } = makeHarness({
      gate: { result: { needed: false, confidence: 0.5, reason: 'unsure' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    expect(rec.directorInputs).toHaveLength(1)
  })

  it('case 8: GATE INDEPENDENCE — the director input carries no gate verdict/reason', async () => {
    const { deps, rec } = makeHarness({
      gate: { result: { needed: true, confidence: 0.42, reason: 'GATE_REASON' }, usage: usage(10) },
    })
    await processStEvalJob(deps, job)
    const input = rec.directorInputs[0]
    expect(input).toBeDefined()
    const keys = Object.keys(input ?? {})
    expect(keys).not.toContain('needed')
    expect(keys).not.toContain('confidence')
    expect(keys).not.toContain('reason')
    expect(keys).not.toContain('gate')
    expect(JSON.stringify(input)).not.toContain('GATE_REASON')
  })

  it('case 9: gate throws → caught, cycle skipped (no director, no throw out)', async () => {
    const { deps, rec } = makeHarness({ gateThrows: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.directorInputs).toHaveLength(0)
    // The gate accumulated no usage before throwing → no INCRBY.
    expect(rec.incrUsage).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})

describe('processStEvalJob — write phase (§ steps 4-5)', () => {
  it('case 10: intervene+set → one-shot, standing, summary, usage, turns-reset all written', async () => {
    const { deps, rec } = makeHarness({
      director: {
        result: defaultDirectorResult({
          intervene: true,
          direction: 'D',
          standingDirective: { action: 'set', text: 'S' },
          summaryUpdate: 'NEW SUMMARY',
        }),
        usage: usage(100),
        repairAttempted: false,
      },
    })
    await processStEvalJob(deps, job)
    expect(rec.setOneShot).toEqual(['D'])
    expect(rec.setStanding).toEqual(['S'])
    expect(rec.setSummary).toEqual(['NEW SUMMARY'])
    // gate(10) + director(100) accumulated into one INCRBY.
    expect(rec.incrUsage).toEqual([110])
    expect(rec.resetTurnsCalls).toBe(1)
  })

  it('case 11a: standing clear → clearStandingDirection called, set NOT called', async () => {
    const { deps, rec } = makeHarness({
      director: {
        result: defaultDirectorResult({
          intervene: false,
          direction: null,
          standingDirective: { action: 'clear', text: null },
        }),
        usage: usage(100),
        repairAttempted: false,
      },
    })
    await processStEvalJob(deps, job)
    expect(rec.clearStandingCalls).toBe(1)
    expect(rec.setStanding).toHaveLength(0)
    // intervene:false / direction:null → no one-shot write.
    expect(rec.setOneShot).toHaveLength(0)
  })

  it('case 11b: standing keep → neither set nor clear called', async () => {
    const { deps, rec } = makeHarness({
      director: {
        result: defaultDirectorResult({
          intervene: false,
          direction: null,
          standingDirective: { action: 'keep', text: null },
        }),
        usage: usage(100),
        repairAttempted: false,
      },
    })
    await processStEvalJob(deps, job)
    expect(rec.clearStandingCalls).toBe(0)
    expect(rec.setStanding).toHaveLength(0)
  })

  it('case 12: repairAttempted → NO direction/standing/summary write, BUT usage INCRBYd + turns reset', async () => {
    const { deps, rec } = makeHarness({
      director: {
        result: defaultDirectorResult({ intervene: true, direction: 'D' }),
        usage: usage(100),
        repairAttempted: true,
      },
    })
    await processStEvalJob(deps, job)
    expect(rec.setOneShot).toHaveLength(0)
    expect(rec.setStanding).toHaveLength(0)
    expect(rec.setSummary).toHaveLength(0)
    expect(rec.incrUsage).toEqual([110])
    expect(rec.resetTurnsCalls).toBe(1)
  })
})

describe('processStEvalJob — self-re-arm + failure isolation (§ step 6)', () => {
  it('case 13a: watermark advanced → re-arm called (removeDeduplicationKey + re-add)', async () => {
    const { deps, rec } = makeHarness({ startWatermark: 5, endWatermark: 8 })
    await processStEvalJob(deps, job)
    expect(rec.reArmCalls).toEqual([{ campaignId: CAMPAIGN, sessionId: SESSION }])
  })

  it('case 13b: watermark unchanged → no re-arm', async () => {
    const { deps, rec } = makeHarness({ startWatermark: 5, endWatermark: 5 })
    await processStEvalJob(deps, job)
    expect(rec.reArmCalls).toHaveLength(0)
  })

  it('case 14: active-session no-op path does NOT re-arm', async () => {
    const { deps, rec } = makeHarness({ session: null, startWatermark: 5, endWatermark: 8 })
    await processStEvalJob(deps, job)
    expect(rec.reArmCalls).toHaveLength(0)
  })

  it('case 15: director throws → caught, no writes, gate usage still accounted, no throw out', async () => {
    const { deps, rec } = makeHarness({ directorThrows: true })
    await expect(processStEvalJob(deps, job)).resolves.toBeUndefined()
    expect(rec.setOneShot).toHaveLength(0)
    expect(rec.setSummary).toHaveLength(0)
    // only the gate usage was accumulated before the director threw.
    expect(rec.incrUsage).toEqual([10])
  })

  it('case 16: usage without totalTokens → input+output fallback summed into the INCRBY', async () => {
    const { deps, rec } = makeHarness({
      gate: {
        result: { needed: true, confidence: 0.5, reason: 'fire' },
        usage: partialUsage(7, 3),
      },
      director: {
        result: defaultDirectorResult(),
        usage: partialUsage(60, 40),
        repairAttempted: false,
      },
    })
    await processStEvalJob(deps, job)
    // gate (7+3) + director (60+40) — both through the fallback arm.
    expect(rec.incrUsage).toEqual([110])
  })
})
