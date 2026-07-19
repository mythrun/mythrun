// backend/src/session/__tests__/reconcile-leak.test.ts
//
// MYT-74a T14 — the §9 enforced-ignorance LEAK / TIER MATRIX for the end-of-
// session reconciler. MYT-74a folds a finished session's working set into
// durable canon: a holistic Opus reconciler PLAN → the structural+policy
// validator (validate.ts) → a transactional multi-substrate commit (commit.ts),
// driven by the reconcile worker (session-reconcile.ts). The validated plan
// holds SECRET prose (the reconciler canonizes secret-tier items AT THEIR TIER),
// so every link of that pipeline is a place a secret — or a tier/attribution
// downgrade — could escape. Each case below proves one link holds,
// DETERMINISTICALLY; the real-Opus / real-Voyage QUALITY is proven separately by
// the gated real-LLM smoke (myt-74a-reconcile-smoke).
//
// Mirrors scribe-leak.test.ts (MYT-73): ONE unmistakable SECRET sentinel checked
// in every assertion, break-it-to-prove-it (a leaky/downgrading input is CAUGHT,
// a clean one passes), guardTestDatabase + createTestPool + makeTestScope /
// cleanupTestScope for the real-PG read/write cases.
//
// The five links, each proven by a case:
//   (a) TIER DOWNGRADE rejected. A plan that downgrades a secret-tier working-set
//       item's fact to accessLevel:'known' → validateReconcilePlan returns
//       {ok:false, reason:'tier_downgrade'}; a same-or-stronger tier passes.
//   (b) ATTRIBUTION DROPPED rejected. A plan where an attributed item's fact has
//       claimedBy:null → {ok:false, reason:'attribution_dropped'}; an objective
//       item passes.
//   (c) LOG-SURFACE REDACTION. Drive processReconcileJob with an injected
//       runReconciler returning a secret-bearing plan that FAILS validation (a
//       tier downgrade whose fact.content is the SECRET) → the processor THROWS,
//       logger.error WAS called, and NO logger argument / thrown-error message
//       carries the SECRET — only the structural reason code. (The load-bearing
//       enforced-ignorance proof: the validated plan holds secret prose; the
//       reject must not leak it to logs / alerts.)
//   (d) READ-PATH FILTER (real PG). A superseded fact is absent from searchFacts,
//       facts.listByEntities (default liveOnly), listFactsToEmbed, and
//       worldInventory.load — and PRESENT in listByEntities({liveOnly:false}).
//   (e) TIER PRESERVED ON COMMIT (real PG). A plan minting an entity + a
//       secret-tier fact, committed via applyReconcileCommit, reads back
//       access_level='secret' (never downgraded).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { worldRetrievalNs } from '../../repo/world-retrieval.js'
import { worldInventoryNs } from '../../repo/world-inventory.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

import { validateReconcilePlan, type ValidateCtx, type SubjectResolution } from '../reconcile/validate.js'
import { applyReconcileCommit } from '../reconcile/commit.js'
import {
  processReconcileJob,
  type ReconcileProcessorDeps,
  type ReconcileJobPayload,
} from '../session-reconcile.js'
import type { ReconcilePlan } from '../../llm/schemas/session-reconcile.js'
import type { SessionReconcilerOutput } from '../../llm/session-reconciler.js'
import type { WorkingSetItem } from '../working-set/types.js'
import type { Session } from '../../repo/types.js'

// The ONE unmistakable SECRET sentinel every leak assertion checks. If this
// exact string surfaces in a reject reason / a log argument / a thrown-error
// message / a downgraded committed fact, a core secret (or its tier) leaked.
const SECRET = 'XYZZY-RECONCILE-SECRET-c0ffee'

// A secret-bearing fact body the reconciler plan carries — the prose that must
// stay out of every alert/log surface on a reject.
const SECRET_CONTENT =
  `CORE SECRET: the harbourmaster is ${SECRET}, the deposed heir, bound to the ` +
  `Obsidian Cabal. Never reveal to players.`

const databaseUrl = process.env.DATABASE_URL ?? ''
const VECTOR_DIMS = 512

// ---------------------------------------------------------------------------
// Plan / working-set / ctx builders (mirror validate.test.ts). Every case is "a
// valid plan, mutated at exactly one seam" so a schema drift surfaces here.
// ---------------------------------------------------------------------------

