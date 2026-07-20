// backend/src/session/session-reconcile.ts
//
// MYT-74a T10 — the END-OF-SESSION RECONCILE worker. The orchestration that folds
// a live session's improvised working set into durable canon. It is the keystone
// tying Wave A–C together: load the working set (MYT-73) → retrieve canon
// candidates (MYT-71/72) → render → reconcile (Opus, T3) → validate (PURE,
// security-critical, T4) → embed (Voyage) → commit (one tx, gated, T9).
//
// NOT TOTAL (unlike the post-turn Scribe job): this processor THROWS on transient
// failure so BullMQ RETRIES. A retry is idempotent — the working set stays
// uncleared and `reconciled_at` stays unset until a commit wins the §4 gate, so a
// re-run that reaches the commit either wins (first execution) or no-ops
// (committed:false, a concurrent execution already reconciled). The attempts cap
// bounds a persistently-failing non-deterministic Opus call.
//
// ENFORCED IGNORANCE (load-bearing): the reconcile plan carries SECRET prose
// (the reconciler canonizes secret-tier working-set items AT THEIR TIER). The
// validator's reject `reason` is a STRUCTURAL CODE ONLY; this worker logs that
// code + op COUNTS on a reject — NEVER `fact.content`, never any prose. A reason
// or payload that echoed content would leak the very secret the validator exists
// to protect into the alert/log surface.
//
// worldTone: read through the FT-safe `worlds.getSnapshotSummary` allowlist
// projection (it structurally cannot hold plot columns) — tone is a register hint
// threaded so canonized prose stays in voice, not a plot input.

