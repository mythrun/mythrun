// MYT-74b T9 — `processPostSessionAnalysisJob` unit suite.
//
// The post-session-analysis job is the end-of-session closeout: it reads ONLY
// durable inputs (the transcript tail, the prep sd_playbook, the ST running
// summary, the PC roster — all safe after the WS closes), runs ONE Opus call,
// mechanically verifies the handoff's verbatim excerpts against the transcript,
// and persists through the conditional `writeAnalysis` gate. Unlike the
// post-turn Scribe, this processor THROWS on transient failure so BullMQ retries
// (the `summary IS NULL` write gate makes a retry idempotent).
//
// Every dependency is injected — the decision tree is unit-testable with
// recording fakes, NO broker/Redis/PG/real-LLM.
//
// ENFORCED IGNORANCE (load-bearing): the worker logs STRUCTURAL counts/ids only.
// Case "force a drop" asserts NO summary/handoff/excerpt CONTENT appears in ANY
// logger argument — the enforced-ignorance log-surface proof at the worker level.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Pool } from 'pg'

import {
  processPostSessionAnalysisJob,
  enqueuePostSessionAnalysis,
  renderTranscriptTail,
  buildPostSessionAnalysisWorker,
  QUEUE_SESSION_ANALYSIS,
  ANALYSIS_JOB_NAME,
  type AnalysisProcessorDeps,
  type AnalysisJobPayload,
  type AnalysisQueueLike,
} from '../post-session-analysis.js'
import { verifyHandoffContainment } from '../analysis/containment.js'
import type { PostSessionAnalysisOutput } from '../../llm/post-session-analysis.js'
import type { PostSessionAnalysis, SessionHandoff } from '../../llm/schemas/post-session-analysis.js'

// The broker is module-mocked so `buildPostSessionAnalysisWorker` constructs a
// fake Worker (capturing the processor closure) instead of opening a real
// connection. Hoisted to module scope; the processor suite below never builds a
// Worker (it calls processPostSessionAnalysisJob with injected fakes), so the
// mock is inert there.
type CapturedProcessor = (job: { data: AnalysisJobPayload }) => Promise<void>
const bullmqCapture: { processor: CapturedProcessor | null; workerName: string | null } = {
  processor: null,
  workerName: null,
}
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string, processor: CapturedProcessor) => {
    bullmqCapture.processor = processor
    bullmqCapture.workerName = name
    return { close: () => Promise.resolve(), on: vi.fn() }
  }),
  Queue: vi.fn().mockImplementation((name: string) => ({ name, add: () => Promise.resolve({}) })),
}))

// Guard against an accidental real Opus call leaking into the boot drive (the
// boot-drive path early-outs before runAnalysis, but the mock makes that loud).
vi.mock('../../llm/post-session-analysis.js', () => ({
  runPostSessionAnalysis: () =>
    Promise.reject(new Error('analysis must not run on the boot-drive paths')),
}))

const CAMPAIGN = 'c-analysis-1'
const SESSION = 's-analysis-1'

// A locatable voice excerpt that IS a verbatim substring of the transcript.
const LOCATABLE_VOICE = 'You walk a dangerous road, traveler.'
// A fabricated voice excerpt that is NOT in the transcript (the verifier drops it).
const FABRICATED_VOICE = 'I have always known you would betray the crown.'

interface AnalysisRow {
  readonly seq: number
  readonly messageType: string
  readonly content: string
  readonly triggerKind: string | null
}

function rows(): AnalysisRow[] {
  return [
    { seq: 1, messageType: 'narration', content: 'The tavern was loud and warm.', triggerKind: null },
    {
      seq: 2,
      messageType: 'dm',
      content: `The old woman leaned close. "${LOCATABLE_VOICE}"`,
      triggerKind: 'dm_response',
    },
  ]
}

function handoff(over: Partial<SessionHandoff> = {}): SessionHandoff {
  return {
    party: [{ characterName: 'Mara', location: 'the tavern', condition: 'unharmed' }],
    timeOfDay: 'late evening',
    unresolvedThreads: ['the missing courier'],
    npcs: [{ name: 'the old woman', state: 'wary of the party', voice: [LOCATABLE_VOICE, FABRICATED_VOICE] }],
    keyLocations: [{ name: 'the tavern', atmosphere: 'The tavern was loud and warm.' }],
    ...over,
  }
}

