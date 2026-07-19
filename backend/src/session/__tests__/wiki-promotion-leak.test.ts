// backend/src/session/__tests__/wiki-promotion-leak.test.ts
//
// MYT-74c — the enforced-ignorance LEAK / TIER-PROMOTION matrix for the campaign
// wiki + reconcile-time tier promotion. MYT-74c adds two coupled surfaces to the
// end-of-session reconciler: (1) the reconciler PLAN may carry a `promotions`
// list — live discoverable/secret canon fact ids the party DISCOVERED this
// session, which the commit flips up to `known` (a metadata-only tier bump, no
// supersede/re-embed); (2) a member-readable narrow `known`-tier projection
// (campaignWikiView) serves the campaign wiki.
//
// Enforced ignorance is the hard boundary here. A secret only PROMOTES when a
// working-set item matches it (and a secret only enters the working set when the
// ST sanctioned the reveal), so an UNTOUCHED secret must stay `secret`. The wiki
// is `known`-only, no-bypass, member-scoped, narrow (no owner `concept`, no prose
// kernels, no stat blocks). Each case below proves one link holds,
// DETERMINISTICALLY; the real-Opus / real-Voyage QUALITY (the reconciler actually
// promotes the matched facts and only those) is proven separately by the gated
// real-LLM smoke (myt-74c-promotion-smoke).
//
// Mirrors reconcile-leak.test.ts (MYT-74a): ONE unmistakable SECRET sentinel
// checked in every assertion, break-it-to-prove-it (an untouched secret is NOT
// promoted, the wiki NEVER surfaces it), guardTestDatabase + createTestPool +
// makeTestScope / cleanupTestScope for the real-PG read/write cases.
//
// The four links, each proven by a case:
//   (a) DANGLING PROMOTION rejected. A plan whose promotions[] id is not a live
//       canon fact → validateReconcilePlan returns {ok:false,
//       reason:'dangling_promotion'} (NOT committed).
//   (b) MATCHED PROMOTION commits, UNTOUCHED SECRET stays (real PG). A plan that
//       promotes a matched discoverable fact flips that fact + its entity to
//       `known`; an untouched secret fact + its entity stay `secret`.
//   (c) WIKI REFLECTS + NEVER LEAKS (real PG). After (b)'s commit, the campaign
//       wiki includes the now-known fact + entity, EXCLUDES the secret fact +
//       entity, has no `concept` / `proseKernels` / `statBlocks`, and the SECRET
//       sentinel appears NOWHERE in the serialized wiki.
//   (d) STRUCTURAL-ONLY LOG SURFACE. Drive processReconcileJob with injected
//       fakes on a plan whose promotions carries a live SECRET-content fact →
//       the reconcile_committed log carries `promotions` as a COUNT, and neither
//       the SECRET sentinel nor the promoted fact id appears in ANY logger arg.
//       Plus a dangling_promotion reject: a STRUCTURAL reason + counts, no SECRET.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo, type Repo } from '../../repo/index.js'
import { campaignWikiView } from '../../repo/campaign-wiki-view.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

import { validateReconcilePlan, type ValidateCtx } from '../reconcile/validate.js'
import { applyReconcileCommit } from '../reconcile/commit.js'
import {
  processReconcileJob,
  type ReconcileProcessorDeps,
  type ReconcileJobPayload,
} from '../session-reconcile.js'
import type { ReconcilePlan } from '../../llm/schemas/session-reconcile.js'
import type { SessionReconcilerOutput } from '../../llm/session-reconciler.js'
import type { WorkingSetItem } from '../working-set/types.js'
import type { FactRow } from '../../repo/facts.js'
import type { EntityCandidate } from '../../world/retrieval/types.js'
import type { Session } from '../../repo/types.js'

// The ONE unmistakable SECRET sentinel every leak assertion checks. If this exact
// string surfaces in the campaign wiki, a promoted/untouched-secret fact, or any
// log argument, a core secret leaked across the enforced-ignorance boundary.
const SECRET = 'XYZZY-CABAL-SENTINEL'

// A secret-tier fact body the canon carries — the prose that must never reach the
// player wiki and never ride a log/reject surface.
const SECRET_CONTENT =
  `CORE SECRET: the harbourmaster is ${SECRET}, the deposed heir bound to the ` +
  `Obsidian Cabal. Never reveal to players.`

const databaseUrl = process.env.DATABASE_URL ?? ''

