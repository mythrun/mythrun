// MYT-73 T10 — `processScribeJob` unit suite.
//
// The post-turn Scribe job is a TOTAL background shell: embed-on-append → secret
// tripwire (Haiku) → (breach) retcon-author (Opus) + a `correction`-kind turn.
// Every dependency is injected, so the whole decision tree is unit-testable
// WITHOUT a broker, Redis, DB, or LLM — the tripwire/retcon LLM wrappers are
// `vi.mock`'d module-level (controllable per test); the embedder / working set /
// repo / turn queue are recording fakes.
//
// SECURITY-BOUNDARY assertion (case 4): an empty/unresolvable sd_playbook FAILS
// LOUD (error log, NO tripwire call) rather than silently disarming the check.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SecretTripwireOutput } from '../../llm/secret-tripwire.js'
import type { RetconAuthorOutput } from '../../llm/retcon-author.js'
import { processScribeJob, type ScribeProcessorDeps } from '../scribe-worker.js'
import { TRIPWIRE_ESCALATE_CONFIDENCE_FLOOR, WORKING_SET_CAP } from '../scribe-config.js'
import {
  enqueueScribe,
  SCRIBE_JOB_NAME,
  type ScribeJobPayload,
  type ScribeQueueLike,
} from '../scribe-queue.js'
import type { TurnJobPayload } from '../turn-queue.js'
import type { WorkingSetItem, WorkingSetProposal } from '../working-set/types.js'

vi.mock('../../llm/secret-tripwire.js', () => ({ runSecretTripwire: vi.fn() }))
vi.mock('../../llm/retcon-author.js', () => ({ runRetconAuthor: vi.fn() }))

const CAMPAIGN = 'c-scribe-1'
const SESSION = 's-scribe-1'
const WORLD = 'w-scribe-1'
const TURN = 't-scribe-1'

function tripwireOut(over: Partial<SecretTripwireOutput['result']> = {}): SecretTripwireOutput {
  return {
    result: { breached: false, confidence: 0.9, secretRef: null, ...over },
    usage: { totalTokens: 5 } as unknown as SecretTripwireOutput['usage'],
    repairAttempted: false,
  }
}

function retconOut(over: Partial<RetconAuthorOutput> = {}): RetconAuthorOutput {
  return {
    result: {
      retconText: 'Correction: the gate was already open when you arrived.',
      supersededContent: 'the gate was locked',
      tier: 'known',
      ...over.result,
    },
    usage: { totalTokens: 200 } as unknown as RetconAuthorOutput['usage'],
    repairAttempted: over.repairAttempted ?? false,
  }
}

interface Recorders {
  appended: WorkingSetItem[][]
  evicted: { cap: number }[]
  loadReturns: WorkingSetItem[]
  embedInputs: string[][]
  enqueuedTurns: TurnJobPayload[]
  respondedSeq: number
}

interface Knobs {
  /** Active session (default present); null → playbook unresolvable. */
  session: { sessionNumber: number } | null
  /** The prep's sd_playbook (default a non-empty secret block). */
  sdPlaybook: string | null
  /** working-set load() result (default the recorders' loadReturns). */
  embedThrows: boolean
}