function entityOp(o: Partial<ReconcilePlan['entities'][number]> = {}): ReconcilePlan['entities'][number] {
  return {
    op: 'mint',
    subjectName: 'the harbourmaster',
    canonEntityId: null,
    name: 'The Harbourmaster',
    entityType: 'npc',
    accessLevel: 'known',
    ...o,
  }
}

function factOp(o: Partial<ReconcilePlan['facts'][number]> = {}): ReconcilePlan['facts'][number] {
  return {
    subjectName: 'the harbourmaster',
    topic: 'role',
    content: 'A weathered figure who keeps the dock ledgers.',
    accessLevel: 'known',
    claimedBy: null,
    supersedesFactId: null,
    ...o,
  }
}

function wsItem(o: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    kind: 'fact',
    content: 'ws content',
    subjectName: 'the harbourmaster',
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
    id: 'ws-1',
    turnId: 'turn-1',
    embedding: [],
    ...o,
  }
}

function plan(o: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return { entities: [], facts: [], relationships: [], promotions: [], ...o }
}

function ctx(o: Partial<ValidateCtx> = {}): ValidateCtx {
  return {
    workingSet: [],
    liveCandidateEntityIds: new Set<string>(),
    liveFactIds: new Set<string>(),
    ...o,
  }
}

// ===========================================================================
// (a) tier-downgrade rejected — and a same-or-stronger tier passes.
//
// A plan whose fact downgrades a secret-tier working-set item to 'known' is the
// classic enforced-ignorance breach: a secret canonized as a player-known fact.
// The validator is the mechanical chokepoint (the explicit ZFC policy exception)
// — it returns {ok:false, reason:'tier_downgrade'} (NOT committed).
// ===========================================================================

describe('MYT-74a T14 leak matrix — (a) tier-downgrade rejected', () => {
  it('a plan downgrading a secret-tier item to known → {ok:false, reason:tier_downgrade}, never leaking the secret', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'the harbourmaster' })],
      // The fact carries the SECRET content AND downgrades the tier (known < secret).
      facts: [factOp({ subjectName: 'the harbourmaster', accessLevel: 'known', content: SECRET_CONTENT })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'the harbourmaster', tier: 'secret', content: SECRET_CONTENT })] }),
    )
    expect(result).toEqual({ ok: false, reason: 'tier_downgrade' })
    // The reject reason is a STRUCTURAL CODE ONLY — the secret never rides it.
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('a same-or-stronger tier passes (secret fact, discoverable item) — proving the reject is not vacuous', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'the harbourmaster', accessLevel: 'secret' })],
      facts: [factOp({ subjectName: 'the harbourmaster', accessLevel: 'secret', content: SECRET_CONTENT })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'the harbourmaster', tier: 'discoverable' })] }),
    )
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// (b) attribution-dropped rejected — and an objective item passes.
//
// An attributed working-set item is an NPC CLAIM (may be a lie/rumor). If its
// canonized fact drops the attribution (claimedBy:null) it would elevate a claim
// to objective truth — the validator rejects with 'attribution_dropped'. An
// objective item legitimately carries claimedBy:null and passes.
// ===========================================================================