function analysisResult(over: Partial<PostSessionAnalysis> = {}): PostSessionAnalysis {
  return {
    summary: 'The party met an old woman in the tavern who warned them of danger.',
    emergingThreads: ['who hired the missing courier'],
    handoff: handoff(),
    ...over,
  }
}

function analysisOut(result: PostSessionAnalysis): PostSessionAnalysisOutput {
  return {
    result,
    usage: { totalTokens: 700 } as unknown as PostSessionAnalysisOutput['usage'],
    repairAttempted: false,
  }
}

interface Recorders {
  listForAnalysisCalls: { sessionId: string; limit: number }[]
  prepCalls: { campaignId: string; sessionNumber: number }[]
  loadTurnStateCalls: string[]
  participantCalls: string[]
  runAnalysisCalls: {
    transcript: string
    runningSummary: string
    sdPlaybook: string
    participants: string
  }[]
  verifyCalls: number
  writeAnalysisCalls: {
    id: string
    summary: string
    emergingThreads: readonly string[]
    handoff: SessionHandoff
  }[]
}

interface Knobs {
  /** getById result (default an unanalysed session). */
  session: { sessionNumber: number; summary: string | null } | null
  /** the analysis Opus result. */
  analysis: PostSessionAnalysis
  /** transcript rows. */
  rows: AnalysisRow[]
  /** sessionPreps.getBy result. */
  prep: { sdPlaybook: string } | null
  /** loadTurnState running summary. */
  runningSummary: string
  /** roster. */
  participants: { name: string }[]
  /** writeAnalysis rowCount. */
  wrote: number
  /** runAnalysis rejects (transient). */
  rejectAnalysis: boolean
  /** use the REAL verifier instead of a passthrough fake. */
  realVerify: boolean
}

