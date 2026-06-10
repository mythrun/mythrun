// backend/src/session/dm-trigger-worker.ts
//
// MYT-67 T9 (spec §4.3) — the dm-trigger worker: the ORDERED decision shell that
// runs when the quiet-window debounce job matures. It decides WHETHER the AI DM
// should take a turn now (dead-air / explicit / solo / auto), and if so enqueues
// exactly one `session-turn` job carrying the freshly-derived batch. The DECISION
// (this worker) is kept cleanly separate from the EXECUTION (`session-turn`
// worker, MYT-66) — this module never touches the lock or the conductor.
//
// `processDmTriggerJob(deps, job)` takes ALL dependencies as injected struct
// params (no broker, no Redis, no DB, no LLM constructed inside), so the whole
// decision tree is unit-testable with plain fakes. `buildDmTriggerWorker(...)`
// is the boot-wiring that constructs the real deps over the worker.ts Redis
// connections and returns the BullMQ Worker.
//
// The ordered logic (spec §4.3):
//   1. Re-validate quiet — a reset that landed in the promote→pickup window
//      means we fired too early; re-arm the debounce for the remaining quiet and
//      exit (NOT a bare exit — that would strand the trigger; §4.2).
//   2. Resolve the active session + the responded-seq watermark, then build the
//      `(lastRespondedSeq, max]` batch. No session / empty batch → exit. The
//      empty-batch exit IS the no-monologue guard (§4.3 step 2).
//   3. Decide in order: dead-air ceiling → explicit pending → solo → auto
//      (Haiku classifier). A sit-back / no-turn auto decision re-arms toward the
//      dead-air mark and exits.
//   4. Drain guard + enqueue: if a turn is in flight, do NOT enqueue (the
//      post-turn re-mature drains it — §4.7); else enqueue one `session-turn`
//      and structured-log the decision (the §4.9 dev signal).
//
// The classifier is ST-side-adjacent infrastructure: its output
// (shouldRespond/intent/complexity) is consumed by CODE only and never reaches
// a player or the Fast Thinker — exactly like the MYT-69 Haiku gate. As of
// MYT-69 the running summary it reads as scene grounding deliberately carries
// secret-adjacent state (rapport/ladder); that is acceptable because there is
// no output path from this call to a player-facing surface (the §4.4
// "public-only" framing is superseded by "no output path to a player-facing
// surface").

