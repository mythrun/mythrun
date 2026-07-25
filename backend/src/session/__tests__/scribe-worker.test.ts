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
import { splitPlaybook } from '../playbook-split.js'
import { WORKING_SET_CAP } from '../scribe-config.js'
import {
  enqueueScribe,
  SCRIBE_JOB_NAME,
  type ScribeJobPayload,
  type ScribeQueueLike,
} from '../scribe-queue.js'
import { ST_EVAL_JOB_NAME, type StEvalPayload } from '../st-eval-queue.js'
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
    result: { severity: 'none', confidence: 0.9, secretRef: null, ...over },
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
  enqueuedStEvals: { name: string; payload: StEvalPayload }[]
  respondedSeq: number
  /** myth-g4hf3 — every persisted tripwire verdict row. */
  verdicts: {
    campaignId: string
    sessionId: string
    turnId: string
    severity: string
    confidence: number
    secretRef: string | null
  }[]
}

interface Knobs {
  /** Active session (default present); null → playbook unresolvable. */
  session: { sessionNumber: number } | null
  /** The prep's sd_playbook (default a non-empty secret block). */
  sdPlaybook: string | null
  /** The prep's PUBLIC ft_context — the tripwire's grounding floor.
   *  `null` exercises the worker's `?? ''` missing-column fallback. */
  ftContext: string | null
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
    ftContext: 'The duke hosts a feast. Public guests mingle in the great hall.',
    embedThrows: false,
    ...over,
  }
  const rec: Recorders = {
    appended: [],
    evicted: [],
    loadReturns: [],
    embedInputs: [],
    enqueuedTurns: [],
    enqueuedStEvals: [],
    respondedSeq: 12,
    verdicts: [],
  }

  const deps: ScribeProcessorDeps = {
    repo: {
      sessions: { getActiveByCampaign: () => Promise.resolve(knobs.session) },
      sessionPreps: {
        getBy: () =>
          Promise.resolve(
            knobs.sdPlaybook === null
              ? null
              : { sdPlaybook: knobs.sdPlaybook, ftContext: knobs.ftContext },
          ),
      },
      tripwireVerdicts: {
        insert: (v) => {
          rec.verdicts.push({ ...v })
          return Promise.resolve()
        },
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
    stEvalQueue: {
      add: ((name: string, payload: StEvalPayload) => {
        rec.enqueuedStEvals.push({ name, payload })
        return Promise.resolve({})
      }) as ScribeProcessorDeps['stEvalQueue']['add'],
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

/** A playbook shaped like the prep template (myth-g4hf3 split fixture): two
 *  NPC secrets + one revelation conclusion = three [SECRET-n] handles; the
 *  encounter script ("fingers do not open") is CONSISTENCY material. */
const STRUCTURED_PLAYBOOK = `# Stage-Direction Playbook: Test, Session 3

## Session Goals
- Let the party reach the vault.

## NPC Secrets & Revelation Conditions

### Old Bram
- **Secret / hidden facts:** Bram is the duke's poisoner.
- **Revelation condition:** trust earned through action.

### Madame Voss
- **Secret / hidden facts:** Voss sailed on the Crimson Marlin.

## Revelation List (Three Clue Rule)

### The duke ordered the poisoning
- **Clue 1** (social) [corroborating]: Trigger: drinks with Bram.

## Encounter Notes
- The middle statue's fingers do not open. If pried: still stone.

## Pacing Guidance
- If dragging → [STAGE] a bell rings across the harbor [/STAGE]
`

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
  it('case 1: tripwire severity:none → proposals embedded + appended + evicted, NO retcon/correction/ST-signal', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut({ severity: 'none', confidence: 0.95 }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job({ injections: [stInjection] }))

    expect(rec.embedInputs).toEqual([[stInjection.content]])
    expect(rec.appended).toHaveLength(1)
    expect(rec.appended[0]).toHaveLength(1)
    expect(rec.appended[0]?.[0]?.embedding).toEqual([0, 1, 2])
    expect(rec.evicted).toEqual([{ cap: WORKING_SET_CAP }])
    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.enqueuedStEvals).toHaveLength(0)
  })
})