function makeDeps(over: Partial<Knobs> = {}): { deps: AnalysisProcessorDeps; rec: Recorders } {
  const knobs: Knobs = {
    session: { sessionNumber: 3, summary: null },
    analysis: analysisResult(),
    rows: rows(),
    prep: { sdPlaybook: 'SECRET: the old woman is the cult informant.' },
    runningSummary: 'Earlier the party crossed the eastern bridge.',
    participants: [{ name: 'Mara' }, { name: 'Tobin' }],
    wrote: 1,
    rejectAnalysis: false,
    realVerify: true,
    ...over,
  }
  const rec: Recorders = {
    listForAnalysisCalls: [],
    prepCalls: [],
    loadTurnStateCalls: [],
    participantCalls: [],
    runAnalysisCalls: [],
    verifyCalls: 0,
    writeAnalysisCalls: [],
  }

  const deps: AnalysisProcessorDeps = {
    repo: {
      sessions: {
        getById: () => Promise.resolve(knobs.session),
        writeAnalysis: (id, input) => {
          rec.writeAnalysisCalls.push({ id, ...input })
          return Promise.resolve(knobs.wrote)
        },
      },
      sessionPreps: {
        getBy: (campaignId, sessionNumber) => {
          rec.prepCalls.push({ campaignId, sessionNumber })
          return Promise.resolve(knobs.prep)
        },
      },
      sessionMessages: {
        listForAnalysis: (sessionId, limit) => {
          rec.listForAnalysisCalls.push({ sessionId, limit })
          return Promise.resolve([...knobs.rows])
        },
      },
      characters: {
        listSessionParticipantCharacters: (sessionId) => {
          rec.participantCalls.push(sessionId)
          return Promise.resolve([...knobs.participants])
        },
      },
    },
    sessionState: {
      loadTurnState: (campaignId) => {
        rec.loadTurnStateCalls.push(campaignId)
        return Promise.resolve({ summary: knobs.runningSummary, usage: { input: 0, output: 0 } })
      },
    },
    runAnalysis: (input) => {
      rec.runAnalysisCalls.push({
        transcript: input.transcript,
        runningSummary: input.runningSummary,
        sdPlaybook: input.sdPlaybook,
        participants: input.participants,
      })
      if (knobs.rejectAnalysis) return Promise.reject(new Error('opus_transient_blip'))
      return Promise.resolve(analysisOut(knobs.analysis))
    },
    verify: (h, transcriptRows) => {
      rec.verifyCalls += 1
      return knobs.realVerify
        ? verifyHandoffContainment(h, transcriptRows)
        : { handoff: h, droppedVoice: 0, droppedAtmosphere: 0 }
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { deps, rec }
}

function job(over: Partial<AnalysisJobPayload> = {}): { data: AnalysisJobPayload } {
  return { data: { campaignId: CAMPAIGN, sessionId: SESSION, ...over } }
}

/** Concatenate every argument passed to a vi.fn logger method into one string,
 *  for the "no content leaked" assertion. */
function loggerCallsToString(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls.map((args) => JSON.stringify(args)).join(' ')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('enqueuePostSessionAnalysis / queue constants', () => {
  it('adds the job with a per-session dedup jobId', async () => {
    const calls: unknown[] = []
    const queue: AnalysisQueueLike = {
      add: ((name: string, payload: AnalysisJobPayload, opts: unknown) => {
        calls.push({ name, payload, opts })
        return Promise.resolve({})
      }) as AnalysisQueueLike['add'],
    }
    await enqueuePostSessionAnalysis(queue, { campaignId: CAMPAIGN, sessionId: SESSION })
    expect(QUEUE_SESSION_ANALYSIS).toBe('session-analysis')
    expect(ANALYSIS_JOB_NAME).toBe('analysis')
    expect(calls).toEqual([
      {
        name: ANALYSIS_JOB_NAME,
        payload: { campaignId: CAMPAIGN, sessionId: SESSION },
        opts: { jobId: `analysis-${SESSION}` },
      },
    ])
  })
})

describe('processPostSessionAnalysisJob — early-outs', () => {
  it('null session → structural warn, no transcript read, no runAnalysis call', async () => {
    const { deps, rec } = makeDeps({ session: null })
    await processPostSessionAnalysisJob(deps, job())
    expect(rec.listForAnalysisCalls).toHaveLength(0)
    expect(rec.runAnalysisCalls).toHaveLength(0)
    expect(rec.writeAnalysisCalls).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('already analysed (summary set) → early-out: no listForAnalysis, no runAnalysis', async () => {
    const { deps, rec } = makeDeps({ session: { sessionNumber: 1, summary: 'x' } })
    await processPostSessionAnalysisJob(deps, job())
    expect(rec.listForAnalysisCalls).toHaveLength(0)
    expect(rec.runAnalysisCalls).toHaveLength(0)
    expect(rec.writeAnalysisCalls).toHaveLength(0)
    expect(deps.logger.info).toHaveBeenCalled()
  })
})

describe('processPostSessionAnalysisJob — clean run', () => {
  it('reads transcript + playbook + running summary + roster, runs analysis, verifies, writes the SANITIZED handoff', async () => {
    const { deps, rec } = makeDeps()
    await processPostSessionAnalysisJob(deps, job())

    // Inputs assembled from durable sources.
    expect(rec.listForAnalysisCalls).toEqual([{ sessionId: SESSION, limit: 160 }])
    expect(rec.prepCalls).toEqual([{ campaignId: CAMPAIGN, sessionNumber: 3 }])
    expect(rec.loadTurnStateCalls).toEqual([CAMPAIGN])
    expect(rec.participantCalls).toEqual([SESSION])

    // runAnalysis got the rendered transcript + the running summary + the
    // sd_playbook + the comma-joined roster.
    expect(rec.runAnalysisCalls).toHaveLength(1)
    const call = rec.runAnalysisCalls[0]
    expect(call?.transcript).toContain('The tavern was loud and warm.')
    expect(call?.transcript).toContain(LOCATABLE_VOICE)
    expect(call?.runningSummary).toBe('Earlier the party crossed the eastern bridge.')
    expect(call?.sdPlaybook).toBe('SECRET: the old woman is the cult informant.')
    expect(call?.participants).toBe('Mara, Tobin')

    // The handoff was verified, then the SANITIZED handoff was written — the
    // fabricated excerpt is gone, the locatable one survives.
    expect(rec.verifyCalls).toBe(1)
    expect(rec.writeAnalysisCalls).toHaveLength(1)
    const written = rec.writeAnalysisCalls[0]
    expect(written?.summary).toBe('The party met an old woman in the tavern who warned them of danger.')
    expect(written?.emergingThreads).toEqual(['who hired the missing courier'])
    expect(written?.handoff.npcs[0]?.voice).toEqual([LOCATABLE_VOICE])
    expect(written?.handoff.npcs[0]?.voice).not.toContain(FABRICATED_VOICE)
  })

  it('missing prep → sd_playbook defaults to "" (analysis still runs)', async () => {
    const { deps, rec } = makeDeps({ prep: null })
    await processPostSessionAnalysisJob(deps, job())
    expect(rec.runAnalysisCalls[0]?.sdPlaybook).toBe('')
    expect(rec.writeAnalysisCalls).toHaveLength(1)
  })

  it('missing running summary ("") is tolerated and passed through as ""', async () => {
    const { deps, rec } = makeDeps({ runningSummary: '' })
    await processPostSessionAnalysisJob(deps, job())
    expect(rec.runAnalysisCalls[0]?.runningSummary).toBe('')
    expect(rec.writeAnalysisCalls).toHaveLength(1)
  })

  it('no dropped excerpts → no drop-warn fires (both counts 0)', async () => {
    // A handoff whose voice + atmosphere are all verbatim-locatable → verify
    // drops nothing → the `droppedVoice > 0 || droppedAtmosphere > 0` branch is
    // false → no warn.
    const clean = analysisResult({
      handoff: handoff({
        npcs: [{ name: 'the old woman', state: 'wary', voice: [LOCATABLE_VOICE] }],
        keyLocations: [{ name: 'the tavern', atmosphere: 'The tavern was loud and warm.' }],
      }),
    })
    const { deps, rec } = makeDeps({ analysis: clean })
    await processPostSessionAnalysisJob(deps, job())
    expect(rec.writeAnalysisCalls).toHaveLength(1)
    const warnMock = deps.logger.warn as ReturnType<typeof vi.fn>
    const dropCall = warnMock.mock.calls.find((args) => args[1] === 'analysis_excerpts_dropped_not_in_transcript')
    expect(dropCall).toBeUndefined()
  })

  it('only an atmosphere drop (voice clean) still fires the structural warn', async () => {
    // voice all locatable (droppedVoice 0), but the location atmosphere is
    // fabricated → droppedAtmosphere > 0 exercises the RIGHT operand of the
    // `||` drop-warn guard.
    const atmosDrop = analysisResult({
      handoff: handoff({
        npcs: [{ name: 'the old woman', state: 'wary', voice: [LOCATABLE_VOICE] }],
        keyLocations: [{ name: 'the keep', atmosphere: 'A place never mentioned in the transcript.' }],
      }),
    })
    const { deps } = makeDeps({ analysis: atmosDrop })
    await processPostSessionAnalysisJob(deps, job())
    const warnMock = deps.logger.warn as ReturnType<typeof vi.fn>
    const dropCall = warnMock.mock.calls.find((args) => args[1] === 'analysis_excerpts_dropped_not_in_transcript')
    expect(dropCall).toBeDefined()
    const payload = dropCall?.[0] as Record<string, unknown>
    expect(payload.droppedVoice).toBe(0)
    expect(payload.droppedAtmosphere).toBe(1)
  })

  it('gate lost (writeAnalysis returns 0) → logs analysis_gate_lost, no throw', async () => {
    const { deps, rec } = makeDeps({ wrote: 0 })
    await expect(processPostSessionAnalysisJob(deps, job())).resolves.toBeUndefined()
    expect(rec.writeAnalysisCalls).toHaveLength(1)
    const infoMock = deps.logger.info as ReturnType<typeof vi.fn>
    const msgs = infoMock.mock.calls.map((args) => args[1] as string | undefined)
    expect(msgs).toContain('analysis_gate_lost')
  })
})

describe('processPostSessionAnalysisJob — enforced-ignorance log surface', () => {
  it('a forced drop logs the COUNT only; no summary/handoff/excerpt content in ANY logger arg', async () => {
    // The default handoff carries one fabricated voice excerpt the real verifier
    // drops → droppedVoice > 0 → the structural warn fires.
    const { deps, rec } = makeDeps()
    await processPostSessionAnalysisJob(deps, job())

    // A structural warn carrying the drop COUNT was logged.
    expect(deps.logger.warn).toHaveBeenCalled()
    const warnMock = deps.logger.warn as ReturnType<typeof vi.fn>
    const dropCall = warnMock.mock.calls.find((args) => args[1] === 'analysis_excerpts_dropped_not_in_transcript')
    expect(dropCall).toBeDefined()
    const payload = dropCall?.[0] as Record<string, unknown>
    expect(payload.droppedVoice).toBe(1)
    expect(payload.droppedAtmosphere).toBe(0)
    expect(payload.sessionId).toBe(SESSION)

    // ENFORCED IGNORANCE: NO secret/dropped/summary/handoff content in ANY logger arg.
    const allErr = loggerCallsToString(deps.logger.error as ReturnType<typeof vi.fn>)
    const allInfo = loggerCallsToString(deps.logger.info as ReturnType<typeof vi.fn>)
    const allWarn = loggerCallsToString(deps.logger.warn as ReturnType<typeof vi.fn>)
    const all = `${allErr} ${allInfo} ${allWarn}`
    expect(all).not.toContain(FABRICATED_VOICE)
    expect(all).not.toContain(LOCATABLE_VOICE)
    expect(all).not.toContain('SECRET: the old woman is the cult informant.')
    expect(all).not.toContain('The party met an old woman in the tavern who warned them of danger.')

    // sanity: the run still wrote.
    expect(rec.writeAnalysisCalls).toHaveLength(1)
  })
})

describe('processPostSessionAnalysisJob — transient failure', () => {
  it('rethrows when runAnalysis rejects (BullMQ retries); no write', async () => {
    const { deps, rec } = makeDeps({ rejectAnalysis: true })
    await expect(processPostSessionAnalysisJob(deps, job())).rejects.toThrow('opus_transient_blip')
    expect(rec.writeAnalysisCalls).toHaveLength(0)
  })
})

describe('renderTranscriptTail (pure)', () => {
  it('renders each row as [messageType] content, newline-joined', () => {
    const out = renderTranscriptTail([
      { messageType: 'narration', content: 'A door creaks.' },
      { messageType: 'player', content: 'I draw my blade.' },
    ])
    expect(out).toBe('[narration] A door creaks.\n[player] I draw my blade.')
  })
})

// ── Boot wiring (mocked broker) ───────────────────────────────────────────────
//
// Exercise buildPostSessionAnalysisWorker against the mocked broker: assert it
// builds a Worker on QUEUE_SESSION_ANALYSIS and drives the captured processor
// through the REAL boot closures (createRepo / makeSessionState). The fake pool
// answers the `getById` gate read so the early-out path (summary set) runs end-
// to-end without reaching the (module-mocked) Opus call.

/** A fake pool whose `query` answers the session gate read. `analysed` flips the
 *  gate row's `summary` between the already-done early-out and a fresh session. */
function makeFakePool(analysed: boolean): Pool {
  const sessionRow = {
    id: SESSION,
    campaign_id: CAMPAIGN,
    session_number: 3,
    status: 'ended',
    started_at: new Date(0),
    ended_at: new Date(0),
    summary: analysed ? '{"summary":"done","emergingThreads":[]}' : null,
    st_running_summary: null,
    handoff: null,
    reconciled_at: null,
  }
  const query = (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes('FROM sessions') && sql.includes('WHERE id')) {
      return Promise.resolve({ rows: [sessionRow], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  return { query } as unknown as Pool
}

describe('buildPostSessionAnalysisWorker — boot wiring + processor closure', () => {
  beforeEach(() => {
    bullmqCapture.processor = null
    bullmqCapture.workerName = null
  })

  it('builds a Worker on QUEUE_SESSION_ANALYSIS', () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const worker = buildPostSessionAnalysisWorker(redis, redis, 'analysis:', makeFakePool(false), logger)
    expect(worker).toBeDefined()
    expect(bullmqCapture.workerName).toBe(QUEUE_SESSION_ANALYSIS)
  })

  it('already-analysed session → drives the real getById closure to the early-out', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildPostSessionAnalysisWorker(redis, redis, 'analysis:', makeFakePool(true), logger)
    const processor = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')

    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION } })

    // The early-out fired through the REAL createRepo getById; no Opus call (the
    // module-mocked runAnalysis would have rejected loudly).
    const doneLog = logger.info.mock.calls.find((c) => c[1] === 'analysis_already_done')
    expect(doneLog).toBeDefined()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
