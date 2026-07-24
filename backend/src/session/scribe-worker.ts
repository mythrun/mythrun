// backend/src/session/scribe-worker.ts
//
// MYT-73 T10 — the post-turn SCRIBE job, OFF the hot path. For each completed
// turn it (1) embeds the turn's proposed facts (FT deltas + ST injections) into
// the in-session working set, (2) runs the per-turn secret tripwire (Haiku) over
// the FT's player-facing prose, and (3) on a core-secret breach authors (Opus) +
// delivers a secret-preserving retcon `Z` via a player-less `correction`-kind
// turn. NOTHING here may fail a player-visible turn (the producer is the turn
// worker's post-turn finally phase) — `processScribeJob` is TOTAL: it never
// throws out; transient failures lean on BullMQ retry, terminal ones log.
//
// SECURITY BOUNDARY (enforced ignorance is STRUCTURAL): the tripwire +
// retcon-author reason over the SECRET sd_playbook. The playbook is read ONLY
// through a DEDICATED narrow `ScribeRepo.sessionPreps.getBy` surface (mirrors
// StEvalRepo / LookupVetRepo) — NEVER a widening of the FT-side
// TurnWorkerRepo.sessionPreps ({ftContext}-only). The tripwire's output is an
// OPAQUE control signal ({severity, confidence, secretRef}); the retcon `Z` is
// authored to be secret-free and is the only thing that crosses back to a turn.
// An unresolvable/empty playbook FAILS LOUD (a disarmed tripwire is worse than
// an error).
//
// myth-retprop — PROPORTIONATE REMEDY: the tripwire's `severity` routes the
// response. A "hard_reveal" (the prose stated / necessarily implied a secret)
// gets the open, player-facing retcon below. A "soft_consistency" (an NPC merely
// ACTING in line with a hidden agenda — a gaze drifting to a door) gets a SILENT
// remedy: no player-facing correction at all; instead we signal the ST to steer
// FUTURE turns via its standing directive. This kills the "Streisand retcon" —
// a public correction over an improvised in-character detail that only confuses
// the player and advertises the secret. NOTHING secret-derived crosses back on
// the soft path (strictly stronger isolation than the retcon path).