import { Worker as BullmqWorker, type Job, type Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'

import { createRepo, type Repo } from '../repo/index.js'
import { makeWorkingSetRepo, type WorkingSetRepo } from '../redis/working-set.js'
import { createSessionLock, type SessionLock } from './session-lock.js'
import { createSearchResolvers } from '../world/retrieval/search.js'
import { runSessionReconciler } from '../llm/session-reconciler.js'
import { applyReconcileCommit } from './reconcile/commit.js'
import { validateReconcilePlan } from './reconcile/validate.js'
import type { ReconcilePlan } from '../llm/schemas/session-reconcile.js'
import type { FindSimilarOpts } from '../world/retrieval/search.js'
import type { EntityCandidate } from '../world/retrieval/types.js'
import type { FactRow } from '../repo/facts.js'
import type { VoyageEmbedder } from '../llm/embed.js'
import type { WorkingSetItem } from './working-set/types.js'

/** Per-session lock TTL for a reconcile run. Sized ≥ the worker lockDuration so
 *  the lock outlives the full reconcile → embed → commit critical section even
 *  on a slow Opus call. */
const RECONCILE_LOCK_TTL_MS = 180_000

/** How many similar canon entities to pull per distinct working-set subject. */
const CANDIDATES_PER_SUBJECT = 5

interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

// ── Queue + producer (mirrors scribe-queue.ts) ──────────────────────────────

export const QUEUE_SESSION_RECONCILE = 'session-reconcile' as const
export const RECONCILE_JOB_NAME = 'reconcile' as const

export interface ReconcileJobPayload {
  readonly campaignId: string
  readonly sessionId: string
  readonly worldId: string
}

/** Narrow producer surface (just `add`). */
export interface ReconcileQueueLike {
  add: Queue<ReconcileJobPayload>['add']
}

/** Enqueue ONE end-of-session reconcile job. `jobId` is per-session
 *  (`reconcile-${sessionId}`) so a double-trigger (two close signals for the same
 *  session) COLLAPSES to a single job rather than racing two reconcilers. */
export function enqueueReconcile(
  queue: ReconcileQueueLike,
  payload: ReconcileJobPayload,
): Promise<unknown> {
  return queue.add(RECONCILE_JOB_NAME, payload, { jobId: `reconcile-${payload.sessionId}` })
}

// ── Processor deps (narrow, all injected) ───────────────────────────────────

/** The worker's OWN narrow repo surface. `transaction` is consumed by the
 *  injected commit (passed the whole `repo`); the reads are the candidate
 *  live-fact pull, the session gate read, and the FT-safe world-tone projection. */
export interface ReconcileRepo {
  readonly sessions: {
    getById(id: string): Promise<{ reconciledAt: Date | null; campaignId: string } | null>
  }
  readonly facts: {
    listByEntities(
      entityIds: readonly string[],
      opts: { readonly accessLevels: readonly FactRow['accessLevel'][]; readonly liveOnly?: boolean },
    ): Promise<readonly FactRow[]>
  }
  readonly worlds: {
    getSnapshotSummary(id: string): Promise<{ tone: string | null } | null>
  }
  readonly entities: {
    /** Canon-by-name second-chance resolve for the validator's name-rebind heal:
     *  case/space-normalized exact name → id within the world, else null. */
    findIdByWorldAndNormalizedName(worldId: string, name: string): Promise<string | null>
  }
  readonly sessionMessages: {
    /** myth-8mom0 — the farewell turn's durable closing narration (dm_text rows,
     *  trigger_kind='farewell'). The farewell is player-less, so the Scribe never
     *  folded it into the working set; reconcile reads it here to canonize the
     *  session's closing beats. */
    listFarewellNarration(sessionId: string): Promise<readonly string[]>
  }
  readonly transaction: Repo['transaction']
}

export interface ReconcileProcessorDeps {
  readonly repo: ReconcileRepo
  readonly workingSet: Pick<WorkingSetRepo, 'load' | 'clear'>
  readonly lock: SessionLock
  findSimilarEntities: (
    worldId: string,
    text: string,
    opts: FindSimilarOpts,
  ) => Promise<EntityCandidate[]>
  readonly embedder: Pick<VoyageEmbedder, 'embedDocuments'>
  runReconciler: typeof runSessionReconciler
  applyCommit: typeof applyReconcileCommit
  readonly logger: MinimalLogger
}

// ── Render helpers (pure) ───────────────────────────────────────────────────

/** Render the working-set block: each item as its tier-floor join key
 *  (subjectName) + kind/tier/provenance/source + content. The provenance line
 *  carries the NPC name on an attributed claim so the model can keep the
 *  attribution baked into the canonized fact. */
export function renderWorkingSet(items: readonly WorkingSetItem[]): string {
  return items
    .map((it, i) => {
      const prov =
        it.provenance.kind === 'attributed'
          ? `attributed (by ${it.provenance.npcName})`
          : 'objective'
      const parent = it.parentName !== undefined && it.parentName.length > 0 ? ` parent=${it.parentName}` : ''
      return (
        `[ITEM ${String(i + 1)}] subject="${it.subjectName}" kind=${it.kind} tier=${it.tier} ` +
        `provenance=${prov} source=${it.source}${parent}\n  ${it.content}`
      )
    })
    .join('\n\n')
}

/** Render the candidates block: each candidate entity (id/name/type) followed by
 *  its live canon facts (factId/topic/accessLevel/content) so the model can match
 *  a working-set subject onto a canon id and reference factIds for supersede. */
export function renderCandidates(
  candidates: readonly EntityCandidate[],
  facts: readonly FactRow[],
): string {
  if (candidates.length === 0) return '(no canon candidates)'
  return candidates
    .map((c) => {
      const own = facts.filter((f) => f.entityId === c.entityId)
      const factLines =
        own.length === 0
          ? '  (no live facts)'
          : own
              .map(
                (f) =>
                  `  - factId=${f.id} topic="${f.topic}" accessLevel=${f.accessLevel}\n      ${f.content}`,
              )
              .join('\n')
      return `[ENTITY id=${c.entityId}] name="${c.name}" type=${c.entityType}\n${factLines}`
    })
    .join('\n\n')
}

// ── Processor ───────────────────────────────────────────────────────────────

const EMPTY_PLAN: ReconcilePlan = { entities: [], facts: [], relationships: [], promotions: [] }

/**
 * The end-of-session reconcile job. NOT total — THROWS on transient failure so
 * BullMQ retries (the §4 gate keeps a retry idempotent). Steps: gate-read →
 * lock → load working set → retrieve candidates → render → reconcile → validate
 * → embed → commit → clear.
 */
export async function processReconcileJob(
  deps: ReconcileProcessorDeps,
  job: { data: ReconcileJobPayload },
): Promise<void> {
  const { campaignId, sessionId, worldId } = job.data

  // 1. Read the gate. A missing session is a structural no-op (nothing to fold);
  //    an already-reconciled session means a prior execution won — defensively
  //    clear the working-set interlock and return.
  const session = await deps.repo.sessions.getById(sessionId)
  if (session === null) {
    deps.logger.warn({ sessionId }, 'reconcile_session_missing')
    return
  }
  if (session.reconciledAt !== null) {
    deps.logger.info({ sessionId, campaignId }, 'reconcile_already_done')
    await deps.workingSet.clear(campaignId)
    return
  }

  // 2. Acquire the per-session lock. A held lock means another execution is
  //    driving this reconcile — THROW so BullMQ retries (it is not an error, just
  //    a "come back later").
  const handle = await deps.lock.tryAcquire(campaignId)
  if (handle === null) {
    throw new Error(`reconcile_lock_contended: ${sessionId}`)
  }

  try {
    await runReconcile(deps, { campaignId, sessionId, worldId })
  } finally {
    await handle.release()
  }
}

/** The lock-guarded reconcile body (steps 3–9). Split out so the lock release
 *  lives in a single try/finally around the whole critical section. */
async function runReconcile(
  deps: ReconcileProcessorDeps,
  ids: { campaignId: string; sessionId: string; worldId: string },
): Promise<void> {
  const { campaignId, sessionId, worldId } = ids

  // 3. Load the working set + the farewell turn's closing narration. The farewell
  //    is player-less, so the post-turn Scribe never folded it into the working
  //    set (myth-8mom0) — its closing beats (an NPC's departure, an object's
  //    finished form, where the party settled) live ONLY in the durable dm_text
  //    rows. Reading them here (persisted at persistTurn, BEFORE finalize enqueued
  //    this job — race-free) lets the reconciler canonize the session's END state,
  //    so the next session's prep doesn't re-serialize the PRE-farewell canon.
  const items = await deps.workingSet.load(campaignId)
  const farewell = await deps.repo.sessionMessages.listFarewellNarration(sessionId)
  const closingNarration = farewell.join('\n\n')

  // An EMPTY working set still runs the commit with an empty plan/map so the §4
  // gate fires through the SAME conditional path (markReconciled is the commit's
  // last in-tx statement) — keeping the interlock consistent whether or not there
  // was anything to fold. But NOT when the farewell established closing beats: a
  // session whose only canon-worthy facts landed in the (Scribe-skipped) farewell
  // would otherwise be shortcut past the reconciler and lose them entirely.
  if (items.length === 0 && closingNarration.length === 0) {
    const { committed } = await deps.applyCommit(deps.repo, {
      plan: EMPTY_PLAN,
      map: new Map(),
      workingSet: [],
      worldId,
      sessionId,
      factEmbeddings: [],
    })
    if (committed) {
      await deps.workingSet.clear(campaignId)
      deps.logger.info({ sessionId, campaignId, empty: true }, 'reconcile_committed')
    } else {
      deps.logger.info({ sessionId, campaignId }, 'reconcile_gate_lost')
    }
    return
  }

  // 4. Retrieve canon candidates for each DISTINCT subject, then pull their live
  //    facts. findSimilarEntities THROWS on failure (canon write path) → the job
  //    throws → BullMQ retries.
  const subjects = [...new Set(items.map((i) => i.subjectName))]
  // myth-8mom0 — also retrieve canon candidates SEMANTICALLY similar to the
  // closing narration, so a subject the farewell UPDATES (e.g. Renn, whose
  // carving is finished in the send-off) resolves onto its existing canon entity
  // for a supersede/match instead of minting a duplicate.
  const retrievalQueries =
    closingNarration.length > 0 ? [...subjects, closingNarration] : subjects
  const candidateLists = await Promise.all(
    retrievalQueries.map((s) => deps.findSimilarEntities(worldId, s, { limit: CANDIDATES_PER_SUBJECT })),
  )
  const candidates = dedupeCandidates(candidateLists.flat())
  const liveCandidateEntityIds = new Set(candidates.map((c) => c.entityId))
  const facts =
    liveCandidateEntityIds.size === 0
      ? []
      : await deps.repo.facts.listByEntities([...liveCandidateEntityIds], {
          accessLevels: ['known', 'discoverable', 'secret'],
          liveOnly: true,
        })
  const liveFactIds = new Set(facts.map((f) => f.id))

  // 5. Render the prompt blocks + resolve the world tone (FT-safe projection).
  const wsBlock = renderWorkingSet(items)
  const candBlock = renderCandidates(candidates, facts)
  const worldSummary = await deps.repo.worlds.getSnapshotSummary(worldId)
  const worldTone = worldSummary?.tone ?? ''

  // 6. Reconcile (Opus). The closing narration is threaded as an AUTHORITATIVE
  //    end-state block: the reconciler folds the farewell's closing beats
  //    (superseding a now-stale candidate fact), not just the working set.
  const { result: plan } = await deps.runReconciler({
    workingSet: wsBlock,
    candidates: candBlock,
    worldTone,
    closingNarration,
  })

  // 7. Validate (PURE, security-critical). A reject logs a STRUCTURAL code +
  //    op COUNTS only (NEVER content) and THROWS so the non-deterministic Opus
  //    call is retried; the attempts cap bounds it.
  // Name-rebind heal input: candidate name → id, EXCLUDING names carried by
  // more than one candidate (an ambiguous rebind would be a guess — reject
  // instead). Lowercased+trimmed to match how the model echoes names.
  const nameCounts = new Map<string, number>()
  for (const c of candidates) {
    const k = c.name.trim().toLowerCase()
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1)
  }
  const candidateIdsByName = new Map<string, string>()
  for (const c of candidates) {
    const k = c.name.trim().toLowerCase()
    if (nameCounts.get(k) === 1) candidateIdsByName.set(k, c.entityId)
  }

  // Canon-by-name second chance: a match op whose id doesn't bind and whose
  // name is missing from the (top-K-per-subject) candidate set may still name a
  // REAL canon entity the retrieval simply didn't surface — seen live with
  // 'Maret Varden', canon since session 1 but absent from a large session's
  // candidate union. One indexed lookup per unresolved name.
  for (const e of plan.entities) {
    if (e.op !== 'match') continue
    const k = e.name.trim().toLowerCase()
    if (e.canonEntityId !== null && liveCandidateEntityIds.has(e.canonEntityId)) continue
    if (candidateIdsByName.has(k)) continue
    const canonId = await deps.repo.entities.findIdByWorldAndNormalizedName(worldId, e.name)
    if (canonId !== null) {
      candidateIdsByName.set(k, canonId)
      liveCandidateEntityIds.add(canonId)
    }
  }

  const v = validateReconcilePlan(plan, {
    workingSet: items,
    liveCandidateEntityIds,
    liveFactIds,
    candidateIdsByName,
  })
  if (v.ok && (v.rebinds.length > 0 || v.demotions.length > 0)) {
    // Names + ids only — never fact content (enforced-ignorance log posture).
    deps.logger.warn(
      {
        sessionId,
        rebinds: v.rebinds.map((r) => ({ name: r.name, to: r.to })),
        demotions: v.demotions.map((d) => d.name),
      },
      'reconcile_entity_ops_healed',
    )
  }
  if (!v.ok) {
    deps.logger.error(
      {
        sessionId,
        reason: v.reason,
        entityOps: plan.entities.length,
        factOps: plan.facts.length,
        promotions: plan.promotions.length,
      },
      'reconcile_plan_rejected',
    )
    throw new Error(`reconcile_plan_rejected: ${v.reason}`)
  }

  // 8. Embed each plan fact's content (DOCUMENT vectors), BEFORE the commit tx —
  //    slow I/O never sits inside BEGIN/COMMIT. The commit writes them in-tx.
  const factEmbeddings =
    plan.facts.length > 0 ? await deps.embedder.embedDocuments(plan.facts.map((f) => f.content)) : []

  // 9. Commit (one tx, gated). committed:false means a concurrent execution won
  //    the §4 gate — that winner clears; we just return.
  const { committed } = await deps.applyCommit(deps.repo, {
    plan,
    map: v.map,
    workingSet: items,
    worldId,
    sessionId,
    factEmbeddings,
  })
  if (committed) {
    await deps.workingSet.clear(campaignId)
    deps.logger.info(
      {
        sessionId,
        campaignId,
        entityOps: plan.entities.length,
        factOps: plan.facts.length,
        promotions: plan.promotions.length,
      },
      'reconcile_committed',
    )
  } else {
    deps.logger.info({ sessionId, campaignId }, 'reconcile_gate_lost')
  }
}