function makeDeps(over: Partial<Knobs> = {}): {
  deps: ScribeProcessorDeps
  rec: Recorders
} {
  const knobs: Knobs = {
    session: { sessionNumber: 3 },
    sdPlaybook: 'The duke is the poisoner; the ring is cursed.',
    embedThrows: false,
    ...over,
  }
  const rec: Recorders = {
    appended: [],
    evicted: [],
    loadReturns: [],
    embedInputs: [],
    enqueuedTurns: [],
    respondedSeq: 12,
  }

  const deps: ScribeProcessorDeps = {
    repo: {
      sessions: { getActiveByCampaign: () => Promise.resolve(knobs.session) },
      sessionPreps: {
        getBy: () =>
          Promise.resolve(knobs.sdPlaybook === null ? null : { sdPlaybook: knobs.sdPlaybook }),
      },
    },
    triggerState: { getRespondedSeq: () => Promise.resolve(rec.respondedSeq) },
    workingSet: {
      load: () => Promise.resolve([...rec.loadReturns]),
      append: (_c, items) => {
        rec.appended.push([...items])
        return Promise.resolve()
      },
      evictIfOver: (_c, cap) => {
        rec.evicted.push({ cap })
        return Promise.resolve()
      },
    },
    embedder: {
      embedDocuments: (texts) => {
        rec.embedInputs.push([...texts])
        if (knobs.embedThrows) return Promise.reject(new Error('voyage boom'))
        // One deterministic 3-dim vector per input.
        return Promise.resolve(texts.map((_t, i) => [i, i + 1, i + 2]))
      },
    },
    runTripwire: vi.fn(),
    runRetcon: vi.fn(),
    sessionTurnQueue: {
      add: ((_name: string, payload: TurnJobPayload) => {
        rec.enqueuedTurns.push(payload)
        return Promise.resolve({})
      }) as ScribeProcessorDeps['sessionTurnQueue']['add'],
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { deps, rec }
}

function job(over: Partial<ScribeJobPayload> = {}): { data: ScribeJobPayload } {
  return {
    data: {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      turnId: TURN,
      worldId: WORLD,
      prose: 'The duke greets you warmly by the open gate.',
      worldDelta: null,
      injections: [],
      ...over,
    },
  }
}

const stInjection: WorkingSetProposal = {
  kind: 'fact',
  content: 'The duke claims the harvest failed.',
  subjectName: 'the duke',
  tier: 'known',
  provenance: { kind: 'attributed', npcEntityId: 'e-duke', npcName: 'Duke Aldric' },
  source: 'st_injection',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('processScribeJob — clean turn (no breach)', () => {
  it('case 1: tripwire breached:false → proposals embedded + appended + evicted, NO retcon/correction', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut({ breached: false, confidence: 0.95 }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job({ injections: [stInjection] }))

    expect(rec.embedInputs).toEqual([[stInjection.content]])
    expect(rec.appended).toHaveLength(1)
    expect(rec.appended[0]).toHaveLength(1)
    expect(rec.appended[0]?.[0]?.embedding).toEqual([0, 1, 2])
    expect(rec.evicted).toEqual([{ cap: WORKING_SET_CAP }])
    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
  })
})

describe('processScribeJob — FT delta mapping', () => {
  it('case 2: worldDelta facts map to ft_delta / known / objective proposals', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut())

    await processScribeJob(
      deps,
      job({
        worldDelta: {
          facts: [{ subject: 'the gate', content: 'The gate stands open.', kind: 'fact' }],
        },
      }),
    )

    const item = rec.appended[0]?.[0]
    expect(item).toBeDefined()
    expect(item?.source).toBe('ft_delta')
    expect(item?.tier).toBe('known')
    expect(item?.provenance).toEqual({ kind: 'objective' })
    expect(item?.subjectName).toBe('the gate')
    expect(item?.kind).toBe('fact')
    expect(item?.content).toBe('The gate stands open.')
    expect(item?.turnId).toBe(TURN)
  })
})

describe('processScribeJob — breach → retcon + correction turn', () => {
  it('case 3: breach → retcon authored + a correction-kind turn enqueued + a retcon supersede appended', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ breached: true, confidence: 0.85, secretRef: '[SECRET-1]' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    // The correction turn carries the retconText + current responded watermark.
    expect(rec.enqueuedTurns).toHaveLength(1)
    const turn = rec.enqueuedTurns[0]
    expect(turn?.trigger.kind).toBe('correction')
    expect(turn?.correctionText).toBe('Correction: the gate was already open when you arrived.')
    expect(turn?.triggerMessages).toEqual([])
    expect(turn?.maxConsumedSeq).toBe(12)
    // The retcon supersede item landed in the working set (subjectName = secretRef).
    const retconAppend = rec.appended.find((batch) => batch.some((i) => i.source === 'retcon'))
    expect(retconAppend).toBeDefined()
    const retcon = retconAppend?.find((i) => i.source === 'retcon')
    expect(retcon?.subjectName).toBe('[SECRET-1]')
    // §8c — the retcon-author's secret-bearing `supersededContent` is NEVER
    // persisted to the working set (it names the secret by construction).
    expect(retcon?.supersededContent).toBeUndefined()
    expect(retcon?.content).toBe('Correction: the gate was already open when you arrived.')
    expect(retcon?.embedding).toEqual([])
  })
})