describe('processScribeJob — grounding floor: the tripwire receives the public ft_context', () => {
  it('case 1b: the PUBLIC ft_context is threaded to the tripwire as publicContext (grounding floor input)', async () => {
    const { deps } = makeDeps({ ftContext: 'PUBLIC BRIEFING: the drover watches the little door.' })
    const tw = vi.fn().mockResolvedValue(tripwireOut({ severity: 'none' }))
    deps.runTripwire = tw

    await processScribeJob(deps, job())

    expect(tw).toHaveBeenCalledTimes(1)
    const arg = tw.mock.calls[0]?.[0] as { prose: string; secrets: string; publicContext: string }
    expect(arg.publicContext).toBe('PUBLIC BRIEFING: the drover watches the little door.')
  })

  it('case 1c: a prep row with NO ft_context column threads an EMPTY publicContext (missing-column fallback, never undefined)', async () => {
    const { deps } = makeDeps({ ftContext: null })
    const tw = deps.runTripwire as ReturnType<typeof vi.fn>
    tw.mockResolvedValue(tripwireOut())

    await processScribeJob(deps, job())

    const arg = tw.mock.calls[0]?.[0] as { secrets: string; publicContext: string }
    expect(arg.publicContext).toBe('')
    // Sanity: the secret playbook still rides the `secrets` field (handle-wrapped).
    expect(arg.secrets).toContain('[SECRET-1]')
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

describe('processScribeJob — hard_reveal → retcon + correction turn', () => {
  it('case 3: hard_reveal → retcon authored + a correction-kind turn enqueued + a retcon supersede appended', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.85, secretRef: '[SECRET-1]' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    // The disruptive open retcon does NOT also fire the silent ST-signal path.
    expect(rec.enqueuedStEvals).toHaveLength(0)
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
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.9, secretRef: '[SECRET-1]' }))
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
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.9, secretRef: '[SECRET-1]' }))
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

describe('processScribeJob — hard_reveal is recall-biased on confidence', () => {
  it('case 8: a LOW-confidence hard_reveal (with a recognized handle) still fires the open retcon (severity gates, not confidence)', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.15, secretRef: '[SECRET-2]' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    expect(rec.enqueuedTurns).toHaveLength(1)
    // No silent ST-signal on the hard path.
    expect(rec.enqueuedStEvals).toHaveLength(0)
    // The breach handle threads to the retcon item's subjectName.
    const retcon = rec.appended
      .flat()
      .find((i) => i.source === 'retcon')
    expect(retcon?.subjectName).toBe('[SECRET-2]')
  })

  it('case 12 (myth-g4hf3 handle gate): hard_reveal with a NULL secretRef routes to the SILENT ST steer — no open retcon', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.9, secretRef: null }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    // A hard verdict that names NO listed secret is not licensed to retcon —
    // the Streisand-retcon protection's structural backstop.
    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.enqueuedStEvals).toHaveLength(1)
    const warns = vi.mocked(deps.logger.warn).mock.calls.map((c) => String(c[1]))
    expect(warns.some((m) => m.includes('without a recognized secret handle'))).toBe(true)
  })
})

describe('splitPlaybook — per-secret handles vs consistency material (myth-g4hf3)', () => {
  it('case 15: a template-shaped playbook splits into per-secret [SECRET-n] blocks; scripts/pacing become consistency', () => {
    const split = splitPlaybook(STRUCTURED_PLAYBOOK)

    expect(split.fallback).toBe(false)
    expect(split.handles).toEqual(['[SECRET-1]', '[SECRET-2]', '[SECRET-3]'])
    // Each NPC secret + the revelation conclusion is its own handle-annotated block.
    expect(split.secrets).toContain('[SECRET-1] ### Old Bram')
    expect(split.secrets).toContain('[SECRET-2] ### Madame Voss')
    expect(split.secrets).toContain('[SECRET-3] ### The duke ordered the poisoning')
    // The encounter script is NOT secret material.
    expect(split.secrets).not.toContain('fingers do not open')
    expect(split.consistency).toContain('fingers do not open')
    expect(split.consistency).toContain('## Pacing Guidance')
    expect(split.consistency).toContain('## Session Goals')
    // And no secret material bleeds into the consistency block.
    expect(split.consistency).not.toContain('poisoner')
    expect(split.consistency).not.toContain('Crimson Marlin')
  })

  it('case 16: a playbook with NO recognizable secret section falls back to the v1 whole-playbook lump (over-protective)', () => {
    const split = splitPlaybook('The duke is the poisoner; the ring is cursed.')

    expect(split.fallback).toBe(true)
    expect(split.handles).toEqual(['[SECRET-1]'])
    expect(split.secrets).toBe('[SECRET-1] The duke is the poisoner; the ring is cursed.')
    expect(split.consistency).toBe('')
  })

  it('case 28: a secret section with NO ### sub-heads rides whole as ONE handle (prep drift degrades toward protection)', () => {
    const split = splitPlaybook(
      '# Playbook\n\n## NPC Secrets & Revelation Conditions\nThe duke ordered the poisoning.\n\n## Session Goals\nKeep the party moving.',
    )

    expect(split.fallback).toBe(false)
    expect(split.handles).toEqual(['[SECRET-1]'])
    expect(split.secrets).toBe(
      '[SECRET-1] ## NPC Secrets & Revelation Conditions\nThe duke ordered the poisoning.',
    )
    expect(split.consistency).toContain('## Session Goals')
    expect(split.consistency).not.toContain('poisoning')
  })

  it('case 29: an EMPTY secret section emits no phantom handle (the other secret section still splits)', () => {
    const split = splitPlaybook(
      '## NPC Secrets & Revelation Conditions\n\n## Revelation List (Three Clue Rule)\n### The duke ordered the poisoning\nClue one; clue two; clue three.',
    )

    expect(split.fallback).toBe(false)
    expect(split.handles).toEqual(['[SECRET-1]'])
    expect(split.secrets).toContain('[SECRET-1] ### The duke ordered the poisoning')
  })
})

