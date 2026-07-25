// MYT-74a T10 — `processReconcileJob` unit suite.
//
// The session-reconcile job is the orchestration tying Wave A–C together:
// load the working set → retrieve canon candidates → render → reconcile (Opus)
// → validate (PURE, security-critical) → embed → commit (one tx, gated). Unlike
// the post-turn Scribe job this processor is NOT total: it THROWS on transient
// failure so BullMQ retries (the §4 reconciled_at gate makes a retry idempotent).
//
// Every dependency is injected — the whole decision tree is unit-testable with
// recording fakes, NO broker/Redis/PG/real-LLM. `validateReconcilePlan` is the
// REAL pure validator (the security boundary is exercised, not stubbed).
//
// SECURITY-BOUNDARY assertion (case "validation reject"): a rejected plan logs a
// STRUCTURAL code ONLY (never fact content), and the processor THROWS so the
// non-deterministic Opus call is retried. We assert NO fact-content string
// appears in ANY logger argument — the enforced-ignorance log-surface proof at
// the worker level.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  processReconcileJob,
  enqueueReconcile,
  renderWorkingSet,
  renderCandidates,
  QUEUE_SESSION_RECONCILE,
  RECONCILE_JOB_NAME,
  type ReconcileProcessorDeps,
  type ReconcileJobPayload,
  type ReconcileQueueLike,
} from '../session-reconcile.js'
import type { ReconcilePlan } from '../../llm/schemas/session-reconcile.js'
import type { SessionReconcilerOutput } from '../../llm/session-reconciler.js'
import type { EntityCandidate } from '../../world/retrieval/types.js'
import type { FactRow } from '../../repo/facts.js'
import type { WorkingSetItem } from '../working-set/types.js'
import type { Session } from '../../repo/types.js'

const CAMPAIGN = 'c-recon-1'
const SESSION = 's-recon-1'
const WORLD = 'w-recon-1'

// A fact-content string we assert NEVER leaks into a reject log surface.
const SECRET_FACT_CONTENT = 'The duke is the poisoner and the ring is cursed.'

function wsItem(over: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    kind: 'fact',
    content: 'The duke greeted the party at the open gate.',
    subjectName: 'the duke',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
    id: 'ws-1',
    turnId: 't-1',
    embedding: [0.1, 0.2, 0.3],
    ...over,
  }
}

function candidate(over: Partial<EntityCandidate> = {}): EntityCandidate {
  return { entityId: 'e-duke', name: 'Duke Aldric', entityType: 'npc', score: 0.9, ...over }
}