import { Worker as BullmqWorker, Queue, type Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'

import { classifyDmTrigger, type DmTriggerContext } from '../llm/dm-trigger-classifier.js'
import type { DmTriggerClassification } from '../llm/schemas/dm-trigger-classification.js'
import { createRepo, type Repo } from '../repo/index.js'
import type { Pool } from 'pg'
import { makeSessionState } from '../redis/session-state.js'
import {
  QUEUE_DM_TRIGGER,
  QUIET_WINDOW_MS,
  DEAD_AIR_MS,
  DM_TRIGGER_CONCURRENCY,
  DM_TRIGGER_LOCK_DURATION_MS,
  DM_TRIGGER_STALLED_INTERVAL_MS,
  DM_TRIGGER_MAX_STALLED_COUNT,
} from './dm-trigger-config.js'
import {
  dedupId,
  rescheduleDebounce as rescheduleDebounceProducer,
  type DmTriggerPayload,
  type DmTriggerQueueWithDedup,
} from './dm-trigger-queue.js'
import { makeTriggerState } from './trigger-state.js'
import { buildTurnBatch } from './turn-batch.js'
import type { TriggerMessage } from './tiers/types.js'
import {
  enqueueTurn as enqueueTurnProducer,
  QUEUE_SESSION_TURN,
  type TurnJobPayload,
  type TurnQueueLike,
} from './turn-queue.js'

/** Minimal pino-compatible logger surface (mirrors turn-worker.ts). */
interface MinimalLogger {
  info: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
  warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
  error: (objOrMsg: Record<string, unknown> | string, msg?: string) => void
}

/** The narrow `TriggerState` slice this worker reads — only the four coordination
 *  reads/takes the decision tree needs, so a unit-test fake stays tiny. */
interface TriggerStateReads {
  lastActivityMs(campaignId: string): Promise<number | null>
  respondedSeq(campaignId: string): Promise<number>
  isResponding(campaignId: string): Promise<boolean>
  takeExplicitPending(campaignId: string): Promise<boolean>
}

/** The narrow repo slice this worker reads. */
interface RepoReads {
  readonly sessions: { getActiveByCampaign(campaignId: string): Promise<{ id: string } | null> }
  readonly campaigns: { countAcceptedMembers(campaignId: string): Promise<number> }
}

/** The narrow session-state slice — the running summary is read here as scene
 *  grounding (used as both `lastDmOutput` and `sceneGrounding`); post-MYT-69 it
 *  carries secret-adjacent state, acceptable because this call's output never
 *  reaches a player-facing surface (ST-side-adjacent infra). */
interface SessionStateReads {
  loadTurnState(campaignId: string): Promise<{ summary: string }>
}

export interface DmTriggerProcessorDeps {
  readonly triggerState: TriggerStateReads
  readonly repo: RepoReads
  readonly sessionState: SessionStateReads
  /** The shared `(lastRespondedSeq, max]` → `TriggerMessage[]` builder. Injected
   *  so the unit tests need no repo. */
  buildTurnBatch(
    campaignId: string,
    sessionId: string,
    lastRespondedSeq: number,
  ): Promise<{ batch: TriggerMessage[]; maxSeq: number }>
  /** The Haiku classifier (real in prod; a fake in unit tests). */
  classify(ctx: DmTriggerContext): Promise<DmTriggerClassification>
  /** Enqueue one `session-turn` job. */
  enqueueTurn(payload: TurnJobPayload): Promise<void>
  /** (Re)arm the quiet-window debounce for the campaign. */
  rescheduleDebounce(campaignId: string, delayMs: number): Promise<void>
  /** Allocate the turn id (`randomUUID` in prod; fixed in tests). */
  randomTurnId(): string
  /** Injectable clock so the re-validation guard is deterministic in tests. */
  now(): number
  readonly logger: MinimalLogger
}

/** A decision that opens a turn: the trigger metadata for the payload. */
type TriggerDecision = TurnJobPayload['trigger']

/**
 * Run the ordered dm-trigger decision for one matured debounce job (spec §4.3).
 * Enqueues at most one `session-turn`, or re-arms the debounce and exits. Never
 * throws on a "no turn this cycle" outcome — the caller's fail-closed posture
 * (§9) only catches a real classifier/IO failure.
 */
export async function processDmTriggerJob(
  deps: DmTriggerProcessorDeps,
  job: { data: DmTriggerPayload },
): Promise<void> {
  const { campaignId } = job.data
  const nowMs = deps.now()

  // 1. Re-validate quiet. A reset that landed in the promote→pickup window means
  //    we matured too early; re-arm for the remaining quiet and exit (a bare exit
  //    would strand the trigger until the next activity — §4.2/§4.3 step 1).
  const lastActivity = (await deps.triggerState.lastActivityMs(campaignId)) ?? 0
  const sinceLastActivity = nowMs - lastActivity
  if (sinceLastActivity < QUIET_WINDOW_MS) {
    await deps.rescheduleDebounce(campaignId, QUIET_WINDOW_MS - sinceLastActivity)
    return
  }

  // 2. Resolve the active session + watermark, then build the batch. The same
  //    batch is both the classifier input and the turn's triggerMessages, so
  //    decision and execution can never diverge (§4.3 step 2).
  const session = await deps.repo.sessions.getActiveByCampaign(campaignId)
  if (session === null) return

  const lastRespondedSeq = await deps.triggerState.respondedSeq(campaignId)
  const { batch, maxSeq } = await deps.buildTurnBatch(campaignId, session.id, lastRespondedSeq)
  // Empty batch = the no-monologue guard: a proactive open can only fire when an
  // unresponded player message exists (§4.3 step 2).
  if (batch.length === 0) return

  // 3. Decide (in order). Each branch resolves to a TriggerDecision (open a turn)
  //    or a re-arm (auto sit-back). The enqueue-with-drain-guard is step 4.
  const decision = await decide(deps, { campaignId, batch, sinceLastActivity })
  if (decision === null) return

  // 4. Drain guard + enqueue. If a turn is in flight, do NOT enqueue — the
  //    post-turn re-mature drains it (§4.7).
  if (await deps.triggerState.isResponding(campaignId)) return

  const payload: TurnJobPayload = {
    campaignId,
    sessionId: session.id,
    turnId: deps.randomTurnId(),
    triggerMessages: batch,
    maxConsumedSeq: maxSeq,
    trigger: decision.trigger,
  }
  await deps.enqueueTurn(payload)

  // §4.9 dev signal — structured log of the decision (NOT on the player transport).
  deps.logger.info(
    {
      campaignId,
      kind: decision.trigger.kind,
      shouldRespond: true,
      intent: decision.trigger.classification?.intent,
      confidence: decision.trigger.classification?.confidence,
      reason: decision.reason,
      at: nowMs,
    },
    'dm-trigger decision',
  )
}

/** The §4.3 step-3 ordered mode decision. Returns the trigger metadata + a debug
 *  reason when a turn should open, or `null` when no turn fires this cycle (the
 *  auto sit-back branch re-arms the debounce here before returning null). */
async function decide(
  deps: DmTriggerProcessorDeps,
  args: { campaignId: string; batch: readonly TriggerMessage[]; sinceLastActivity: number },
): Promise<{ trigger: TriggerDecision; reason: string } | null> {
  const { campaignId, batch, sinceLastActivity } = args

  // Dead-air ceiling — total silence ≥ DEAD_AIR_MS forces a proactive step-in,
  // skipping the classifier. The non-empty batch (step 2) is the no-monologue
  // guard, so this can't fire back-to-back. The in-flight check is in step 4
  // (we still gate the enqueue on isResponding for every branch).
  if (sinceLastActivity >= DEAD_AIR_MS && !(await deps.triggerState.isResponding(campaignId))) {
    return {
      trigger: {
        kind: 'auto',
        classification: { intent: 'proactive', complexity: 'high', confidence: 1 },
      },
      reason: 'dead-air ceiling',
    }
  }

  // Explicit pending — an `@dm`/`dm_invoke` landed while a turn was in flight;
  // drain it now, skipping the classifier (take-once via GETDEL).
  if (await deps.triggerState.takeExplicitPending(campaignId)) {
    return { trigger: { kind: 'explicit' }, reason: 'explicit pending' }
  }

  // Solo — a 1-accepted-member campaign always gets a DM beat, no classifier.
  if ((await deps.repo.campaigns.countAcceptedMembers(campaignId)) === 1) {
    return { trigger: { kind: 'solo' }, reason: 'solo campaign' }
  }

  // Auto — the real Haiku classifier over the public context (§4.4).
  const summary = await loadSummary(deps, campaignId)
  const grounding = summary === '' ? null : summary
  const c = await deps.classify({
    messages: batch.map((m) => ({ characterName: m.characterName, text: m.text })),
    lastDmOutput: grounding,
    turnsSinceLastDmBeat: batch.length,
    secondsSinceLastDmBeat: Math.floor(sinceLastActivity / 1000),
    sceneGrounding: grounding,
  })

  if (c.shouldRespond) {
    return {
      trigger: {
        kind: 'auto',
        classification: { intent: c.intent, complexity: c.complexity, confidence: c.confidence },
      },
      reason: c.reason,
    }
  }

  // Sit-back / no turn — re-arm toward the dead-air mark so the 60s backstop
  // still fires if the silence persists (§4.3 step 3, auto false). Any new
  // activity reschedules it back to the normal quiet window.
  await deps.rescheduleDebounce(campaignId, DEAD_AIR_MS - sinceLastActivity)
  return null
}

/** Read the running summary — the scene material the classifier grounds on
 *  (secret-adjacent post-MYT-69; ST-side-adjacent infra — output is code-only). */
async function loadSummary(deps: DmTriggerProcessorDeps, campaignId: string): Promise<string> {
  const { summary } = await deps.sessionState.loadTurnState(campaignId)
  return summary
}

/** The constructed collaborators `makeDmTriggerDeps` wraps into a
 *  `DmTriggerProcessorDeps`. Kept narrow (only the surfaces the forwarding
 *  closures touch) so a unit test can pass recording fakes and assert each thin
 *  closure delegates to the right producer/builder with the right arguments. */
export interface DmTriggerDepsParts {
  readonly triggerState: TriggerStateReads
  readonly repo: RepoReads
  readonly sessionState: SessionStateReads
  readonly dmTriggerQueue: DmTriggerQueueWithDedup
  readonly sessionTurnQueue: TurnQueueLike
  readonly classify: (ctx: DmTriggerContext) => Promise<DmTriggerClassification>
  // Property-style (not method-style) so `parts.randomTurnId` / `parts.now` are
  // plain function values the forwarder can hold without an unbound-this hazard.
  readonly randomTurnId: () => string
  readonly now: () => number
  readonly logger: MinimalLogger
}

/**
 * Assemble the `DmTriggerProcessorDeps` from the constructed collaborators. The
 * three forwarding closures (`buildTurnBatch` → the shared batch builder over the
 * repo; `enqueueTurn` / `rescheduleDebounce` → the two BullMQ producers) live
 * here, split out of `buildDmTriggerWorker` so they are invoked — and thus
 * covered — by a direct unit test with recording fakes, rather than only through
 * the full boot path. Pure wiring: no IO of its own.
 *
 * `repo` is typed `Repo` because `buildTurnBatch` reads several repo namespaces;
 * the worker's own reads stay through the narrow `RepoReads` slice.
 */
export function makeDmTriggerDeps(repo: Repo, parts: DmTriggerDepsParts): DmTriggerProcessorDeps {
  const { dmTriggerQueue, sessionTurnQueue } = parts
  return {
    triggerState: parts.triggerState,
    repo: parts.repo,
    sessionState: parts.sessionState,
    buildTurnBatch: (campaignId, sessionId, lastRespondedSeq) =>
      buildTurnBatch(repo, campaignId, sessionId, lastRespondedSeq),
    classify: parts.classify,
    enqueueTurn: async (payload) => {
      await enqueueTurnProducer(sessionTurnQueue, payload)
    },
    rescheduleDebounce: async (campaignId, delayMs) => {
      // Self-re-arm from inside the running evaluate: clear our OWN dedup key
      // first — replace-mode cannot displace a non-delayed job, so without
      // this the re-arm add is swallowed by the key this very job holds
      // (see DmTriggerQueueWithDedup). A racing server-side add between the
      // remove and the add just lands first and debounces ours — harmless.
      await dmTriggerQueue.removeDeduplicationKey(dedupId(campaignId))
      await rescheduleDebounceProducer(dmTriggerQueue, campaignId, delayMs)
    },
    randomTurnId: parts.randomTurnId,
    now: parts.now,
    logger: parts.logger,
  }
}

/**
 * Build the dm-trigger BullMQ Worker for the dedicated worker.ts process.
 *
 * Like `buildSessionTurnWorker`, this runs in worker.ts (NOT the API server),
 * which has already waitFor-probed `redisBatch` (the shared BullMQ connection)
 * and `redisRealtime`. The producers ride `redisBatch`; the coordination /
 * turn state rides `redisRealtime`. The classifier is the real Haiku call; the
 * clock is the wall clock.
 */
export function buildDmTriggerWorker(
  redisBatch: Redis,
  redisRealtime: Redis,
  redisKeyPrefix: string,
  pool: Pool,
  logger: MinimalLogger,
): BullmqWorker<DmTriggerPayload> {
  const repo: Repo = createRepo(pool)
  const triggerState = makeTriggerState(redisRealtime, redisKeyPrefix)
  const sessionState = makeSessionState(redisRealtime, redisKeyPrefix)

  const dmTriggerQueue: DmTriggerQueueWithDedup = new Queue<DmTriggerPayload>(QUEUE_DM_TRIGGER, {
    connection: redisBatch,
  })
  const sessionTurnQueue: TurnQueueLike = new Queue<TurnJobPayload>(QUEUE_SESSION_TURN, {
    connection: redisBatch,
  })

  const deps = makeDmTriggerDeps(repo, {
    triggerState,
    repo,
    sessionState,
    dmTriggerQueue,
    sessionTurnQueue,
    classify: classifyDmTrigger,
    randomTurnId: () => randomUUID(),
    now: () => Date.now(),
    logger,
  })

  return new BullmqWorker<DmTriggerPayload>(
    QUEUE_DM_TRIGGER,
    (job: Job<DmTriggerPayload>) => processDmTriggerJob(deps, job),
    {
      connection: redisBatch,
      concurrency: DM_TRIGGER_CONCURRENCY,
      lockDuration: DM_TRIGGER_LOCK_DURATION_MS,
      stalledInterval: DM_TRIGGER_STALLED_INTERVAL_MS,
      maxStalledCount: DM_TRIGGER_MAX_STALLED_COUNT,
    },
  )
}