/** Union the per-subject candidate lists, keeping the FIRST occurrence of each
 *  entityId (highest-ranked across the subject it was found for). */
function dedupeCandidates(candidates: readonly EntityCandidate[]): EntityCandidate[] {
  const seen = new Set<string>()
  const out: EntityCandidate[] = []
  for (const c of candidates) {
    if (seen.has(c.entityId)) continue
    seen.add(c.entityId)
    out.push(c)
  }
  return out
}

// ── Worker builder ──────────────────────────────────────────────────────────

/**
 * Construct the session-reconcile BullMQ worker. `lockDuration` is 180s — ≥ the
 * 120s reconciler timeout PLUS Voyage-embed + commit-tx headroom (≈ 120s + ~30s
 * embed + ~30s commit) — so BullMQ NEVER stalled-reclaims a live reconcile into a
 * concurrent run (the §4 / §C3 double-reconcile mitigation). `concurrency:1` +
 * `maxStalledCount:1` keep one reconcile per worker in flight, leaning on the §4
 * gate (not raw concurrency) for the cross-container safety net.
 */
export function buildReconcileWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  embedder: VoyageEmbedder,
  logger: MinimalLogger,
): BullmqWorker<ReconcileJobPayload> {
  const repo = createRepo(pool)
  const workingSet: WorkingSetRepo = makeWorkingSetRepo(redisRealtime, redisKeyPrefix)
  const lock = createSessionLock(redisRealtime, redisKeyPrefix, RECONCILE_LOCK_TTL_MS)
  // The search resolver wants only `{ transaction }`; the concrete repo's
  // transaction has the exact signature, so a narrow view passes with no adapter.
  const { findSimilarEntities } = createSearchResolvers({
    embedder,
    repo: { transaction: repo.transaction },
    logger: {
      // search.ts only warns from searchLore (the swallowed-failure arm). The
      // reconcile worker calls ONLY findSimilarEntities (which THROWS, never
      // warns), so this adapter body is never reached through this worker — a
      // defensive bridge for the SearchLogger shape. c8-ignore the unreachable
      // body; the function itself is still constructed.
      /* c8 ignore next 3 -- findSimilarEntities throws; searchLore (the only warn caller) is unused here */
      warn: (obj: unknown, msg?: string): void => {
        logger.warn({ obj }, msg)
      },
    },
  })

  const deps: ReconcileProcessorDeps = {
    repo,
    workingSet,
    lock,
    findSimilarEntities,
    // The boot-probed, shared Voyage embedder (NOT a per-job construction — a
    // transient key blip the boot probe caught would silently degrade; §6).
    embedder,
    runReconciler: runSessionReconciler,
    applyCommit: applyReconcileCommit,
    logger,
  }

  return new BullmqWorker<ReconcileJobPayload>(
    QUEUE_SESSION_RECONCILE,
    (job: Job<ReconcileJobPayload>) => processReconcileJob(deps, job),
    {
      connection: redisBatch,
      concurrency: 1,
      // 180s ≥ 120s reconciler timeout + Voyage-embed + commit-tx headroom — a
      // live reconcile is never stalled-reclaimed into a concurrent run (§4/§C3).
      lockDuration: 180_000,
      stalledInterval: 180_000,
      maxStalledCount: 1,
    },
  )
}
