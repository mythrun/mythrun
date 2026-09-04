// MYT-69 Task 10 — shared `processStEvalJob` test harness.
//
// The recording/stub fakes + knobs that drive the SlowThinker pipeline worker
// unit tests, extracted so the main suite (st-evaluation-worker.test.ts) and the
// failure-arm suite (st-evaluation-worker-arms.test.ts) share ONE harness rather
// than duplicating ~200 lines — and each test file stays under the 400-line cap.

import type { LanguageModelUsage } from '../../llm/ai.js'
import type { StGateOutput } from '../../llm/st-gate.js'
import type { StDirectorInput, StDirectorOutput } from '../../llm/st-director.js'
import type {
  StNarrativeProgressInput,
  StNarrativeProgressOutput,
} from '../../llm/st-narrative-progress.js'
import type { StDirectorResult } from '../../llm/schemas/st-director.js'
import type { SessionMessage } from '../../repo/types.js'
import { vi } from 'vitest'
import type { StEvalPayload } from '../st-eval-queue.js'
import type { StEvalProcessorDeps } from '../st-evaluation-worker.js'

export const CAMPAIGN = 'c-st-1'
export const SESSION = 's-st-1'

export function usage(total: number): LanguageModelUsage {
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
export function partialUsage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 0 },
  } as unknown as LanguageModelUsage
}

/** A usage blob with NEITHER totalTokens NOR input/output tokens — exercises
 *  usageTokens' `(inputTokens ?? 0) + (outputTokens ?? 0)` nullish arms (both
 *  fall to 0 → the blob contributes nothing). */
export function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  } as unknown as LanguageModelUsage
}

export function defaultDirectorResult(overrides: Partial<StDirectorResult> = {}): StDirectorResult {
  return {
    reasoning: 'the party is at a decision point',
    intervene: true,
    direction: 'D',
    standingDirective: { action: 'set', text: 'S' },
    summaryUpdate: 'updated running summary',
    ...overrides,
  }
}

/** myth-3jna1 — a narrative-progress probe result. `basis` defaults to
 *  innocuous prose; the leak matrix overrides it with the secret verbatim to
 *  prove code never forwards it. */
export function progress(
  value: number,
  tokens = 40,
  basis = 'the opening goal landed; the reveal has not',
): StNarrativeProgressOutput {
  return { result: { basis, progress: value }, usage: usage(tokens) }
}

/** Recording fakes + knobs. Defaults: an active matching session, policy NOT
 *  tripped (turnsSinceSt low, usage well under wind-down), gate fires
 *  (needed:true), director returns a full intervene+set result, watermark
 *  unchanged (no re-arm). Each test overrides only the fields it cares about. */
export interface Knobs {
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
  /** The prep's playbook, as `sessionPreps.getBy` returns it. Overridden by the
   *  leak matrix to carry a sentinel secret. */
  sdPlaybook: string
  /** myth-3jna1 — the narrative-progress probe result. Default 0.9 (well ahead
   *  of any in-window mechanical fraction), so a test that only raises
   *  `totalUsed` gets the probe WITHOUT accidentally arming the steer. */
  narrativeProgress: StNarrativeProgressOutput
  progressThrows: boolean
  /** session_messages rows the codec maps into the FT-context history (default
   *  empty). Drives formatExchanges through a non-empty slice. */
  rows: readonly SessionMessage[]
  /** Recorder fakes that should throw to exercise the guarded-write catch arms. */
  throwOneShotWrite: boolean
  throwStandingWrite: boolean
  throwSummaryWrite: boolean
  throwIncrUsage: boolean
  throwReArmCheck: boolean
}

export interface Recorders {
  setOneShot: string[]
  setStanding: string[]
  clearStandingCalls: number
  setSummary: string[]
  incrUsage: number[]
  resetTurnsCalls: number
  reArmCalls: { campaignId: string; sessionId: string }[]
  gateCalls: number
  gateInputs: { recentExchanges: string }[]
  directorInputs: StDirectorInput[]
  progressInputs: StNarrativeProgressInput[]
}

export function makeHarness(overrides: Partial<Knobs> = {}): {
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
    sdPlaybook: 'PLAYBOOK SECRETS',
    narrativeProgress: progress(0.9),
    progressThrows: false,
    rows: [],
    throwOneShotWrite: false,
    throwStandingWrite: false,
    throwSummaryWrite: false,
    throwIncrUsage: false,
    throwReArmCheck: false,
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
    gateInputs: [],
    directorInputs: [],
    progressInputs: [],
  }

  // respondedSeq is asked twice: at start (snapshot) then at end (re-arm check).
  let respondedCalls = 0

  const deps: StEvalProcessorDeps = {
    repo: {
      sessions: { getActiveByCampaign: () => Promise.resolve(knobs.session) },
      sessionPreps: { getBy: () => Promise.resolve({ sdPlaybook: knobs.sdPlaybook }) },
      sessionMessages: {
        listFtContextRows: (): Promise<SessionMessage[]> => Promise.resolve([...knobs.rows]),
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
        if (knobs.throwSummaryWrite) return Promise.reject(new Error('summary write boom'))
        rec.setSummary.push(s)
        return Promise.resolve()
      },
      ftContextTokens: () => Promise.resolve(knobs.totalUsed),
      incrUsageSt: (_c, t) => {
        if (knobs.throwIncrUsage) return Promise.reject(new Error('incr usage boom'))
        rec.incrUsage.push(t)
        return Promise.resolve()
      },
    },
    triggerState: {
      setOneShotDirection: (_c, text) => {
        if (knobs.throwOneShotWrite) return Promise.reject(new Error('one-shot write boom'))
        rec.setOneShot.push(text)
        return Promise.resolve()
      },
      setStandingDirection: (_c, text) => {
        if (knobs.throwStandingWrite) return Promise.reject(new Error('standing write boom'))
        rec.setStanding.push(text)
        return Promise.resolve()
      },
      clearStandingDirection: () => {
        if (knobs.throwStandingWrite) return Promise.reject(new Error('standing clear boom'))
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
        // The 2nd call is the re-arm-check read (writeUsageAndReArm); throw there
        // to drive that guarded arm without disturbing the start snapshot.
        if (respondedCalls === 1) return Promise.resolve(knobs.startWatermark)
        if (knobs.throwReArmCheck) return Promise.reject(new Error('re-arm check boom'))
        return Promise.resolve(knobs.endWatermark)
      },
    },
    runGate: (input) => {
      rec.gateCalls += 1
      rec.gateInputs.push({ recentExchanges: input.recentExchanges })
      if (knobs.gateThrows) return Promise.reject(new Error('gate boom'))
      return Promise.resolve(knobs.gate)
    },
    runNarrativeProgress: (input: StNarrativeProgressInput) => {
      rec.progressInputs.push(input)
      if (knobs.progressThrows) return Promise.reject(new Error('probe boom'))
      return Promise.resolve(knobs.narrativeProgress)
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

export const job = {
  data: { campaignId: CAMPAIGN, sessionId: SESSION } satisfies StEvalPayload,
}
