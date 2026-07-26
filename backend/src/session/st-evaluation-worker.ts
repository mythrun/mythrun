// backend/src/session/st-evaluation-worker.ts
//
// MYT-69 — the SlowThinker pipeline, OFF the hot path. policy → converge probe
// → gate → evaluate → write, all background. NOTHING here may delay or fail a
// player-visible turn (the producer is the turn worker's post-turn finally
// phase, own try/catch).
//
// myth-3jna1 added the converge probe: inside the [CONVERGE_MECHANICAL_FLOOR,
// WIND_DOWN_FRACTION) window it asks (Haiku) how far through the prep's arc the
// table actually is, and when the story is behind the spend it forces the
// evaluation with `converge:true` so the ST starts aiming the session at a
// resting point. Three stages, in order: converge (0.75) → wind-down (0.9) →
// farewell (1.0, the turn worker's auto-end). The narrative-progress number is
// SECRET-SIDE and never leaves this pipeline — see st-converge-probe.ts.
//
// Defines its OWN narrow repo interface (sd_playbook read + the codec window +
// the roster read) — NOT a widening of TurnWorkerRepo, whose sessionPreps
// surface is {ftContext}-only. The FT-side worker's dependency surface never
// gains a secret-bearing read (§9).

import { Worker as BullmqWorker, Queue, type Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { createRepo } from '../repo/index.js'
import { makeSessionState } from '../redis/session-state.js'
import { makeTriggerState } from './trigger-state.js'
import { runStGate } from '../llm/st-gate.js'
import { runStDirector } from '../llm/st-director.js'
import { runStNarrativeProgress } from '../llm/st-narrative-progress.js'
import { rowsToConversation } from './transcript-codec.js'
import {
  ST_EVAL_FLOOR_TURNS,
  ST_GATE_CONFIDENCE_FLOOR,
  ST_EVAL_EXCHANGE_WINDOW,
  ST_GATE_EXCHANGE_WINDOW,
  SESSION_TOKEN_BUDGET,
  WIND_DOWN_FRACTION,
} from './st-config.js'
import { mechanicalProgress, shouldProbeNarrativeProgress } from './converge-policy.js'
import { NO_CONVERGE, probeConvergence } from './st-converge-probe.js'
import { usageTokens } from './st-usage.js'
import {
  enqueueStEval,
  stEvalDedupId,
  QUEUE_ST_EVAL,
  type StEvalPayload,
  type StEvalQueueWithDedup,
} from './st-eval-queue.js'
import type { ConversationMessage } from './tiers/types.js'
import type { SessionMessage } from '../repo/types.js'

/** BullMQ lock/stalled config (§11). This job runs up to ~2.5 min (Opus), so the
 *  lock sits comfortably above ST_EVAL_TIMEOUT_MS (120s) — a live job is never
 *  reclaimed mid-Opus. A deploy mid-eval force-closes the worker and the job
 *  re-runs after reboot (double Opus spend per deploy-during-eval, accepted —
 *  §11). Mirrors the turn-worker's explicit lockDuration/stalledInterval/
 *  maxStalledCount shape. */
const ST_EVAL_CONCURRENCY = 2
const ST_EVAL_LOCK_DURATION_MS = 150_000
const ST_EVAL_STALLED_INTERVAL_MS = 150_000
const ST_EVAL_MAX_STALLED_COUNT = 1

interface MinimalLogger {
  info: (o: Record<string, unknown> | string, m?: string) => void
  warn: (o: Record<string, unknown> | string, m?: string) => void
  error: (o: Record<string, unknown> | string, m?: string) => void
}

/** The ST worker's OWN narrow repo surface (secret-bearing reads live here, NOT
 *  on TurnWorkerRepo). */
interface StEvalRepo {
  readonly sessions: {
    getActiveByCampaign(
      campaignId: string,
    ): Promise<{ id: string; sessionNumber: number } | null>
  }
  readonly sessionPreps: {
    getBy(campaignId: string, sessionNumber: number): Promise<{ sdPlaybook: string } | null>
  }
  readonly sessionMessages: {
    listFtContextRows(sessionId: string, maxPlayerSeq: number): Promise<SessionMessage[]>
  }
  readonly characters: {
    listSessionParticipantRoster(
      sessionId: string,
    ): Promise<readonly { name: string; characterClass: string; background: string }[]>
    listSessionParticipantCharacters(
      sessionId: string,
    ): Promise<readonly { userId: string; name: string }[]>
  }
}

/** The ST-side session-state reads/writes (summary + summed usage). */
interface StEvalSessionState {
  loadTurnState(campaignId: string): Promise<{ summary: string }>
  setRunningSummary(campaignId: string, summary: string): Promise<void>
  totalUsageTokens(campaignId: string): Promise<number>
  incrUsageSt(campaignId: string, tokens: number): Promise<void>
}

/** The ST-side trigger-state surface (slots + counter + watermark). */
interface StEvalTriggerState {
  setOneShotDirection(campaignId: string, text: string): Promise<void>
  setStandingDirection(campaignId: string, text: string): Promise<void>
  clearStandingDirection(campaignId: string): Promise<void>
  readStandingDirection(campaignId: string): Promise<string | null>
  // read-only — the ST NEVER consumes (takeOneShotDirection is the turn worker's; T4)
  peekOneShotDirection(campaignId: string): Promise<string | null>
  turnsSinceSt(campaignId: string): Promise<number>
  resetTurnsSinceSt(campaignId: string): Promise<void>
  respondedSeq(campaignId: string): Promise<number>
}

export interface StEvalProcessorDeps {
  readonly repo: StEvalRepo
  readonly sessionState: StEvalSessionState
  readonly triggerState: StEvalTriggerState
  runGate: typeof runStGate
  runDirector: typeof runStDirector
  /** myth-3jna1 — the narrative-progress judgment (Haiku). SECRET-SIDE: it is
   *  fed the playbook and its result is consumed by CODE only. */
  runNarrativeProgress: typeof runStNarrativeProgress
  reArm(campaignId: string, sessionId: string): Promise<void>
  readonly logger: MinimalLogger
}

function formatExchanges(history: readonly ConversationMessage[], window: number): string {
  const slice = history.slice(-window)
  return slice
    .map((m) => {
      // The `?? 'Player'` default is defensive: ConversationMessage types
      // characterName as optional, but the §3.7 codec (the ONLY producer of this
      // history) always sets it to a string for user rows (userId ?? 'Player'),
      // so the nullish-true arm is unreachable through processStEvalJob's seam.
      /* c8 ignore next */
      const who = m.role === 'user' ? (m.characterName ?? 'Player') : 'DM'
      const text = m.parts.map((p) => (p.kind === 'text' ? p.text : `[${p.kind}]`)).join(' ')
      return `${who}: ${text}`
    })
    .join('\n')
}

/** The context reads shared by gate + evaluate (prep playbook, running
 *  summary, the reconstructed conversation slice). Split from
 *  `processStEvalJob` purely for function-length hygiene. */
async function loadStEvalContext(
  deps: StEvalProcessorDeps,
  campaignId: string,
  sessionId: string,
  sessionNumber: number,
  watermarkAtStart: number,
): Promise<{ sdPlaybook: string; summary: string; history: ConversationMessage[] }> {
  const prep = await deps.repo.sessionPreps.getBy(campaignId, sessionNumber)
  const sdPlaybook = prep?.sdPlaybook ?? ''
  const { summary } = await deps.sessionState.loadTurnState(campaignId)
  const rows = await deps.repo.sessionMessages.listFtContextRows(sessionId, watermarkAtStart)
  const names = new Map(
    (await deps.repo.characters.listSessionParticipantCharacters(sessionId)).map(
      (p) => [p.userId, p.name] as const,
    ),
  )
  return { sdPlaybook, summary, history: rowsToConversation(rows, names) }
}

export async function processStEvalJob(
  deps: StEvalProcessorDeps,
  job: { data: StEvalPayload },
): Promise<void> {
  const { campaignId, sessionId } = job.data

  // 1. Active-session check (a queued job for an ended session no-ops).
  const session = await deps.repo.sessions.getActiveByCampaign(campaignId)
  if (session?.id !== sessionId) {
    deps.logger.info({ campaignId, sessionId }, 'st-eval: no matching active session; no-op')
    return
  }
  const watermarkAtStart = await deps.triggerState.respondedSeq(campaignId)

  // Context reads (shared by gate + evaluate).
  const { sdPlaybook, summary, history } = await loadStEvalContext(
    deps,
    campaignId,
    sessionId,
    session.sessionNumber,
    watermarkAtStart,
  )

  // 2. DETERMINISTIC POLICY (mechanical, ZFC-exempt).
  const turnsSinceSt = await deps.triggerState.turnsSinceSt(campaignId)
  const totalUsed = await deps.sessionState.totalUsageTokens(campaignId)
  const windDown = totalUsed >= WIND_DOWN_FRACTION * SESSION_TOKEN_BUDGET
  const floorForces = turnsSinceSt >= ST_EVAL_FLOOR_TURNS

  let usageToWrite = 0

  // 2b. myth-3jna1 — the CONVERGENCE probe, inside the [floor, wind-down)
  // window only. Its verdict FORCES the evaluation on the same arm as
  // wind-down: a steer that waits for the gate (or for the 5-turn floor) can
  // arrive with no session left to land in, which is the whole defect. The
  // window is a handful of turns at the tail, so the forced-Opus cost profile
  // matches the wind-down arm's, which already accepts it.
  const mechanical = mechanicalProgress(totalUsed)
  const probe = shouldProbeNarrativeProgress(mechanical, windDown)
    ? await probeConvergence(deps, campaignId, mechanical, {
        sdPlaybook,
        runningSummary: summary,
        // The tighter window, like the gate: arc position is judged from the
        // running summary (which carries the whole session) plus a look at
        // where the table is standing right now.
        recentExchanges: formatExchanges(history, ST_GATE_EXCHANGE_WINDOW),
      })
    : NO_CONVERGE
  usageToWrite += probe.tokens

  let shouldEvaluate = floorForces || windDown || probe.converge

  // 3. HAIKU GATE (only when policy didn't already force the evaluation).
  if (!shouldEvaluate) {
    try {
      const gate = await deps.runGate({
        sdPlaybook,
        runningSummary: summary,
        recentExchanges: formatExchanges(history, ST_GATE_EXCHANGE_WINDOW),
      })
      usageToWrite += usageTokens(gate.usage)
      const skip = !gate.result.needed && gate.result.confidence >= ST_GATE_CONFIDENCE_FLOOR
      shouldEvaluate = !skip
      deps.logger.info(
        { campaignId, needed: gate.result.needed, confidence: gate.result.confidence, skip },
        'st-eval gate',
      )
    } catch (err) {
      // Gate failure → skip this cycle; the floor guarantees eventual oversight.
      deps.logger.warn({ err, campaignId }, 'st-eval: gate failed; skipping cycle')
      await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
      return
    }
  }

  if (!shouldEvaluate) {
    await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
    return
  }

  // 4. OPUS ST EVALUATION. GATE INDEPENDENCE: no gate verdict in the input.
  const roster = await deps.repo.characters.listSessionParticipantRoster(sessionId)
  const partyRoster = roster
    .map((r) => `${r.name} (${r.characterClass}, ${r.background})`)
    .join('; ')
  const currentStanding = (await deps.triggerState.readStandingDirection(campaignId)) ?? 'NONE'
  // Peek the pending one-shot WITHOUT consuming it (the turn worker's fresh-run
  // arm is the only consumer). A read-only get; see the trigger-state note.
  const pending = (await deps.triggerState.peekOneShotDirection(campaignId)) ?? 'NONE'

  let evalOut: Awaited<ReturnType<typeof runStDirector>>
  try {
    evalOut = await deps.runDirector({
      partyRoster,
      sdPlaybook,
      runningSummary: summary,
      currentStandingDirective: currentStanding,
      pendingOneShot: pending,
      recentExchanges: formatExchanges(history, ST_EVAL_EXCHANGE_WINDOW),
      windDown,
      // myth-3jna1 — the MODE, never the measurement. The narrative-progress
      // fraction stays on the code side of this call; the ST is told only that
      // it should start aiming the session at a resting point, and it phrases
      // that as craft (the direction the FT eventually reads carries no reason).
      converge: probe.converge,
    })
  } catch (err) {
    // Terminal eval failure → no direction this cycle (BullMQ retry handles
    // transient). Account nothing extra (the wrapper didn't return usage).
    deps.logger.warn({ err, campaignId }, 'st-eval: director failed; no direction this cycle')
    await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
    return
  }

  usageToWrite += usageTokens(evalOut.usage)
  // The ST RAN — reset the floor counter regardless of repair-discard.
  await deps.triggerState.resetTurnsSinceSt(campaignId)

  if (evalOut.repairAttempted) {
    // §4 repair posture: a repaired tree's direction/standing/summary were not
    // authored by the ST — discard ALL of them. Usage is still counted (tokens
    // spent); the counter is reset (the ST ran).
    deps.logger.warn(
      { campaignId },
      'st-eval: repairAttempted — discarding result (no channel write)',
    )
    await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
    return
  }

  // 5. WRITE outputs (each guarded — enhancement, not correctness).
  await writeStOutputs(deps, campaignId, evalOut.result)

  await writeUsageAndReArm(deps, campaignId, sessionId, usageToWrite, watermarkAtStart)
}

/** Step-5 guarded channel writes (one-shot / standing / summary). Each write
 *  is individually guarded — a slot-write failure logs and the world keeps
 *  turning (direction is an enhancement, not correctness). Split from
 *  `processStEvalJob` purely for function-length hygiene. */
async function writeStOutputs(
  deps: StEvalProcessorDeps,
  campaignId: string,
  r: Awaited<ReturnType<typeof runStDirector>>['result'],
): Promise<void> {
  try {
    if (r.intervene && r.direction !== null) {
      await deps.triggerState.setOneShotDirection(campaignId, r.direction)
    }
  } catch (err) {
    deps.logger.warn({ err, campaignId }, 'st-eval: one-shot write failed')
  }
  try {
    if (r.standingDirective.action === 'set' && r.standingDirective.text !== null) {
      await deps.triggerState.setStandingDirection(campaignId, r.standingDirective.text)
    } else if (r.standingDirective.action === 'clear') {
      await deps.triggerState.clearStandingDirection(campaignId)
    }
    // 'keep' (or 'set' with null text — a model error) → no-op.
  } catch (err) {
    deps.logger.warn({ err, campaignId }, 'st-eval: standing write failed')
  }
  try {
    await deps.sessionState.setRunningSummary(campaignId, r.summaryUpdate)
  } catch (err) {
    deps.logger.warn({ err, campaignId }, 'st-eval: summary write failed')
  }
}

async function writeUsageAndReArm(
  deps: StEvalProcessorDeps,
  campaignId: string,
  sessionId: string,
  tokens: number,
  watermarkAtStart: number,
): Promise<void> {
  if (tokens > 0) {
    try {
      await deps.sessionState.incrUsageSt(campaignId, tokens)
    } catch (err) {
      deps.logger.warn({ err, campaignId }, 'st-eval: usage:st incr failed')
    }
  }
  // §2 self-re-arm: newer turns landed mid-evaluation → re-run.
  try {
    const now = await deps.triggerState.respondedSeq(campaignId)
    if (now > watermarkAtStart) await deps.reArm(campaignId, sessionId)
  } catch (err) {
    deps.logger.warn({ err, campaignId }, 'st-eval: re-arm check failed')
  }
}

export function buildStEvaluationWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  logger: MinimalLogger,
): BullmqWorker<StEvalPayload> {
  const repo = createRepo(pool)
  const sessionState = makeSessionState(redisRealtime, redisKeyPrefix)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)
  const queue: StEvalQueueWithDedup = new Queue<StEvalPayload>(QUEUE_ST_EVAL, {
    connection: redisBatch,
  })

  const deps: StEvalProcessorDeps = {
    repo,
    sessionState: {
      loadTurnState: (c) => sessionState.loadTurnState(c),
      setRunningSummary: (c, s) => sessionState.setRunningSummary(c, s),
      totalUsageTokens: (c) => sessionState.totalUsageTokens(c),
      incrUsageSt: (c, t) => sessionState.incrUsageSt(c, t),
    },
    triggerState,
    runGate: runStGate,
    runDirector: runStDirector,
    runNarrativeProgress: runStNarrativeProgress,
    reArm: async (cId, sId) => {
      // Self-re-arm: clear our OWN dedup key (a running job can't be replaced),
      // then re-add. Mirrors dm-trigger-worker's removeDeduplicationKey + add.
      await queue.removeDeduplicationKey(stEvalDedupId(cId))
      await enqueueStEval(queue, { campaignId: cId, sessionId: sId })
    },
    logger,
  }

  return new BullmqWorker<StEvalPayload>(
    QUEUE_ST_EVAL,
    (job: Job<StEvalPayload>) => processStEvalJob(deps, job),
    {
      connection: redisBatch,
      concurrency: ST_EVAL_CONCURRENCY,
      lockDuration: ST_EVAL_LOCK_DURATION_MS,
      stalledInterval: ST_EVAL_STALLED_INTERVAL_MS,
      maxStalledCount: ST_EVAL_MAX_STALLED_COUNT,
    },
  )
}