function liveFact(over: Partial<FactRow> = {}): FactRow {
  return {
    id: 'f-live-1',
    entityId: 'e-duke',
    topic: 'demeanor',
    accessLevel: 'known',
    narrativeStatus: 'delivered',
    content: 'The duke is cordial in public.',
    source: 'prep',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

/** A plan that PASSES validation against the default working set + candidates:
 *  one `match` on the live candidate id, one fact under that subject at-or-above
 *  its working-set tier. */
function validPlan(over: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return {
    entities: [
      {
        op: 'match',
        subjectName: 'the duke',
        canonEntityId: 'e-duke',
        name: 'Duke Aldric',
        entityType: 'npc',
        accessLevel: 'known',
      },
    ],
    facts: [
      {
        subjectName: 'the duke',
        topic: 'arrival',
        content: SECRET_FACT_CONTENT,
        accessLevel: 'known',
        claimedBy: null,
        supersedesFactId: null,
      },
    ],
    relationships: [],
    promotions: [],
    ...over,
  }
}

/** A plan that FAILS validation: the fact downgrades the tier of a secret-tier
 *  working-set item (secret → known is a `tier_downgrade`). */
function tierDowngradePlan(): ReconcilePlan {
  return {
    promotions: [],
    entities: [
      { op: 'mint', subjectName: 'the cult', canonEntityId: null, name: 'The Hidden Hand', entityType: 'faction', accessLevel: 'secret' },
    ],
    facts: [
      {
        subjectName: 'the cult',
        topic: 'membership',
        content: SECRET_FACT_CONTENT,
        accessLevel: 'known', // downgrade: the ws item is `secret`
        claimedBy: null,
        supersedesFactId: null,
      },
    ],
    relationships: [],
  }
}

function reconcilerOut(plan: ReconcilePlan): SessionReconcilerOutput {
  return {
    result: plan,
    usage: { totalTokens: 500 } as unknown as SessionReconcilerOutput['usage'],
    repairAttempted: false,
  }
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    campaignId: CAMPAIGN,
    sessionNumber: 3,
    status: 'active',
    startedAt: new Date(),
    endedAt: null,
    summary: null,
    stRunningSummary: null,
    handoff: null,
    reconciledAt: null,
    ...over,
  }
}

interface Recorders {
  released: number
  cleared: string[]
  loaded: string[]
  embedInputs: string[][]
  reconcilerCalls: { workingSet: string; candidates: string; worldTone: string; closingNarration: string }[]
  committedArgs: unknown[]
  findCalls: { worldId: string; text: string }[]
  listCalls: number
}

interface Knobs {
  /** getById result (default an unreconciled active session). */
  session: Session | null
  /** tryAcquire result (default a handle; null → contention). */
  acquireHandle: boolean
  /** workingSet.load result (default one item). */
  items: WorkingSetItem[]
  /** findSimilarEntities result. */
  candidates: EntityCandidate[]
  /** listByEntities result. */
  liveFacts: FactRow[]
  /** the reconciler plan. */
  plan: ReconcilePlan
  /** applyCommit result. */
  committed: boolean
  /** worlds.getById tone projection. */
  worldTone: string | null
  /** canon-by-name second-chance lookup (lowercased name → id); default empty. */
  canonByName: Record<string, string>
  /** myth-8mom0 — the farewell turn's closing narration rows; default none. */
  farewell: string[]
}

function makeDeps(over: Partial<Knobs> = {}): { deps: ReconcileProcessorDeps; rec: Recorders } {
  const knobs: Knobs = {
    session: session(),
    acquireHandle: true,
    items: [wsItem()],
    candidates: [candidate()],
    liveFacts: [liveFact()],
    plan: validPlan(),
    committed: true,
    worldTone: 'grim, low-fantasy, terse',
    canonByName: {},
    farewell: [],
    ...over,
  }
  const rec: Recorders = {
    released: 0,
    cleared: [],
    loaded: [],
    embedInputs: [],
    reconcilerCalls: [],
    committedArgs: [],
    findCalls: [],
    listCalls: 0,
  }

  const deps: ReconcileProcessorDeps = {
    repo: {
      sessions: { getById: () => Promise.resolve(knobs.session) },
      facts: {
        listByEntities: () => {
          rec.listCalls += 1
          return Promise.resolve(knobs.liveFacts)
        },
      },
      entities: {
        findIdByWorldAndNormalizedName: (_worldId, name) =>
          Promise.resolve(knobs.canonByName[name.trim().toLowerCase()] ?? null),
      },
      sessionMessages: {
        listFarewellNarration: () => Promise.resolve([...knobs.farewell]),
      },
    worlds: { getSnapshotSummary: () => Promise.resolve(knobs.worldTone === null ? null : ({ tone: knobs.worldTone } as never)) },
      // `transaction` is only read by applyCommit, which is injected as a fake here.
      transaction: () => Promise.reject(new Error('transaction must not be called directly')),
    },
    workingSet: {
      load: (c) => {
        rec.loaded.push(c)
        return Promise.resolve([...knobs.items])
      },
      clear: (c) => {
        rec.cleared.push(c)
        return Promise.resolve()
      },
    },
    lock: {
      tryAcquire: () =>
        Promise.resolve(
          knobs.acquireHandle
            ? {
                token: 'tok',
                extend: () => Promise.resolve(true),
                release: () => {
                  rec.released += 1
                  return Promise.resolve()
                },
              }
            : null,
        ),
    },
    findSimilarEntities: (worldId, text) => {
      rec.findCalls.push({ worldId, text })
      return Promise.resolve(knobs.candidates)
    },
    embedder: {
      embedDocuments: (texts) => {
        rec.embedInputs.push([...texts])
        return Promise.resolve(texts.map((_t, i) => [i, i + 1, i + 2]))
      },
    },
    runReconciler: (input) => {
      rec.reconcilerCalls.push({
        workingSet: input.workingSet,
        candidates: input.candidates,
        worldTone: input.worldTone,
        closingNarration: input.closingNarration ?? '',
      })
      return Promise.resolve(reconcilerOut(knobs.plan))
    },
    applyCommit: (_repo, args) => {
      rec.committedArgs.push(args)
      return Promise.resolve({ committed: knobs.committed })
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { deps, rec }
}

function job(over: Partial<ReconcileJobPayload> = {}): { data: ReconcileJobPayload } {
  return { data: { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD, ...over } }
}

/** Concatenate every argument passed to a vi.fn logger method into one string,
 *  for the "no content leaked" assertion. */
function loggerCallsToString(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls.map((args) => JSON.stringify(args)).join(' ')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('enqueueReconcile / queue constants', () => {
  it('adds the job with a per-session dedup jobId', async () => {
    const calls: unknown[] = []
    const queue: ReconcileQueueLike = {
      add: ((name: string, payload: ReconcileJobPayload, opts: unknown) => {
        calls.push({ name, payload, opts })
        return Promise.resolve({})
      }) as ReconcileQueueLike['add'],
    }
    await enqueueReconcile(queue, { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD })
    expect(QUEUE_SESSION_RECONCILE).toBe('session-reconcile')
    expect(RECONCILE_JOB_NAME).toBe('reconcile')
    expect(calls).toEqual([
      {
        name: RECONCILE_JOB_NAME,
        payload: { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD },
        opts: { jobId: `reconcile-${SESSION}` },
      },
    ])
  })
})

describe('processReconcileJob — early-outs', () => {
  it('null session → structural warn, no reconciler call, no lock', async () => {
    const { deps, rec } = makeDeps({ session: null })
    await processReconcileJob(deps, job())
    expect(rec.reconcilerCalls).toHaveLength(0)
    expect(rec.loaded).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('already reconciled (reconciledAt set) → defensive clear, NO reconciler call, NO lock', async () => {
    const { deps, rec } = makeDeps({ session: session({ reconciledAt: new Date() }) })
    await processReconcileJob(deps, job())
    expect(rec.reconcilerCalls).toHaveLength(0)
    expect(rec.released).toBe(0) // never acquired the lock
    expect(rec.cleared).toEqual([CAMPAIGN]) // defensive clear of the interlock
  })
})

describe('processReconcileJob — entity-op heals (myth-ejsp5)', () => {
  it('canon-by-name pre-pass: an unknown-id match whose name lives in canon (not candidates) heals and commits', async () => {
    // plan matches 'Old Renn' with a bogus id; candidates don't carry that name;
    // the canon lookup does — the commit must receive the healed binding and the
    // heal warn must fire with names/ids only.
    const base = validPlan()
    const plan = {
      ...base,
      entities: base.entities.map((e) => ({ ...e, name: 'Old Renn', canonEntityId: 'bogus-id' })),
    }
    const { deps, rec } = makeDeps({ plan, canonByName: { 'old renn': 'e-renn-canon' } })
    await processReconcileJob(deps, job())

    expect(rec.committedArgs).toHaveLength(1)
    const args = rec.committedArgs[0] as { map: Map<string, { kind: string; id?: string }> }
    expect(args.map.get('the duke')).toEqual({ kind: 'match', id: 'e-renn-canon' })
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rebinds: [{ name: 'Old Renn', to: 'e-renn-canon' }] }),
      'reconcile_entity_ops_healed',
    )
  })

  it('candidate-name rebind skips the canon lookup (name already in the candidate map)', async () => {
    // The match op's name equals the retrieved candidate's name; the pre-pass
    // must skip the DB lookup (covered branch) and validate rebinds via the map.
    const base = validPlan()
    const plan = {
      ...base,
      entities: base.entities.map((e) => ({ ...e, canonEntityId: 'bogus-id' })),
    }
    const { deps, rec } = makeDeps({ plan })
    await processReconcileJob(deps, job())

    expect(rec.committedArgs).toHaveLength(1)
    const args = rec.committedArgs[0] as { map: Map<string, { kind: string; id?: string }> }
    // bound to the CANDIDATE's id purely by name — no canonByName knob set.
    expect(args.map.get('the duke')?.kind).toBe('match')
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ demotions: [] }),
      'reconcile_entity_ops_healed',
    )
  })

  it('mint-degrade: an unresolvable match commits as a MINT and warns with the demoted name', async () => {
    const base = validPlan()
    const plan = {
      ...base,
      entities: base.entities.map((e) => ({ ...e, name: 'Total Stranger', canonEntityId: null })),
    }
    const { deps, rec } = makeDeps({ plan })
    await processReconcileJob(deps, job())

    expect(rec.committedArgs).toHaveLength(1)
    const args = rec.committedArgs[0] as { map: Map<string, { kind: string }> }
    expect(args.map.get('the duke')).toEqual({ kind: 'mint' })
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ demotions: ['Total Stranger'] }),
      'reconcile_entity_ops_healed',
    )
  })
})

