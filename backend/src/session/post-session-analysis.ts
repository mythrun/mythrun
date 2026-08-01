// backend/src/session/post-session-analysis.ts
//
// MYT-74b T9 — the POST-SESSION ANALYSIS worker. The end-of-session closeout
// that folds a live session's transcript into durable narrative state. It reads
// ONLY durable inputs (the transcript tail, the prep sd_playbook, the ST running
// summary, the PC roster — all safe AFTER the WS connection closes), runs ONE
// Opus call (T8), mechanically verifies the handoff's verbatim excerpts against
// the transcript (T-containment), and persists through the conditional
// `writeAnalysis` gate. Enqueued at finalize (jobId=analysis-{sessionId}).
//
// NOT TOTAL (unlike the post-turn Scribe job): this processor THROWS on transient
// failure so BullMQ RETRIES. A retry is idempotent — `writeAnalysis` is gated on
// `summary IS NULL`, so the second execution to reach the write no-ops (0 rows ⇒
// already written). The attempts cap bounds a persistently-failing
// non-deterministic Opus call.
//
// ENFORCED IGNORANCE (load-bearing): the analysis reasons over SECRETS (the
// sd_playbook + the ST running summary). The `summary`/`emergingThreads` it emits
// are secret-free (player-witnessed), but the worker NEVER logs summary, handoff,
// or excerpt CONTENT — only STRUCTURAL counts/ids (sessionId, drop counts, op
// counts). A dropped-excerpt warn carries the COUNT, never the prose, so the
// alert/log surface can't echo the secret the containment verifier exists to gate.

import { Worker as BullmqWorker, type Job, type Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'

import { createRepo } from '../repo/index.js'
import { makeSessionState, type SessionState } from '../redis/session-state.js'
import { runPostSessionAnalysis } from '../llm/post-session-analysis.js'
import { verifyHandoffContainment, type AnalysisTranscriptRow } from './analysis/containment.js'
import type { SessionHandoff } from '../llm/schemas/post-session-analysis.js'

/** How many trailing transcript rows feed the Opus call. The late tail is where
 *  voice/affect lives; bounding it caps the input on the largest sessions. */
const ANALYSIS_TRANSCRIPT_TAIL = 160

/** Worker lockDuration — ≥ the 120s analysis Opus timeout PLUS verify + write
 *  headroom — so BullMQ never stalled-reclaims a live analysis into a concurrent
 *  run. Matches the reconcile worker's 180s sizing. */
const ANALYSIS_LOCK_DURATION_MS = 180_000

interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

// ── Queue + producer (mirrors scribe-queue.ts / session-reconcile.ts) ────────

export const QUEUE_SESSION_ANALYSIS = 'session-analysis' as const
export const ANALYSIS_JOB_NAME = 'analysis' as const

export interface AnalysisJobPayload {
  readonly campaignId: string
  readonly sessionId: string
}

/** Narrow producer surface (just `add`). */
export interface AnalysisQueueLike {
  add: Queue<AnalysisJobPayload>['add']
}

/** Enqueue ONE post-session analysis job. `jobId` is per-session
 *  (`analysis-${sessionId}`) so a double-trigger (two finalize signals for the
 *  same session) COLLAPSES to a single job rather than racing two analyses. */
export function enqueuePostSessionAnalysis(
  queue: AnalysisQueueLike,
  payload: AnalysisJobPayload,
): Promise<unknown> {
  return queue.add(ANALYSIS_JOB_NAME, payload, { jobId: `analysis-${payload.sessionId}` })
}

// ── Processor deps (narrow, all injected) ────────────────────────────────────

/** The worker's OWN narrow repo surface. Structural subset of what
 *  `createRepo(pool)` returns — the concrete repo's namespaces satisfy these
 *  shapes with no adapter (the real methods return supersets). */
interface AnalysisRepo {
  readonly sessions: {
    getById(id: string): Promise<{ sessionNumber: number; summary: string | null } | null>
    writeAnalysis(
      id: string,
      input: { summary: string; emergingThreads: readonly string[]; handoff: SessionHandoff },
    ): Promise<number>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ sdPlaybook: string } | null>
  }
  readonly sessionMessages: {
    listForAnalysis(
      sessionId: string,
      limit: number,
    ): Promise<readonly { seq: number; messageType: string; content: string; triggerKind: string | null }[]>
    /** myth-8mom0 — the farewell turn's closing narration (dm_text rows,
     *  trigger_kind='farewell'). The farewell IS the session's final state (a
     *  cliffhanger, an NPC's departure, where the party settled), but the
     *  containment verifier deliberately excludes farewell lines from the
     *  handoff's verbatim voice/atmosphere. Surfacing the closing narration to
     *  the analyst as a distinct AUTHORITATIVE block keeps the summary + the
     *  handoff's paraphrasable end-state fields reflecting where the session
     *  actually ended. */
    listFarewellNarration(sessionId: string): Promise<readonly string[]>
  }
  readonly characters: {
    listSessionParticipantCharacters(sessionId: string): Promise<readonly { name: string }[]>
  }
}

export interface AnalysisProcessorDeps {
  readonly repo: AnalysisRepo
  readonly sessionState: Pick<SessionState, 'loadTurnState'>
  runAnalysis: typeof runPostSessionAnalysis
  verify: typeof verifyHandoffContainment
  readonly logger: MinimalLogger
}