describe('processScribeJob — enforced-ignorance: empty playbook FAILS LOUD', () => {
  it('case 4a: null prep → error log (scribe_tripwire_misconfigured), NO tripwire call, no silent pass', async () => {
    const { deps } = makeDeps({ sdPlaybook: null })
    const tw = vi.fn()
    deps.runTripwire = tw

    await processScribeJob(deps, job())

    expect(tw).not.toHaveBeenCalled()
    expect(deps.logger.error).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(deps.logger.error).mock.calls[0]?.[0]
    expect(JSON.stringify(arg)).toContain('campaign')
    const msg = vi.mocked(deps.logger.error).mock.calls[0]?.[1]
    expect(msg).toContain('misconfigured')
  })

  it('case 4b: empty/whitespace playbook → FAILS LOUD, NO tripwire call', async () => {
    const { deps } = makeDeps({ sdPlaybook: '   ' })
    const tw = vi.fn()
    deps.runTripwire = tw

    await processScribeJob(deps, job())

    expect(tw).not.toHaveBeenCalled()
    expect(deps.logger.error).toHaveBeenCalled()
  })

  it('case 4c: no active session → FAILS LOUD, NO tripwire call', async () => {
    const { deps } = makeDeps({ session: null })
    const tw = vi.fn()
    deps.runTripwire = tw

    await processScribeJob(deps, job())

    expect(tw).not.toHaveBeenCalled()
    expect(deps.logger.error).toHaveBeenCalled()
  })

  it('case 4d: playbook read THROWS → FAILS LOUD (error log), NO tripwire call, no throw out', async () => {
    const { deps } = makeDeps()
    deps.repo.sessions.getActiveByCampaign = () => Promise.reject(new Error('pg boom'))
    const tw = vi.fn()
    deps.runTripwire = tw

    await expect(processScribeJob(deps, job())).resolves.toBeUndefined()

    expect(tw).not.toHaveBeenCalled()
    const errs = vi.mocked(deps.logger.error).mock.calls.map((c) => String(c[1]))
    expect(errs.some((m) => m.includes('misconfigured'))).toBe(true)
  })
})

describe('processScribeJob — embed failure degrades', () => {
  it('case 5: embed throws → items appended with empty embeddings + a degraded log', async () => {
    const { deps, rec } = makeDeps({ embedThrows: true })
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut())

    await processScribeJob(deps, job({ injections: [stInjection] }))

    expect(rec.appended).toHaveLength(1)
    expect(rec.appended[0]?.[0]?.embedding).toEqual([])
    expect(deps.logger.warn).toHaveBeenCalled()
    const warns = vi.mocked(deps.logger.warn).mock.calls.map((c) => String(c[1]))
    expect(warns.some((m) => m.includes('embed failed'))).toBe(true)
  })
})

describe('processScribeJob — repairAttempted retcon fail-softs', () => {
  it('case 6: retcon repairAttempted → NO correction enqueued, no retcon appended, fail-soft log', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ breached: true, confidence: 0.9, secretRef: '[SECRET-1]' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut({ repairAttempted: true }))

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.appended.some((batch) => batch.some((i) => i.source === 'retcon'))).toBe(false)
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})