describe('processScribeJob — tripwire input carries the split + the dice grounding floor (myth-g4hf3)', () => {
  it('case 17: secrets = per-secret blocks; consistencyContext = scripts/pacing; diceOutcomes = the resolved checks', async () => {
    const { deps } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    const tw = vi.fn().mockResolvedValue(tripwireOut())
    deps.runTripwire = tw

    await processScribeJob(
      deps,
      job({
        skillChecks: [
          {
            characterName: 'Sable',
            skill: 'Investigation',
            dc: 12,
            outcomeTier: 'great_success',
            constraint: 'reveals the statue grips something precious',
          },
        ],
      }),
    )

    const arg = tw.mock.calls[0]?.[0] as {
      secrets: string
      consistencyContext: string
      diceOutcomes: string
    }
    expect(arg.secrets).toContain('[SECRET-2] ### Madame Voss')
    expect(arg.secrets).not.toContain('fingers do not open')
    expect(arg.consistencyContext).toContain('fingers do not open')
    expect(arg.diceOutcomes).toContain('Sable · Investigation vs DC 12 → great_success')
    expect(arg.diceOutcomes).toContain('reveals the statue grips something precious')
  })

  it('case 18: no skillChecks on the payload (pre-upgrade job) → empty diceOutcomes, no crash', async () => {
    const { deps } = makeDeps()
    const tw = vi.fn().mockResolvedValue(tripwireOut())
    deps.runTripwire = tw

    await processScribeJob(deps, job())

    const arg = tw.mock.calls[0]?.[0] as { diceOutcomes: string }
    expect(arg.diceOutcomes).toBe('')
  })
})

describe('processScribeJob — hard_reveal handle gate (myth-g4hf3 crit-grant protection)', () => {
  it('case 19: hard_reveal citing [CONSISTENCY] → SILENT ST steer, never an open retcon', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.8, secretRef: '[CONSISTENCY]' }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.enqueuedStEvals).toHaveLength(1)
  })

  it('case 20: hard_reveal citing a hallucinated handle ([SECRET-9]) → SILENT ST steer', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.8, secretRef: '[SECRET-9]' }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.enqueuedStEvals).toHaveLength(1)
  })

  it('case 21: a bracket/case-drifted but REAL handle (secret-2) still passes the gate (normalize, not string-equal)', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.8, secretRef: 'secret-2' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await processScribeJob(deps, job())

    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    expect(rec.enqueuedTurns).toHaveLength(1)
  })
})

describe('processScribeJob — dice_outcome provenance (myth-g4hf3 canonize-on-grant)', () => {
  const delta = {
    worldDelta: { facts: [{ subject: 'the sliver', content: 'Sable holds a stone sliver.', kind: 'fact' as const }] },
  }
  const check = (tier: 'fail' | 'success' | 'great_success') => ({
    characterName: 'Sable',
    skill: 'Investigation',
    dc: 12,
    outcomeTier: tier,
    constraint: 'c',
  })

  it('case 22: a great_success turn stamps its ft_delta facts dice_outcome (canon-on-grant)', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut())

    await processScribeJob(deps, job({ ...delta, skillChecks: [check('fail'), check('great_success')] }))

    const item = rec.appended[0]?.[0]
    expect(item?.source).toBe('ft_delta')
    expect(item?.provenance).toEqual({ kind: 'dice_outcome', outcomeTier: 'great_success' })
  })

  it('case 23: a turn with only FAILED checks (or none) keeps objective provenance', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut())

    await processScribeJob(deps, job({ ...delta, skillChecks: [check('fail')] }))

    expect(rec.appended[0]?.[0]?.provenance).toEqual({ kind: 'objective' })
  })

  it('case 27: a plain success (no great) stamps dice_outcome success — the grant tier the dice actually earned', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi.fn().mockResolvedValue(tripwireOut())

    await processScribeJob(deps, job({ ...delta, skillChecks: [check('fail'), check('success')] }))

    expect(rec.appended[0]?.[0]?.provenance).toEqual({ kind: 'dice_outcome', outcomeTier: 'success' })
  })
})