import { Worker as BullmqWorker, Queue, type Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { createRepo } from '../repo/index.js'
import { makeWorkingSetRepo, type WorkingSetRepo } from '../redis/working-set.js'
import { makeTriggerState } from './trigger-state.js'
import { runSecretTripwire } from '../llm/secret-tripwire.js'
import { runRetconAuthor } from '../llm/retcon-author.js'
import type { VoyageEmbedder } from '../llm/embed.js'
import { uuidv7 } from '../repo/uuidv7.js'
import {
  enqueueTurn,
  QUEUE_SESSION_TURN,
  type TurnJobPayload,
  type TurnQueueLike,
} from './turn-queue.js'
import {
  QUEUE_SCRIBE,
  type ScribeJobPayload,
} from './scribe-queue.js'
import {
  enqueueStEval,
  QUEUE_ST_EVAL,
  type StEvalPayload,
  type StEvalQueueLike,
} from './st-eval-queue.js'
import { WORKING_SET_CAP } from './scribe-config.js'
import type { WorkingSetItem, WorkingSetProposal } from './working-set/types.js'

/** BullMQ lock/stalled config. The retcon-author (Opus) runs up to ~45s, so the
 *  lock sits comfortably above it — a live job is never reclaimed mid-Opus.
 *  Mirrors the st-evaluation worker's explicit shape. */
const SCRIBE_CONCURRENCY = 2
const SCRIBE_LOCK_DURATION_MS = 90_000
const SCRIBE_STALLED_INTERVAL_MS = 90_000
const SCRIBE_MAX_STALLED_COUNT = 1

interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

/** The Scribe worker's OWN narrow repo surface (the secret-bearing playbook read
 *  lives HERE, not on TurnWorkerRepo). Mirrors StEvalRepo. */
interface ScribeRepo {
  readonly sessionPreps: {
    // `sdPlaybook` is the SECRET surface (tripwire/retcon reason over it).
    // `ftContext` is PUBLIC (the same enforced-ignorance-safe briefing the FT
    // reads via TurnWorkerRepo) — read here to give the tripwire its grounding
    // floor (a detail already in the briefing is not a breach). Reading a public
    // column is NOT a widening of the secret surface.
    getBy(
      campaignId: string,
      sessionNumber: number,
    ): Promise<{ sdPlaybook: string; ftContext: string } | null>
  }
  readonly sessions: {
    getActiveByCampaign(campaignId: string): Promise<{ sessionNumber: number } | null>
  }
}

/** The watermark surface: the current responded-seq (the correction turn's
 *  maxConsumedSeq, so it does NOT advance past unresponded player seqs). The
 *  real method is `respondedSeq` (trigger-state.ts). */
interface ScribeTriggerState {
  getRespondedSeq(campaignId: string): Promise<number>
}

/** The working-set sink the Scribe job appends to + evicts. */
interface ScribeWorkingSet {
  load(campaignId: string): Promise<WorkingSetItem[]>
  append(campaignId: string, items: readonly WorkingSetItem[]): Promise<void>
  evictIfOver(campaignId: string, cap: number): Promise<void>
}

export interface ScribeProcessorDeps {
  readonly repo: ScribeRepo
  readonly triggerState: ScribeTriggerState
  readonly workingSet: ScribeWorkingSet
  readonly embedder: Pick<VoyageEmbedder, 'embedDocuments'>
  runTripwire: typeof runSecretTripwire
  runRetcon: typeof runRetconAuthor
  readonly sessionTurnQueue: TurnQueueLike
  /** The st-evaluation producer — the SILENT soft-consistency remedy enqueues an
   *  ST evaluation (dedup-collapsed per campaign) so the secret-aware Opus
   *  director can steer future turns. No player-facing correction on this path. */
  readonly stEvalQueue: StEvalQueueLike
  readonly logger: MinimalLogger
}

/** Map the turn's FT delta facts + ST injections into pre-embed proposals.
 *  Delta facts are objective public assertions (`ft_delta` / `known` /
 *  objective); ST injections ride through verbatim (already-vetted relay text). */
function toProposals(payload: ScribeJobPayload): WorkingSetProposal[] {
  const deltas: WorkingSetProposal[] = (payload.worldDelta?.facts ?? []).map((f) => ({
    kind: f.kind,
    content: f.content,
    subjectName: f.subject,
    tier: 'known',
    provenance: { kind: 'objective' },
    source: 'ft_delta',
  }))
  return [...payload.injections, ...deltas]
}

/** Embed each proposal's content (DOCUMENT input-type — parity with canon) and
 *  stamp it into a WorkingSetItem. An embed failure degrades to empty embeddings
 *  (logged) rather than dropping the turn's facts. TOTAL — never throws. */
async function embedProposals(
  deps: ScribeProcessorDeps,
  turnId: string,
  proposals: readonly WorkingSetProposal[],
): Promise<WorkingSetItem[]> {
  if (proposals.length === 0) return []
  let vectors: number[][] = []
  try {
    vectors = await deps.embedder.embedDocuments(proposals.map((p) => p.content))
  } catch (err) {
    deps.logger.warn({ err }, 'scribe: embed failed; appending with empty embeddings (degraded)')
    vectors = []
  }
  return proposals.map((p, i) => ({
    ...p,
    id: uuidv7(),
    turnId,
    embedding: vectors[i] ?? [],
  }))
}

/** Resolve the SECRET sd_playbook + the PUBLIC ft_context for the campaign's
 *  active session. Returns null when the session/prep is unresolvable or the
 *  playbook is empty — the caller FAILS LOUD on null (a disarmed tripwire is
 *  worse than an error). `ftContext` is the tripwire's grounding floor; it may
 *  be '' (a degraded but non-fatal state — grounding just can't rescue any
 *  detail that turn). */
async function resolvePrep(
  deps: ScribeProcessorDeps,
  campaignId: string,
): Promise<{ sdPlaybook: string; ftContext: string } | null> {
  const session = await deps.repo.sessions.getActiveByCampaign(campaignId)
  if (session === null) return null
  const prep = await deps.repo.sessionPreps.getBy(campaignId, session.sessionNumber)
  const sdPlaybook = prep?.sdPlaybook ?? ''
  if (sdPlaybook.trim().length === 0) return null
  return { sdPlaybook, ftContext: prep?.ftContext ?? '' }
}

/** Format the playbook as the tripwire's handle-annotated `secrets` block. v1:
 *  the whole sd_playbook under a single `[SECRET-1]` handle (the prompt keys off
 *  handles; a richer per-secret split is a documented follow-up). */
function formatSecrets(sdPlaybook: string): string {
  return `[SECRET-1] ${sdPlaybook}`
}

/** Build the retcon working-set item. The breach `secretRef` is stored in
 *  `subjectName` so the double-retcon guard can match a live supersede for the
 *  SAME secret without a dedicated schema field.
 *
 *  ENFORCED IGNORANCE (§8c): the item carries ONLY the secret-free `Z`
 *  (`content`) + the opaque `secretRef` handle. The retcon-author's
 *  `supersededContent` — the false thing being corrected — names the secret by
 *  construction (the breach prose stated it openly), so it is DELIBERATELY NOT
 *  persisted to the working set: storing it would put a raw core secret into
 *  ephemeral session state (a defense-in-depth leak the real-LLM smoke caught;
 *  the mocked unit test masked it with a clean spy value). Supersession, when
 *  MYT-74 needs it, is tracked secret-free via `supersedesId` (an id reference),
 *  never raw prose. */
function retconItem(
  turnId: string,
  secretRef: string,
  retconText: string,
  tier: WorkingSetItem['tier'],
): WorkingSetItem {
  return {
    kind: 'fact',
    content: retconText,
    subjectName: secretRef,
    tier,
    provenance: { kind: 'objective' },
    source: 'retcon',
    id: uuidv7(),
    turnId,
    embedding: [],
  }
}

/** True iff the working set already holds a `retcon` item superseding THIS
 *  secretRef (tracked in the retcon item's `subjectName`) — the double-retcon
 *  guard: a re-fired breach on a still-live correction skips re-authoring. */
function hasLiveRetcon(workingSet: readonly WorkingSetItem[], secretRef: string): boolean {
  return workingSet.some((i) => i.source === 'retcon' && i.subjectName === secretRef)
}

/** Step 4 — on a breach, author + deliver the retcon. TOTAL: a repair-attempted
 *  authoring fail-softs (re-fires next turn); a clean authoring enqueues a
 *  `correction`-kind turn + appends a `retcon` supersede to the working set. */
async function handleBreach(
  deps: ScribeProcessorDeps,
  payload: ScribeJobPayload,
  sdPlaybook: string,
  secretRef: string,
  liveWorkingSet: readonly WorkingSetItem[],
): Promise<void> {
  const { campaignId, sessionId, prose } = payload
  if (hasLiveRetcon(liveWorkingSet, secretRef)) {
    deps.logger.info({ campaignId, secretRef }, 'scribe: live retcon for secret; skipping re-author')
    return
  }
  const retcon = await deps.runRetcon({
    prose,
    breach: secretRef,
    secret: sdPlaybook,
    recentNarrative: prose,
  })
  if (retcon.repairAttempted) {
    deps.logger.warn({ campaignId }, 'scribe: retcon repairAttempted — fail-soft (re-fires next turn)')
    return
  }
  const correctionTurn: TurnJobPayload = {
    campaignId,
    sessionId,
    turnId: uuidv7(),
    triggerMessages: [],
    maxConsumedSeq: await deps.triggerState.getRespondedSeq(campaignId),
    trigger: { kind: 'correction' },
    correctionText: retcon.result.retconText,
  }
  await enqueueTurn(deps.sessionTurnQueue, correctionTurn)
  await deps.workingSet.append(campaignId, [
    retconItem(payload.turnId, secretRef, retcon.result.retconText, retcon.result.tier),
  ])
}

/** Step 4 (soft) — a "soft_consistency" verdict: an NPC merely ACTING in line
 *  with a hidden agenda. The remedy is SILENT — NO player-facing correction (an
 *  open retcon over an in-character gaze is the Streisand failure). Instead
 *  enqueue an ST evaluation so the secret-aware Opus director can, if it judges
 *  it necessary, steer FUTURE turns via its standing directive. The enqueue is
 *  dedup-collapsed per campaign (st-eval-queue's no-ttl dedup), so a scene full
 *  of in-character NPC beats does not spam Opus. TOTAL — an enqueue failure logs
 *  and returns (steering is an enhancement; the turn already shipped clean, and
 *  the ST's own 5-turn oversight floor is the backstop). Nothing secret-derived
 *  crosses back here. */
async function handleSoftConsistency(
  deps: ScribeProcessorDeps,
  payload: ScribeJobPayload,
  secretRef: string,
  confidence: number,
): Promise<void> {
  const { campaignId, sessionId } = payload
  deps.logger.info(
    { campaignId, secretRef, confidence },
    'scribe: soft_consistency (NPC behavior consistent with a secret) — NO player correction; signaling ST to steer',
  )
  try {
    await enqueueStEval(deps.stEvalQueue, { campaignId, sessionId })
  } catch (err) {
    deps.logger.warn({ err, campaignId }, 'scribe: soft_consistency ST-signal enqueue failed (fail-soft)')
  }
}

/**
 * The post-turn Scribe job. TOTAL — never throws out (the producer is the turn
 * worker's finally phase; a throw here would not fail the player-visible turn,
 * but a thrown error would surface as an unhandled BullMQ failure — keep it
 * contained). Steps: embed-on-append → tripwire → route by severity
 * (soft_consistency → silent ST steer; hard_reveal → open retcon).
 */
export async function processScribeJob(
  deps: ScribeProcessorDeps,
  job: { data: ScribeJobPayload },
): Promise<void> {
  const { campaignId, turnId, prose } = job.data

  // 1–2. Embed the turn's proposed facts into the working set, then evict.
  try {
    const items = await embedProposals(deps, turnId, toProposals(job.data))
    await deps.workingSet.append(campaignId, items)
    await deps.workingSet.evictIfOver(campaignId, WORKING_SET_CAP)
  } catch (err) {
    deps.logger.error({ err, campaignId }, 'scribe: working-set append/evict failed')
    // Working-set persistence is best-effort; continue to the tripwire (the
    // secret check is the load-bearing half of this job).
  }

  // 3. Resolve the SECRET playbook (+ PUBLIC ft_context) — FAIL LOUD on
  // absent/empty playbook (a disarmed tripwire is worse than an error; do NOT
  // silently skip).
  let prep: { sdPlaybook: string; ftContext: string } | null
  try {
    prep = await resolvePrep(deps, campaignId)
  } catch (err) {
    deps.logger.error({ err, campaignId }, 'scribe_tripwire_misconfigured: playbook read failed')
    return
  }
  if (prep === null) {
    deps.logger.error({ campaignId }, 'scribe_tripwire_misconfigured: empty/unresolvable sd_playbook')
    return
  }
  const { sdPlaybook, ftContext } = prep

  // 4. Run the tripwire over the FT's player-facing prose. Pass the PUBLIC
  // ft_context so a detail the FT was licensed to write is grounded → not a
  // breach (the grounding floor).
  let tripwire: Awaited<ReturnType<typeof runSecretTripwire>>
  try {
    tripwire = await deps.runTripwire({
      prose,
      secrets: formatSecrets(sdPlaybook),
      publicContext: ftContext,
    })
  } catch (err) {
    deps.logger.warn({ err, campaignId }, 'scribe: tripwire failed; no breach check this turn')
    return
  }

  const { severity, confidence, secretRef } = tripwire.result
  // myth-retprop — route by SEVERITY, not a numeric confidence floor. `none`
  // is clean; `soft_consistency` (in-character NPC behavior) gets the SILENT ST
  // steer; only `hard_reveal` (the secret stated / necessarily implied) fires
  // the disruptive open, player-facing retcon. Recall bias lives in the severity
  // call itself — ANY hard_reveal fires the retcon regardless of confidence.
  if (severity === 'none') {
    deps.logger.info({ campaignId, confidence }, 'scribe: tripwire clean; no retcon')
    return
  }
  if (severity === 'soft_consistency') {
    await handleSoftConsistency(deps, job.data, secretRef ?? '[SECRET-1]', confidence)
    return
  }

  // 5. hard_reveal → author + deliver the open retcon (double-retcon guarded).
  // Observability: the FIRING breach logs its handle + confidence here (the
  // happy retcon path was previously silent in logs — a forensic gap). Handle +
  // number only; NO secret content (that stays behind redactRawText).
  deps.logger.info(
    { campaignId, secretRef, confidence },
    'scribe: hard_reveal breach → authoring open retcon',
  )
  const liveWorkingSet = await deps.workingSet.load(campaignId)
  await handleBreach(deps, job.data, sdPlaybook, secretRef ?? '[SECRET-1]', liveWorkingSet)
}

export function buildScribeWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  embedder: VoyageEmbedder,
  logger: MinimalLogger,
): BullmqWorker<ScribeJobPayload> {
  const repo = createRepo(pool)
  const workingSet: WorkingSetRepo = makeWorkingSetRepo(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)
  const sessionTurnQueue = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, {
    connection: redisBatch,
  })
  // The soft-consistency ST-signal producer (dedup-collapsed per campaign — see
  // st-eval-queue's no-ttl deduplication invariant). Constructed here, mirroring
  // the turn-worker's post-turn arm, so the scribe can nudge the ST to steer
  // future turns without authoring anything player-facing.
  const stEvalQueue = new Queue<StEvalPayload>(QUEUE_ST_EVAL, {
    connection: redisBatch,
  })

  const deps: ScribeProcessorDeps = {
    repo,
    triggerState: {
      getRespondedSeq: (c) => triggerState.respondedSeq(c),
    },
    workingSet,
    // The boot-probed, shared Voyage embedder (NOT a per-job construction — a
    // transient key blip the boot probe caught would silently degrade; §6).
    embedder,
    runTripwire: runSecretTripwire,
    runRetcon: runRetconAuthor,
    sessionTurnQueue,
    stEvalQueue,
    logger,
  }

  return new BullmqWorker<ScribeJobPayload>(
    QUEUE_SCRIBE,
    (job: Job<ScribeJobPayload>) => processScribeJob(deps, job),
    {
      connection: redisBatch,
      concurrency: SCRIBE_CONCURRENCY,
      lockDuration: SCRIBE_LOCK_DURATION_MS,
      stalledInterval: SCRIBE_STALLED_INTERVAL_MS,
      maxStalledCount: SCRIBE_MAX_STALLED_COUNT,
    },
  )
}