describe('processReconcileJob — clean run', () => {
  it('loads → retrieves → reconciles → validates → embeds → commits → clears + releases', async () => {
    const { deps, rec } = makeDeps()
    await processReconcileJob(deps, job())

    // retrieval keyed by the distinct subjectName, scoped to the world.
    expect(rec.findCalls).toEqual([{ worldId: WORLD, text: 'the duke' }])
    // the reconciler got rendered blocks + the world tone.
    expect(rec.reconcilerCalls).toHaveLength(1)
    expect(rec.reconcilerCalls[0]?.worldTone).toBe('grim, low-fantasy, terse')
    expect(rec.reconcilerCalls[0]?.workingSet).toContain('the duke')
    expect(rec.reconcilerCalls[0]?.candidates).toContain('Duke Aldric')
    // facts embedded BEFORE commit, one vector per plan fact.
    expect(rec.embedInputs).toEqual([[SECRET_FACT_CONTENT]])
    // committed → working set cleared + lock released.
    expect(rec.committedArgs).toHaveLength(1)
    expect(rec.cleared).toEqual([CAMPAIGN])
    expect(rec.released).toBe(1)
  })

  it('skips the embed call when the plan has zero facts', async () => {
    // A match-only plan (no facts) → embedder.embedDocuments is never called.
    const noFactPlan = validPlan({ facts: [] })
    const { deps, rec } = makeDeps({ plan: noFactPlan })
    await processReconcileJob(deps, job())
    expect(rec.embedInputs).toEqual([]) // the zero-facts arm: no embed
    const args = rec.committedArgs[0] as { factEmbeddings: unknown[] }
    expect(args.factEmbeddings).toEqual([])
    expect(rec.cleared).toEqual([CAMPAIGN])
  })

  it('de-dupes retrieval by distinct subjectName', async () => {
    const { deps, rec } = makeDeps({
      items: [wsItem(), wsItem({ id: 'ws-2', content: 'again' }), wsItem({ id: 'ws-3', subjectName: 'the gate' })],
    })
    await processReconcileJob(deps, job())
    expect(rec.findCalls.map((c) => c.text).sort()).toEqual(['the duke', 'the gate'])
  })

  it('reconcile_committed log carries a promotions COUNT, never the promotion fact id', async () => {
    // A clean commit whose plan promotes one live canon fact. The structural log
    // must report `promotions: 1` (a count), and the promotion fact id must NOT
    // appear in ANY logger argument — enforced ignorance: counts only, no ids.
    // The promoted id must be a LIVE candidate fact (else `dangling_promotion`),
    // so we promote the default live fact `f-live-1`.
    const PROMO_FACT_ID = 'f-live-1'
    const { deps } = makeDeps({ plan: validPlan({ promotions: [PROMO_FACT_ID] }) })

    await processReconcileJob(deps, job())

    const infoMock = deps.logger.info as ReturnType<typeof vi.fn>
    const committedCall = infoMock.mock.calls.find((args) => args[1] === 'reconcile_committed')
    expect(committedCall).toBeDefined()
    const payload = committedCall?.[0] as Record<string, unknown>
    expect(payload.promotions).toBe(1)
    // ENFORCED IGNORANCE: the promotion fact id leaks into NO logger argument.
    expect(loggerCallsToString(infoMock)).not.toContain(PROMO_FACT_ID)
    expect(loggerCallsToString(deps.logger.warn as ReturnType<typeof vi.fn>)).not.toContain(PROMO_FACT_ID)
    expect(loggerCallsToString(deps.logger.error as ReturnType<typeof vi.fn>)).not.toContain(PROMO_FACT_ID)
  })
})