// ---------------------------------------------------------------------------
// Plan / working-set / ctx builders (mirror reconcile-leak.test.ts). Every case
// is "a valid plan, mutated at exactly one seam" so a schema drift surfaces here.
// Note the builders already carry `promotions: []` — the MYT-74c seam.
// ---------------------------------------------------------------------------

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
// (a) dangling-promotion rejected — the structural chokepoint.
//
// A promotions[] id that is not a live canon fact (the reconciler hallucinated
// it, or it points at a non-live row) is the structural breach the validator
// catches: validateReconcilePlan returns {ok:false, reason:'dangling_promotion'}
// (NOT committed), and the reject reason is a STRUCTURAL CODE ONLY.
// ===========================================================================

describe('MYT-74c wiki/promotion leak matrix — (a) dangling promotion rejected', () => {
  it('a promotions id not in liveFactIds → {ok:false, reason:dangling_promotion}', () => {
    const result = validateReconcilePlan(
      plan({ promotions: ['ghost'] }),
      ctx({ liveFactIds: new Set<string>(['live-fact-1']) }),
    )
    expect(result).toEqual({ ok: false, reason: 'dangling_promotion' })
    // The reject reason is a STRUCTURAL CODE ONLY — no id, no prose rides it.
    expect(JSON.stringify(result)).not.toContain('ghost')
  })

  it('a promotions id IN liveFactIds passes — proving the reject is not vacuous', () => {
    const result = validateReconcilePlan(
      plan({ promotions: ['live-fact-1'] }),
      ctx({ liveFactIds: new Set<string>(['live-fact-1']) }),
    )
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// (b) + (c) real-PG cases. Scoped fixtures over mythrun_test; the LLM is never
// touched (the commit + wiki read are pure deterministic code).
// ===========================================================================

interface Seed {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly sessionId: string
  readonly discEntityId: string
  readonly discFactId: string
  readonly secretEntityId: string
  readonly secretFactId: string
}

describe('MYT-74c wiki/promotion leak matrix — real PG (commit promotion + wiki projection)', () => {
  let pool: Pool
  let repo: Repo
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    repo = createRepo(pool)
    scope = makeTestScope('wiki-promotion-leak')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  /** Seed user → world → campaign → session + a discoverable entity/fact (the
   *  promotion target) AND a secret entity/fact (the untouched over-promotion
   *  guard; its content carries the SECRET sentinel). */
  async function seed(): Promise<Seed> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const discEntityId = uuidv7()
    const secretEntityId = uuidv7()
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
    if (campaignId === undefined) throw new Error('campaign insert returned no id')
    const sess = await pool.query<{ id: string }>(
      `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'active') RETURNING id`,
      [uuidv7(), campaignId],
    )
    const sessionId = sess.rows[0]?.id
    if (sessionId === undefined) throw new Error('session insert returned no id')

    // The DISCOVERABLE entity + fact — the promotion target.
    await repo.entities.insert({
      id: discEntityId,
      worldId,
      entityType: 'npc',
      name: 'The Harbourmaster',
      accessLevel: 'discoverable',
      createdIn: 'stage:test',
    })
    const discFactId = await repo.facts.insertReconciled({
      entityId: discEntityId,
      topic: 'role',
      content: 'The harbourmaster keeps a ledger of every ship that docks.',
      accessLevel: 'discoverable',
    })

    // The SECRET entity + fact — the untouched over-promotion guard.
    await repo.entities.insert({
      id: secretEntityId,
      worldId,
      entityType: 'faction',
      name: 'The Obsidian Cabal',
      accessLevel: 'secret',
      createdIn: 'stage:test',
    })
    const secretFactId = await repo.facts.insertReconciled({
      entityId: secretEntityId,
      topic: 'membership',
      content: SECRET_CONTENT,
      accessLevel: 'secret',
    })

    return {
      userId,
      worldId,
      campaignId,
      sessionId,
      discEntityId,
      discFactId,
      secretEntityId,
      secretFactId,
    }
  }

  // -------------------------------------------------------------------------
  // (b) commit promotes a matched discoverable fact + its entity; an untouched
  // secret stays secret (the over-promotion guard).
  // -------------------------------------------------------------------------

  it('(b) commit flips a promoted discoverable fact + its entity to known; an untouched secret stays secret', async () => {
    const s = await seed()

    const result = await applyReconcileCommit(repo, {
      plan: { entities: [], facts: [], relationships: [], promotions: [s.discFactId] },
      map: new Map(),
      workingSet: [],
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings: [],
    })
    expect(result).toEqual({ committed: true })

    // The promoted fact reads back `known`...
    const discKnown = await repo.facts.listByEntities([s.discEntityId], { accessLevels: ['known'] })
    expect(discKnown.map((f) => f.id)).toContain(s.discFactId)
    // ...and so does its owning entity (entity-follows-fact).
    const discEntity = await repo.entities.findByWorldAndName(s.worldId, 'The Harbourmaster')
    expect(discEntity?.accessLevel).toBe('known')

    // The UNTOUCHED secret fact + entity stay `secret` (never over-promoted).
    const secretKnown = await repo.facts.listByEntities([s.secretEntityId], { accessLevels: ['known'] })
    expect(secretKnown).toHaveLength(0)
    const secretStill = await repo.facts.listByEntities([s.secretEntityId], { accessLevels: ['secret'] })
    expect(secretStill.map((f) => f.id)).toContain(s.secretFactId)
    const secretEntity = await repo.entities.findByWorldAndName(s.worldId, 'The Obsidian Cabal')
    expect(secretEntity?.accessLevel).toBe('secret')
  })

  // -------------------------------------------------------------------------
  // (c) the wiki reflects the promotion and never leaks the untouched secret.
  // -------------------------------------------------------------------------

  it('(c) the campaign wiki surfaces the promoted fact, EXCLUDES the secret, and leaks the SECRET nowhere', async () => {
    const s = await seed()

    // Same promotion commit as (b).
    const committed = await applyReconcileCommit(repo, {
      plan: { entities: [], facts: [], relationships: [], promotions: [s.discFactId] },
      map: new Map(),
      workingSet: [],
      worldId: s.worldId,
      sessionId: s.sessionId,
      factEmbeddings: [],
    })
    expect(committed).toEqual({ committed: true })

    const wiki = await campaignWikiView.fetch(pool, s.worldId)

    // The now-known discoverable fact + its entity ARE present.
    expect(wiki.facts.map((f) => f.id)).toContain(s.discFactId)
    expect(wiki.entities.map((e) => e.id)).toContain(s.discEntityId)

    // The untouched secret fact + entity are ABSENT (the wiki is known-only).
    expect(wiki.facts.map((f) => f.id)).not.toContain(s.secretFactId)
    expect(wiki.entities.map((e) => e.id)).not.toContain(s.secretEntityId)

    // The narrow world projection has NO `concept` (owner-only plot seed)...
    expect('concept' in wiki.world).toBe(false)
    // ...and the wiki body carries no prose kernels / stat blocks (owner content).
    expect('proseKernels' in wiki).toBe(false)
    expect('statBlocks' in wiki).toBe(false)

    // ENFORCED IGNORANCE: the SECRET sentinel appears NOWHERE in the serialized
    // wiki — not via a promoted-fact echo, not via a relationship, not anywhere.
    expect(JSON.stringify(wiki)).not.toContain(SECRET)
  })
})

// ===========================================================================
// (d) structural-only log surface — the enforced-ignorance proof on the worker.
//
// Drive the REAL processReconcileJob with INJECTED recording-fake deps (no
// broker/PG/LLM). One case promotes a LIVE SECRET-content candidate fact (the
// happy path): the reconcile_committed log must carry `promotions` as a COUNT
// and NEITHER the SECRET sentinel NOR the promoted fact id may reach any logger
// argument. A second case drives a dangling_promotion reject: a STRUCTURAL
// reason + counts, the processor THROWS, and no SECRET rides the log.
// ===========================================================================

const CAMPAIGN = 'c-wiki-promo-leak-1'
const SESSION = 's-wiki-promo-leak-1'
const WORLD = 'w-wiki-promo-leak-1'

// A live candidate entity + its secret-content live fact. The working set carries
// a matching item so the promotion is sanctioned; the plan promotes the fact id.
const CANDIDATE_ENTITY_ID = 'cand-entity-1'
const LIVE_SECRET_FACT_ID = 'live-secret-fact-1'

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

function candidate(): EntityCandidate {
  return {
    entityId: CANDIDATE_ENTITY_ID,
    name: 'The Harbourmaster',
    entityType: 'npc',
    score: 0.9,
  }
}

/** The one live canon fact the candidate owns — secret-tier, SECRET-bearing. The
 *  working-set match makes promoting it legitimate; its id is what the plan
 *  promotes, so it must NOT appear in any log. */
function liveSecretFact(): FactRow {
  return {
    id: LIVE_SECRET_FACT_ID,
    entityId: CANDIDATE_ENTITY_ID,
    topic: 'membership',
    accessLevel: 'secret',
    narrativeStatus: 'delivered',
    content: SECRET_CONTENT,
    source: 'prep',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function reconcilerOut(p: ReconcilePlan): SessionReconcilerOutput {
  return {
    result: p,
    usage: { totalTokens: 500 } as unknown as SessionReconcilerOutput['usage'],
    repairAttempted: false,
  }
}

interface ProbeDepsResult {
  deps: ReconcileProcessorDeps
  committedCount: () => number
}

/** processReconcileJob deps with the REAL validator + an injected reconciler
 *  returning `planFn()`. findSimilarEntities yields the secret-bearing candidate
 *  and facts.listByEntities yields its live secret fact, so the live-fact set
 *  contains LIVE_SECRET_FACT_ID — making a promotion of it pass the validator.
 *  The working set carries a matching item (the ST-sanctioned surfacing). */
function makeProbeDeps(planFn: () => ReconcilePlan): ProbeDepsResult {
  let committed = 0
  const deps: ReconcileProcessorDeps = {
    repo: {
      sessions: { getById: () => Promise.resolve(session()) },
      facts: { listByEntities: () => Promise.resolve([liveSecretFact()]) },
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
    findSimilarEntities: () => Promise.resolve([candidate()]),
    embedder: { embedDocuments: (texts) => Promise.resolve(texts.map(() => [0, 1, 2])) },
    runReconciler: () => Promise.resolve(reconcilerOut(planFn())),
    applyCommit: () => {
      committed += 1
      return Promise.resolve({ committed: true })
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { deps, committedCount: () => committed }
}

function probeJob(): { data: ReconcileJobPayload } {
  return { data: { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD } }
}

/** Concatenate every argument passed to a vi.fn logger method into one string. */
function loggerCallsToString(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls.map((args) => JSON.stringify(args)).join(' ')
}

describe('MYT-74c wiki/promotion leak matrix — (d) the worker log surface carries counts, never secrets', () => {
  it('a committed promotion logs `promotions` as a COUNT and leaks neither the SECRET nor the fact id', async () => {
    // A plan that promotes the LIVE secret-content fact (validator-legal: the id
    // is in liveFactIds and the working-set item matches the subject).
    const { deps, committedCount } = makeProbeDeps(() => plan({ promotions: [LIVE_SECRET_FACT_ID] }))

    await processReconcileJob(deps, probeJob())

    // The commit ran (the plan validated) — exactly once.
    expect(committedCount()).toBe(1)

    // reconcile_committed WAS logged, carrying `promotions` as a COUNT (= 1).
    const infoMock = deps.logger.info as ReturnType<typeof vi.fn>
    expect(infoMock).toHaveBeenCalled()
    const committedCall = infoMock.mock.calls.find((args) => args[1] === 'reconcile_committed')
    expect(committedCall).toBeDefined()
    const committedArg = committedCall?.[0] as Record<string, unknown>
    expect(committedArg.promotions).toBe(1)

    // ENFORCED IGNORANCE: neither the SECRET sentinel NOR the promoted fact id
    // appears in ANY logger argument across all three methods.
    const allInfo = loggerCallsToString(deps.logger.info as ReturnType<typeof vi.fn>)
    const allWarn = loggerCallsToString(deps.logger.warn as ReturnType<typeof vi.fn>)
    const allErr = loggerCallsToString(deps.logger.error as ReturnType<typeof vi.fn>)
    for (const surface of [allInfo, allWarn, allErr]) {
      expect(surface).not.toContain(SECRET)
      expect(surface).not.toContain(LIVE_SECRET_FACT_ID)
    }
  })

  it('a dangling promotion logs a STRUCTURAL reason + counts, THROWS, never commits, leaks no SECRET', async () => {
    // A plan promoting an id that is NOT a live candidate fact → dangling_promotion.
    // Its content does not ride the reject, but a SECRET-bearing fact is in the
    // live set, so we still assert the SECRET appears nowhere on the reject surface.
    const { deps, committedCount } = makeProbeDeps(() => plan({ promotions: ['ghost-fact-id'] }))

    let caught: unknown
    try {
      await processReconcileJob(deps, probeJob())
    } catch (err) {
      caught = err
    }

    // The processor THREW (so BullMQ retries the non-deterministic Opus call)...
    expect(caught).toBeInstanceOf(Error)
    // ...and the commit NEVER ran on a rejected plan.
    expect(committedCount()).toBe(0)

    // A STRUCTURAL reason WAS logged on the reject path, carrying op COUNTS.
    const errorMock = deps.logger.error as ReturnType<typeof vi.fn>
    expect(errorMock).toHaveBeenCalled()
    const firstArg = errorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstArg.reason).toBe('dangling_promotion')
    expect(firstArg.promotions).toBe(1)

    // ENFORCED IGNORANCE: the SECRET appears in NO logger argument, and the
    // thrown-error message carries the structural code, not the secret.
    const allInfo = loggerCallsToString(deps.logger.info as ReturnType<typeof vi.fn>)
    const allWarn = loggerCallsToString(deps.logger.warn as ReturnType<typeof vi.fn>)
    const allErr = loggerCallsToString(deps.logger.error as ReturnType<typeof vi.fn>)
    expect(allInfo).not.toContain(SECRET)
    expect(allWarn).not.toContain(SECRET)
    expect(allErr).not.toContain(SECRET)
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toContain('dangling_promotion')
    expect(message).not.toContain(SECRET)
  })
})