describe('MYT-74a T14 leak matrix — (b) attribution-dropped rejected', () => {
  it('an attributed item whose fact drops claimedBy → {ok:false, reason:attribution_dropped}, no secret leak', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'the harbourmaster' })],
      facts: [factOp({ subjectName: 'the harbourmaster', claimedBy: null, content: SECRET_CONTENT })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({
        workingSet: [
          wsItem({
            subjectName: 'the harbourmaster',
            content: SECRET_CONTENT,
            provenance: { kind: 'attributed', npcEntityId: 'npc-9', npcName: 'Marsh' },
          }),
        ],
      }),
    )
    expect(result).toEqual({ ok: false, reason: 'attribution_dropped' })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('an objective item with claimedBy:null passes — proving the reject is not vacuous', () => {
    const p = plan({
      entities: [entityOp({ subjectName: 'the harbourmaster' })],
      facts: [factOp({ subjectName: 'the harbourmaster', claimedBy: null })],
    })
    const result = validateReconcilePlan(
      p,
      ctx({ workingSet: [wsItem({ subjectName: 'the harbourmaster', provenance: { kind: 'objective' } })] }),
    )
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// (c) log-surface redaction — the §5(1) enforced-ignorance proof.
//
// Drive the REAL processReconcileJob with INJECTED recording-fake deps (no
// broker/PG/LLM): a fake runReconciler returns a secret-bearing plan that FAILS
// the REAL pure validator (a tier downgrade whose fact.content IS the SECRET).
// The processor must log a STRUCTURAL reason + op COUNTS only, THROW (so BullMQ
// retries the non-deterministic Opus call), NEVER run the commit, and NEVER let
// the SECRET reach any logger argument or the thrown-error message.
// ===========================================================================

const CAMPAIGN = 'c-recon-leak-1'
const SESSION = 's-recon-leak-1'
const WORLD = 'w-recon-leak-1'

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

/** A plan that FAILS validation: the fact downgrades the tier of a secret-tier
 *  working-set item (secret → known) AND its content is the SECRET prose. */
function secretTierDowngradePlan(): ReconcilePlan {
  return {
    promotions: [],
    entities: [
      {
        op: 'mint',
        subjectName: 'the harbourmaster',
        canonEntityId: null,
        name: 'The Harbourmaster',
        entityType: 'npc',
        accessLevel: 'secret',
      },
    ],
    facts: [
      {
        subjectName: 'the harbourmaster',
        topic: 'identity',
        content: SECRET_CONTENT,
        accessLevel: 'known', // downgrade: the ws item is `secret`
        claimedBy: null,
        supersedesFactId: null,
      },
    ],
    relationships: [],
  }
}

function reconcilerOut(p: ReconcilePlan): SessionReconcilerOutput {
  return {
    result: p,
    usage: { totalTokens: 500 } as unknown as SessionReconcilerOutput['usage'],
    repairAttempted: false,
  }
}

interface LeakDepsResult {
  deps: ReconcileProcessorDeps
  committedCount: () => number
}

/** processReconcileJob deps with the REAL validator and an injected reconciler
 *  returning the secret-bearing downgrade plan. applyCommit records calls so we
 *  can assert it NEVER runs on a reject. The secret-tier working-set item makes
 *  the real validator fire `tier_downgrade`. */
function makeLeakDeps(): LeakDepsResult {
  let committed = 0
  const deps: ReconcileProcessorDeps = {
    repo: {
      sessions: { getById: () => Promise.resolve(session()) },
      facts: { listByEntities: () => Promise.resolve([]) },
      entities: { findIdByWorldAndNormalizedName: () => Promise.resolve(null) },
    worlds: { getSnapshotSummary: () => Promise.resolve({ tone: 'grim and rain-soaked' }) },
      transaction: () => Promise.reject(new Error('transaction must not be called directly')),
    },
    workingSet: {
      load: () =>
        Promise.resolve([
          wsItem({ subjectName: 'the harbourmaster', tier: 'secret', content: SECRET_CONTENT }),
        ]),
      clear: () => Promise.resolve(),
    },
    lock: {
      tryAcquire: () =>
        Promise.resolve({
          token: 'tok',
          extend: () => Promise.resolve(true),
          release: () => Promise.resolve(),
        }),
    },
    // No candidates → no live-fact pull; the working-set secret-tier item is what
    // makes the real validator fire tier_downgrade.
    findSimilarEntities: () => Promise.resolve([]),
    embedder: { embedDocuments: (texts) => Promise.resolve(texts.map(() => [0, 1, 2])) },
    runReconciler: () => Promise.resolve(reconcilerOut(secretTierDowngradePlan())),
    applyCommit: () => {
      committed += 1
      return Promise.resolve({ committed: true })
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { deps, committedCount: () => committed }
}

function leakJob(): { data: ReconcileJobPayload } {
  return { data: { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD } }
}

/** Concatenate every argument passed to a vi.fn logger method into one string. */
function loggerCallsToString(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls.map((args) => JSON.stringify(args)).join(' ')
}

describe('MYT-74a T14 leak matrix — (c) a secret-bearing validation reject never reaches the log surface', () => {
  it('logs a STRUCTURAL reason + counts, THROWS, never commits, and leaks the SECRET nowhere', async () => {
    const { deps, committedCount } = makeLeakDeps()

    let caught: unknown
    try {
      await processReconcileJob(deps, leakJob())
    } catch (err) {
      caught = err
    }

    // The processor THREW (so BullMQ retries the non-deterministic Opus call).
    expect(caught).toBeInstanceOf(Error)
    // The commit NEVER ran on a rejected plan.
    expect(committedCount()).toBe(0)

    // A STRUCTURAL reason WAS logged (the worker's reject-log on §7).
    const errorMock = deps.logger.error as ReturnType<typeof vi.fn>
    expect(errorMock).toHaveBeenCalled()
    const firstArg = errorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstArg.reason).toBe('tier_downgrade')
    // It logs op COUNTS, not content.
    expect(firstArg.entityOps).toBe(1)
    expect(firstArg.factOps).toBe(1)

    // ENFORCED IGNORANCE: the SECRET appears in NO logger argument, across all
    // three methods — only the structural reason code does.
    const allErr = loggerCallsToString(deps.logger.error as ReturnType<typeof vi.fn>)
    const allInfo = loggerCallsToString(deps.logger.info as ReturnType<typeof vi.fn>)
    const allWarn = loggerCallsToString(deps.logger.warn as ReturnType<typeof vi.fn>)
    expect(allErr).not.toContain(SECRET)
    expect(allInfo).not.toContain(SECRET)
    expect(allWarn).not.toContain(SECRET)

    // ...and the thrown-error message carries the structural code, not the secret.
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toContain('tier_downgrade')
    expect(message).not.toContain(SECRET)
  })
})

// ===========================================================================
// (d) + (e) real-PG cases. Scoped fixtures over mythrun_test; the LLM is never
// touched (commit + read paths are pure deterministic code).
// ===========================================================================

interface Seed {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly sessionId: string
  readonly entityId: string
}

describe('MYT-74a T14 leak matrix — real PG (read-path filter + tier preserved on commit)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('reconcile-leak')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  /** Seed user → world → campaign → session + one canon entity. */
  async function seed(): Promise<Seed> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const entityId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, userId, scope.worldName(0)],
    )
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [uuidv7(), worldId, userId, scope.campaignName(0)],
    )
    const campaignId = campaign.rows[0]?.id
    if (!campaignId) throw new Error('campaign insert returned no id')
    const sess = await pool.query<{ id: string }>(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active') RETURNING id`,
      [uuidv7(), campaignId],
    )
    const sessionId = sess.rows[0]?.id
    if (!sessionId) throw new Error('session insert returned no id')

    await repo.entities.insert({
      id: entityId,
      worldId,
      entityType: 'npc',
      name: 'The Harbourmaster',
      accessLevel: 'known',
      createdIn: 'stage:test',
    })
    return { userId, worldId, campaignId, sessionId, entityId }
  }

  /** A unit embedding (a 1 at `axis`, else 0) as the pgvector text literal. */
  function unitVectorLiteral(axis: number): string {
    const v = new Array<number>(VECTOR_DIMS).fill(0)
    v[axis] = 1
    return `[${v.join(',')}]`
  }

  // -------------------------------------------------------------------------
  // (d) read-path filter: a superseded fact is hidden from every live read path
  // and present only in the full append-only log.
  // -------------------------------------------------------------------------

  it('(d) a superseded fact is absent from searchFacts / listByEntities(liveOnly) / listFactsToEmbed / worldInventory, present in liveOnly:false', async () => {
    const s = await seed()

    // A LIVE fact + a fact that will be superseded — both embedded so searchFacts
    // could surface them (it filters on embedding IS NOT NULL).
    const liveFactId = await repo.facts.insertReconciled({
      entityId: s.entityId,
      topic: 'role',
      content: 'The harbourmaster keeps the dock ledgers.',
      accessLevel: 'known',
    })
    const supersededFactId = await repo.facts.insertReconciled({
      entityId: s.entityId,
      topic: 'rumor',
      content: 'The harbourmaster is rumoured to be in debt.',
      accessLevel: 'known',
    })
    await repo.facts.updateEmbedding(liveFactId, unitVectorLiteral(0))
    await repo.facts.updateEmbedding(supersededFactId, unitVectorLiteral(1))

    // The supersede correction: the replacement fact + setSuperseded (which NULLs
    // the dead row's embedding so it drops out of the HNSW index).
    const replacementId = await repo.facts.insertReconciled({
      entityId: s.entityId,
      topic: 'rumor',
      content: 'The harbourmaster cleared every debt this spring.',
      accessLevel: 'known',
    })
    await repo.facts.updateEmbedding(replacementId, unitVectorLiteral(1))
    const marked = await repo.facts.setSuperseded(supersededFactId, replacementId)
    expect(marked).toBe(1)

    // searchFacts: a query vector along axis 1 (the superseded fact's axis). The
    // superseded row is gone (superseded_by IS NULL filter + NULLed embedding);
    // the replacement (also axis 1) IS surfaced.
    const hits = await worldRetrievalNs(pool).searchFacts(s.worldId, unitVectorLiteral(1), 10)
    const hitIds = hits.map((h) => h.fact_id)
    expect(hitIds).not.toContain(supersededFactId)
    expect(hitIds).toContain(replacementId)

    // listByEntities (default liveOnly): superseded absent, live + replacement present.
    const live = await repo.facts.listByEntities([s.entityId], { accessLevels: ['known'] })
    const liveIds = live.map((f) => f.id)
    expect(liveIds).not.toContain(supersededFactId)
    expect(liveIds).toContain(liveFactId)
    expect(liveIds).toContain(replacementId)

    // listFactsToEmbed (now superseded_by IS NULL): never re-embeds dead canon.
    const toEmbed = await worldRetrievalNs(pool).listFactsToEmbed(s.worldId, true)
    expect(toEmbed.map((f) => f.id)).not.toContain(supersededFactId)

    // worldInventory.load (the prep/coherence reader): superseded hidden.
    const inv = await worldInventoryNs(pool).load(s.worldId)
    expect(inv.factsById.has(supersededFactId)).toBe(false)
    expect(inv.factsById.has(replacementId)).toBe(true)

    // POSITIVE CONTROL: the full append-only log DOES carry the superseded row.
    const all = await repo.facts.listByEntities([s.entityId], { accessLevels: ['known'], liveOnly: false })
    expect(all.map((f) => f.id)).toContain(supersededFactId)
  })

  // -------------------------------------------------------------------------
  // (e) tier preserved on commit: a secret-tier fact minted by the reconciler is
  // committed AT its tier — never downgraded by the commit path.
  // -------------------------------------------------------------------------

  it('(e) a secret-tier fact minted by a validated plan reads back access_level=secret', async () => {
    const s = await seed()

    // A plan minting a NEW entity + a secret-tier fact, with a matching secret-tier
    // working-set item (so the validator's tier floor passes, not downgrades).
    const p: ReconcilePlan = {
      promotions: [],
      entities: [
        {
          op: 'mint',
          subjectName: 'the cabal',
          canonEntityId: null,
          name: 'The Obsidian Cabal',
          entityType: 'faction',
          accessLevel: 'secret',
        },
      ],
      facts: [
        {
          subjectName: 'the cabal',
          topic: 'membership',
          content: SECRET_CONTENT,
          accessLevel: 'secret',
          claimedBy: null,
          supersedesFactId: null,
        },
      ],
      relationships: [],
    }
    const workingSet: readonly WorkingSetItem[] = [
      wsItem({ kind: 'entity', subjectName: 'the cabal', tier: 'secret', content: SECRET_CONTENT }),
    ]

    // Run the REAL validator → it must pass (secret fact, secret item — no floor
    // violation) and return the resolution map the commit binds.
    const v = validateReconcilePlan(p, {
      workingSet,
      liveCandidateEntityIds: new Set<string>(),
      liveFactIds: new Set<string>(),
    })
    expect(v.ok).toBe(true)
    if (!v.ok) throw new Error('expected the secret-tier plan to validate')
    const map: ReadonlyMap<string, SubjectResolution> = v.map

    const result = await applyReconcileCommit(repo, {
      plan: p,
      map,
      workingSet,
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings: [[]], // skip the embed for the single fact
    })
    expect(result).toEqual({ committed: true })

    // The minted entity is secret-tier; its committed fact reads back secret.
    const cabal = await repo.entities.findByWorldAndName(s.worldId, 'The Obsidian Cabal')
    if (!cabal) throw new Error('expected the minted cabal entity')
    expect(cabal.accessLevel).toBe('secret')

    const secretFacts = await repo.facts.listByEntities([cabal.id], { accessLevels: ['secret'] })
    expect(secretFacts).toHaveLength(1)
    expect(secretFacts[0]?.accessLevel).toBe('secret')
    // The fact was NEVER surfaced at a weaker tier (the downgrade the validator
    // exists to prevent did not slip through the commit).
    const known = await repo.facts.listByEntities([cabal.id], { accessLevels: ['known'] })
    expect(known).toHaveLength(0)
    const discoverable = await repo.facts.listByEntities([cabal.id], { accessLevels: ['discoverable'] })
    expect(discoverable).toHaveLength(0)
  })
})