// ── Render helper (pure) ──────────────────────────────────────────────────────

/** Render the transcript tail: each row as `[messageType] content`, newline-
 *  joined. Bounded by ANALYSIS_TRANSCRIPT_TAIL upstream (the repo read's LIMIT). */
export function renderTranscriptTail(
  rows: readonly { messageType: string; content: string }[],
): string {
  return rows.map((r) => `[${r.messageType}] ${r.content}`).join('\n')
}

// ── Processor ─────────────────────────────────────────────────────────────────

/**
 * The post-session analysis job. NOT total — THROWS on transient failure so
 * BullMQ retries (the `summary IS NULL` write gate keeps a retry idempotent).
 * Steps: gate-read → load durable inputs → analyze (Opus) → verify excerpts →
 * write (gated).
 */
export async function processPostSessionAnalysisJob(
  deps: AnalysisProcessorDeps,
  job: { data: AnalysisJobPayload },
): Promise<void> {
  const { campaignId, sessionId } = job.data

  // 1. Read the gate. A missing session is a structural no-op; a session that
  //    already has a summary means a prior execution won — early-out.
  const session = await deps.repo.sessions.getById(sessionId)
  if (session === null) {
    deps.logger.warn({ sessionId }, 'analysis_session_missing')
    return
  }
  if (session.summary !== null) {
    deps.logger.info({ sessionId, campaignId }, 'analysis_already_done')
    return
  }

  // 2. Load the durable inputs (all safe after the WS connection closes).
  const rows = await deps.repo.sessionMessages.listForAnalysis(sessionId, ANALYSIS_TRANSCRIPT_TAIL)
  const prep = await deps.repo.sessionPreps.getBy(campaignId, session.sessionNumber)
  const sdPlaybook = prep?.sdPlaybook ?? ''
  const { summary: runningSummary } = await deps.sessionState.loadTurnState(campaignId)
  const participants = await deps.repo.characters.listSessionParticipantCharacters(sessionId)
  // myth-8mom0 — the farewell turn's closing narration, surfaced as a distinct
  // AUTHORITATIVE end-state block (the containment verifier still bars quoting it
  // as voice/atmosphere; this only anchors the summary + the paraphrasable
  // handoff end-state to where the session actually ended).
  const farewell = await deps.repo.sessionMessages.listFarewellNarration(sessionId)

  // 3. Analyze (Opus). Rejects propagate → BullMQ retries.
  const { result } = await deps.runAnalysis({
    transcript: renderTranscriptTail(rows),
    runningSummary,
    sdPlaybook,
    participants: participants.map((p) => p.name).join(', '),
    closingNarration: farewell.join('\n\n'),
    sessionId,
  })

  // 4. Verify the handoff's verbatim excerpts against the transcript; drop any
  //    that aren't a substring of a non-correction/farewell row. A drop is logged
  //    by COUNT only (enforced ignorance — never the dropped prose).
  const verifyRows: AnalysisTranscriptRow[] = rows.map((r) => ({
    content: r.content,
    triggerKind: r.triggerKind,
  }))
  const { handoff, droppedVoice, droppedAtmosphere } = deps.verify(result.handoff, verifyRows)
  if (droppedVoice > 0 || droppedAtmosphere > 0) {
    deps.logger.warn(
      { sessionId, campaignId, droppedVoice, droppedAtmosphere },
      'analysis_excerpts_dropped_not_in_transcript',
    )
  }

  // 5. Persist (conditional gate). wrote=0 means a concurrent execution / retry
  //    already wrote — not an error, just a no-op this execution.
  const wrote = await deps.repo.sessions.writeAnalysis(sessionId, {
    summary: result.summary,
    emergingThreads: result.emergingThreads,
    handoff,
  })
  deps.logger.info(
    { sessionId, campaignId, wrote, npcs: handoff.npcs.length, locations: handoff.keyLocations.length },
    wrote > 0 ? 'analysis_written' : 'analysis_gate_lost',
  )
}

// ── Worker builder ──────────────────────────────────────────────────────────

/**
 * Construct the post-session-analysis BullMQ worker. Takes NO embedder (unlike
 * the reconcile worker — analysis doesn't embed). `lockDuration` is 180s — ≥ the
 * 120s analysis Opus timeout + verify + write headroom — so a live analysis is
 * never stalled-reclaimed into a concurrent run. `concurrency:1` +
 * `maxStalledCount:1` keep one analysis per worker in flight; the
 * `summary IS NULL` write gate is the cross-container idempotency net.
 */
export function buildPostSessionAnalysisWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  logger: MinimalLogger,
): BullmqWorker<AnalysisJobPayload> {
  const repo = createRepo(pool)
  const sessionState = makeSessionState(redisRealtime, redisKeyPrefix)
  const deps: AnalysisProcessorDeps = {
    repo,
    sessionState,
    runAnalysis: runPostSessionAnalysis,
    verify: verifyHandoffContainment,
    logger,
  }
  return new BullmqWorker<AnalysisJobPayload>(
    QUEUE_SESSION_ANALYSIS,
    (job: Job<AnalysisJobPayload>) => processPostSessionAnalysisJob(deps, job),
    {
      connection: redisBatch,
      concurrency: 1,
      lockDuration: ANALYSIS_LOCK_DURATION_MS,
      stalledInterval: ANALYSIS_LOCK_DURATION_MS,
      maxStalledCount: 1,
    },
  )
}