describe('processScribeJob — double-retcon guard', () => {
  it('case 7: a second breach on a secretRef with a live supersede skips re-authoring', async () => {
    const { deps, rec } = makeDeps()
    // The working set already holds a retcon item superseding [SECRET-1].
    rec.loadReturns = [
      {
        kind: 'fact',
        content: 'Correction (prior turn).',
        subjectName: '[SECRET-1]',
        tier: 'known',
        provenance: { kind: 'objective' },
        source: 'retcon',
        supersededContent: 'the old false thing',
        id: 'prev-retcon',
        turnId: 'prev-turn',
        embedding: [],
      },
    ]
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ breached: true, confidence: 0.9, secretRef: '[SECRET-1]' }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(deps.logger.info).toHaveBeenCalled()
  })
})

describe('processScribeJob — tripwire failure is contained', () => {
  it('case 9: tripwire throws → caught + warn, no retcon, no throw out', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockRejectedValue(new Error('haiku boom'))
    deps.runRetcon = vi.fn()

    await expect(processScribeJob(deps, job())).resolves.toBeUndefined()

    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    const warns = vi.mocked(deps.logger.warn).mock.calls.map((c) => String(c[1]))
    expect(warns.some((m) => m.includes('tripwire failed'))).toBe(true)
  })
})

describe('processScribeJob — working-set persistence is best-effort', () => {
  it('case 10: append throws → error log, but the tripwire still runs (secret check is load-bearing)', async () => {
    const { deps } = makeDeps()
    deps.workingSet.append = () => Promise.reject(new Error('redis boom'))
    const tw = vi.fn().mockResolvedValue(tripwireOut())
    deps.runTripwire = tw

    await expect(processScribeJob(deps, job({ injections: [stInjection] }))).resolves.toBeUndefined()

    expect(deps.logger.error).toHaveBeenCalled()
    const errs = vi.mocked(deps.logger.error).mock.calls.map((c) => String(c[1]))
    expect(errs.some((m) => m.includes('working-set'))).toBe(true)
    // The secret check still ran — the load-bearing half is not skipped.
    expect(tw).toHaveBeenCalledTimes(1)
  })
})

describe('enqueueScribe', () => {
  it('case 11: adds under SCRIBE_JOB_NAME with the full payload, no custom jobId', async () => {
    const calls: { name: string; payload: ScribeJobPayload }[] = []
    const queue: ScribeQueueLike = {
      add: ((name: string, payload: ScribeJobPayload) => {
        calls.push({ name, payload })
        return Promise.resolve({})
      }) as ScribeQueueLike['add'],
    }
    const payload = job().data
    await enqueueScribe(queue, payload)
    expect(calls).toEqual([{ name: SCRIBE_JOB_NAME, payload }])
  })
})

describe('processScribeJob — low-confidence breach escalates', () => {
  it('case 8: breached:true below the confidence floor still escalates to the retcon-author', async () => {
    const { deps, rec } = makeDeps()
    const lowConf = TRIPWIRE_ESCALATE_CONFIDENCE_FLOOR - 0.1
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ breached: true, confidence: lowConf, secretRef: '[SECRET-2]' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    expect(rec.enqueuedTurns).toHaveLength(1)
    // The breach handle threads to the retcon item's subjectName.
    const retcon = rec.appended
      .flat()
      .find((i) => i.source === 'retcon')
    expect(retcon?.subjectName).toBe('[SECRET-2]')
  })

  it('case 12: breached:true with a null secretRef → defensive [SECRET-1] fallback handle', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ breached: true, confidence: 0.9, secretRef: null }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    // The retcon-author receives the fallback handle as its `breach` input.
    const breachArg = (vi.mocked(deps.runRetcon).mock.calls[0]?.[0] as { breach: string }).breach
    expect(breachArg).toBe('[SECRET-1]')
    const retcon = rec.appended.flat().find((i) => i.source === 'retcon')
    expect(retcon?.subjectName).toBe('[SECRET-1]')
  })
})