describe('processReconcileJob — empty working set', () => {
  it('runs the commit with an empty plan to set the gate, then clears', async () => {
    const { deps, rec } = makeDeps({ items: [] })
    await processReconcileJob(deps, job())
    // No reconciler call; the commit still runs (empty plan) to fire the gate.
    expect(rec.reconcilerCalls).toHaveLength(0)
    expect(rec.committedArgs).toHaveLength(1)
    const args = rec.committedArgs[0] as { plan: ReconcilePlan; map: ReadonlyMap<string, unknown> }
    expect(args.plan).toEqual({ entities: [], facts: [], relationships: [], promotions: [] })
    expect(args.map.size).toBe(0)
    expect(rec.cleared).toEqual([CAMPAIGN])
    expect(rec.released).toBe(1)
  })

  it('empty working set + gate lost (committed:false) → no clear, no throw', async () => {
    const { deps, rec } = makeDeps({ items: [], committed: false })
    await expect(processReconcileJob(deps, job())).resolves.toBeUndefined()
    expect(rec.committedArgs).toHaveLength(1)
    expect(rec.cleared).toEqual([]) // the winner clears
    expect(rec.released).toBe(1)
  })
})

describe('processReconcileJob — farewell closing-narration carry (myth-8mom0)', () => {
  // The distinctive end-state beat the farewell turn landed. It exists ONLY in
  // the durable farewell rows (the player-less farewell is Scribe-skipped, so it
  // never entered the working set); reconcile must fold it into canon or the next
  // session re-serializes the PRE-farewell state.
  const FAREWELL_FACT =
    'Renn set down the finished lamp-bracket — both curves complete now — pulled on his coat, and was gone. His bench sat empty.'

  it('default clean run carries an EMPTY closing narration (no regression when there was no farewell)', async () => {
    const { deps, rec } = makeDeps()
    await processReconcileJob(deps, job())
    // No farewell rows → the reconciler still runs on the working set, with an
    // empty closing-narration block, and retrieval is unchanged.
    expect(rec.reconcilerCalls[0]?.closingNarration).toBe('')
    expect(rec.findCalls).toEqual([{ worldId: WORLD, text: 'the duke' }])
  })

  it('threads the farewell closing narration into the reconciler as its own block', async () => {
    // A normal session (non-empty working set) that ended with a farewell beat.
    const { deps, rec } = makeDeps({ farewell: [FAREWELL_FACT] })
    await processReconcileJob(deps, job())

    expect(rec.reconcilerCalls).toHaveLength(1)
    // The closing beat reaches the canon fold as the AUTHORITATIVE end-state input.
    expect(rec.reconcilerCalls[0]?.closingNarration).toContain('both curves complete now')
    // It is NOT smuggled into the working-set block (that stays the Scribe's facts).
    expect(rec.reconcilerCalls[0]?.workingSet).not.toContain('both curves complete now')
  })

  it('retrieves canon candidates SEMANTICALLY near the closing narration (so a farewell-updated subject resolves onto canon, not a duplicate)', async () => {
    const { deps, rec } = makeDeps({ farewell: [FAREWELL_FACT] })
    await processReconcileJob(deps, job())
    // The working-set subject query PLUS the closing-narration query.
    expect(rec.findCalls).toEqual([
      { worldId: WORLD, text: 'the duke' },
      { worldId: WORLD, text: FAREWELL_FACT },
    ])
  })

  it('ORDERING GUARANTEE: empty working set + a farewell beat → STILL reconciles (the fold is independent of whether the Scribe ran)', async () => {
    // Pre-fix this took the empty-working-set shortcut and committed an EMPTY plan
    // WITHOUT calling the reconciler — dropping the farewell entirely. Because the
    // farewell prose is read from the durable transcript (not the working set),
    // the fold no longer depends on any Scribe→reconcile timing.
    const { deps, rec } = makeDeps({ items: [], farewell: [FAREWELL_FACT] })
    await processReconcileJob(deps, job())

    expect(rec.reconcilerCalls).toHaveLength(1)
    expect(rec.reconcilerCalls[0]?.closingNarration).toContain('both curves complete now')
    expect(rec.reconcilerCalls[0]?.workingSet).toBe('') // empty working set rendered empty
    // Candidates for a farewell-only session come solely from the closing text.
    expect(rec.findCalls).toEqual([{ worldId: WORLD, text: FAREWELL_FACT }])
  })

  it('a farewell-derived SUPERSEDE folds into canon (the stale pre-farewell fact is corrected)', async () => {
    // The session-1 canon says the carving is half-finished (the default live
    // candidate fact f-live-1). The farewell finished it; the reconciler supersedes
    // that live fact. Assert the superseding fact reaches the commit and the gate
    // is set (validated against the REAL validator — supersede target is live).
    const supersedePlan = validPlan({
      facts: [
        {
          subjectName: 'the duke',
          topic: 'carving',
          content: 'The lamp-bracket carving is finished — both curves complete.',
          accessLevel: 'known',
          claimedBy: null,
          supersedesFactId: 'f-live-1',
        },
      ],
    })
    const { deps, rec } = makeDeps({ farewell: [FAREWELL_FACT], plan: supersedePlan })
    await processReconcileJob(deps, job())

    expect(rec.committedArgs).toHaveLength(1)
    const args = rec.committedArgs[0] as { plan: ReconcilePlan }
    expect(args.plan.facts[0]?.supersedesFactId).toBe('f-live-1')
    expect(args.plan.facts[0]?.content).toContain('both curves complete')
    expect(rec.cleared).toEqual([CAMPAIGN]) // committed → working set cleared
  })
})