describe('processScribeJob — verdict persistence (myth-g4hf3)', () => {
  it('case 24: every verdict persists one row (severity/confidence/sanitized handle)', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'soft_consistency', confidence: 0.6, secretRef: '[SECRET-1]' }))

    await processScribeJob(deps, job())

    expect(rec.verdicts).toEqual([
      {
        campaignId: CAMPAIGN,
        sessionId: SESSION,
        turnId: TURN,
        severity: 'soft_consistency',
        confidence: 0.6,
        secretRef: '[SECRET-1]',
      },
    ])
  })

  it('case 25: an unrecognized secretRef persists as [UNRECOGNIZED] — arbitrary model text never lands durably', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.runTripwire = vi.fn().mockResolvedValue(
      tripwireOut({
        severity: 'hard_reveal',
        confidence: 0.7,
        secretRef: 'the duke poisoned the well', // a model echoing content, not a handle
      }),
    )
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    expect(rec.verdicts[0]?.secretRef).toBe('[UNRECOGNIZED]')
    // And the unrecognized handle also fails the routing gate (no open retcon).
    expect(deps.runRetcon).not.toHaveBeenCalled()
  })

  it('case 26: a verdict-persist failure fail-softs — routing still runs (the job is TOTAL)', async () => {
    const { deps, rec } = makeDeps({ sdPlaybook: STRUCTURED_PLAYBOOK })
    deps.repo.tripwireVerdicts.insert = () => Promise.reject(new Error('pg boom'))
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'hard_reveal', confidence: 0.9, secretRef: '[SECRET-1]' }))
    deps.runRetcon = vi.fn().mockResolvedValue(retconOut())

    await expect(processScribeJob(deps, job())).resolves.toBeUndefined()

    // The retcon path still ran despite the persist failure.
    expect(deps.runRetcon).toHaveBeenCalledTimes(1)
    expect(rec.enqueuedTurns).toHaveLength(1)
    const warns = vi.mocked(deps.logger.warn).mock.calls.map((c) => String(c[1]))
    expect(warns.some((m) => m.includes('verdict persist failed'))).toBe(true)
  })
})

describe('processScribeJob — soft_consistency → SILENT ST-signal, NO player correction', () => {
  it('case 13: soft_consistency (in-character NPC behavior) → NO retcon, NO correction turn, NO retcon item; one dedup-collapsed ST eval enqueued', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'soft_consistency', confidence: 0.6, secretRef: '[SECRET-1]' }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    // The Streisand retcon is suppressed: no Opus author, no player-facing turn,
    // no working-set supersede item.
    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.appended.some((batch) => batch.some((i) => i.source === 'retcon'))).toBe(false)
    // Instead: exactly one ST-evaluation is enqueued to steer future turns.
    expect(rec.enqueuedStEvals).toHaveLength(1)
    expect(rec.enqueuedStEvals[0]?.name).toBe(ST_EVAL_JOB_NAME)
    expect(rec.enqueuedStEvals[0]?.payload).toEqual({ campaignId: CAMPAIGN, sessionId: SESSION })
  })

  it('case 13b: a soft_consistency verdict with a NULL secretRef falls back to the coarse [SECRET-1] handle (same silent ST-signal path)', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'soft_consistency', confidence: 0.55, secretRef: null }))
    deps.runRetcon = vi.fn()

    await processScribeJob(deps, job())

    expect(deps.runRetcon).not.toHaveBeenCalled()
    expect(rec.enqueuedTurns).toHaveLength(0)
    expect(rec.enqueuedStEvals).toHaveLength(1)
  })

  it('case 14: a soft_consistency ST-signal enqueue failure fail-softs (no throw, warn logged, turn already shipped clean)', async () => {
    const { deps, rec } = makeDeps()
    deps.runTripwire = vi
      .fn()
      .mockResolvedValue(tripwireOut({ severity: 'soft_consistency', confidence: 0.6, secretRef: '[SECRET-1]' }))
    deps.stEvalQueue.add = (() => Promise.reject(new Error('redis boom'))) as ScribeProcessorDeps['stEvalQueue']['add']

    await expect(processScribeJob(deps, job())).resolves.toBeUndefined()

    expect(rec.enqueuedTurns).toHaveLength(0)
    const warns = vi.mocked(deps.logger.warn).mock.calls.map((c) => String(c[1]))
    expect(warns.some((m) => m.includes('ST-signal'))).toBe(true)
  })
})