describe('processReconcileJob — validation reject (enforced ignorance)', () => {
  it('logs a STRUCTURAL reason only (no content), does NOT commit, and THROWS for retry', async () => {
    const { deps, rec } = makeDeps({
      items: [wsItem({ subjectName: 'the cult', tier: 'secret', content: 'cult content' })],
      plan: tierDowngradePlan(),
    })

    await expect(processReconcileJob(deps, job())).rejects.toThrow()

    // commit NEVER ran.
    expect(rec.committedArgs).toHaveLength(0)
    // a structural reason WAS logged.
    expect(deps.logger.error).toHaveBeenCalled()
    const errorMock = deps.logger.error as ReturnType<typeof vi.fn>
    const firstArg = errorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstArg.reason).toBe('tier_downgrade')
    // ENFORCED IGNORANCE: NO fact content in ANY logger argument.
    const allErr = loggerCallsToString(deps.logger.error as ReturnType<typeof vi.fn>)
    const allInfo = loggerCallsToString(deps.logger.info as ReturnType<typeof vi.fn>)
    const allWarn = loggerCallsToString(deps.logger.warn as ReturnType<typeof vi.fn>)
    expect(allErr).not.toContain(SECRET_FACT_CONTENT)
    expect(allInfo).not.toContain(SECRET_FACT_CONTENT)
    expect(allWarn).not.toContain(SECRET_FACT_CONTENT)
    // the lock was still released (finally).
    expect(rec.released).toBe(1)
  })
})

describe('processReconcileJob — gate lost (committed:false)', () => {
  it('does not clear by this execution, does not throw', async () => {
    const { deps, rec } = makeDeps({ committed: false })
    await expect(processReconcileJob(deps, job())).resolves.toBeUndefined()
    expect(rec.committedArgs).toHaveLength(1)
    expect(rec.cleared).toEqual([]) // the winner clears, not this execution
    expect(rec.released).toBe(1)
  })
})

describe('processReconcileJob — lock contention', () => {
  it('throws when tryAcquire returns null (BullMQ retries)', async () => {
    const { deps, rec } = makeDeps({ acquireHandle: false })
    await expect(processReconcileJob(deps, job())).rejects.toThrow()
    // never loaded the working set — bailed at the lock.
    expect(rec.loaded).toHaveLength(0)
    expect(rec.released).toBe(0)
  })
})

describe('processReconcileJob — no candidates / null tone', () => {
  it('skips the live-fact pull when retrieval returns no candidates, defaults tone to ""', async () => {
    // No candidates → mint-only plan (no match to dangle), no facts pulled,
    // null world summary → worldTone defaults to ''.
    const mintPlan = validPlan({
      entities: [
        { op: 'mint', subjectName: 'the duke', canonEntityId: null, name: 'Duke Aldric', entityType: 'npc', accessLevel: 'known' },
      ],
    })
    const { deps, rec } = makeDeps({ candidates: [], plan: mintPlan, worldTone: null })

    await processReconcileJob(deps, job())

    expect(rec.listCalls).toBe(0) // no candidate ids → no fact pull
    expect(rec.reconcilerCalls[0]?.worldTone).toBe('') // null summary → ''
    expect(rec.committedArgs).toHaveLength(1)
    expect(rec.cleared).toEqual([CAMPAIGN])
  })
})

describe('renderWorkingSet (pure)', () => {
  it('renders objective + attributed provenance and a parentName', () => {
    const out = renderWorkingSet([
      wsItem({ subjectName: 'the gate', content: 'The gate is open.' }),
      wsItem({
        subjectName: 'the duke',
        content: 'The duke claims innocence.',
        provenance: { kind: 'attributed', npcEntityId: 'e-duke', npcName: 'Duke Aldric' },
      }),
      wsItem({ kind: 'entity', subjectName: 'the guild', content: 'A guild.', parentName: 'the city' }),
    ])
    expect(out).toContain('provenance=objective')
    expect(out).toContain('attributed (by Duke Aldric)')
    expect(out).toContain('parent=the city')
    expect(out).toContain('subject="the gate"')
  })

  it('renders dice-earned provenance with its outcome tier (myth-g4hf3 canon-on-grant reaches the reconciler)', () => {
    const out = renderWorkingSet([
      wsItem({
        subjectName: 'the sliver',
        content: 'Sable holds a stone sliver.',
        provenance: { kind: 'dice_outcome', outcomeTier: 'great_success' },
      }),
    ])
    expect(out).toContain(
      'dice-earned (great_success on a resolved roll — canon-on-grant; the world conforms to it)',
    )
  })
})

describe('renderCandidates (pure)', () => {
  it('renders the empty-candidates sentinel', () => {
    expect(renderCandidates([], [])).toBe('(no canon candidates)')
  })

  it('renders a candidate with live facts and one with none', () => {
    const out = renderCandidates([candidate(), candidate({ entityId: 'e-gate', name: 'The Gate' })], [
      liveFact({ id: 'f-1', entityId: 'e-duke', content: 'cordial' }),
    ])
    expect(out).toContain('factId=f-1')
    expect(out).toContain('name="Duke Aldric"')
    expect(out).toContain('(no live facts)') // e-gate has none
  })
})
