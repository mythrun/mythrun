// backend/src/routes/ws-trigger-actions.ts
//
// MYT-67 §4.1/§4.2/§4.5 — the server-side DM-trigger ACTIONS the WS inbound
// handler routes onto. Extracted from ws-session.ts so the route file stays
// under the module-size budget; the handler in ws-session.ts owns the per-frame
// branching + the persist-then-broadcast contract, and delegates the trigger
// side effects (debounce reschedule, explicit fast-path) to these helpers.
//
// Each helper takes the WS deps + the per-connection logger explicitly (rather
// than the route's ConnCtx) so this module has a one-way TYPE-only dependency on
// ws-session.ts (no runtime cycle). All effects are best-effort from the
// handler's perspective: a queue/Redis failure logs at WARN and never throws —
// the player_message that triggered the action is already persisted+broadcast.

import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { WsSessionDeps } from './ws-session.js'
import { rescheduleDebounce, clampQuietDelay } from '../session/dm-trigger-queue.js'
import { enqueueTurn } from '../session/turn-queue.js'
import { buildTurnBatch } from '../session/turn-batch.js'

/** MYT-67 §4.5: the explicit-summon rate limit. `INCR` a per-(campaign,user)
 *  key with a 60s expiry; a count above this ceiling drops the summon (the
 *  first WS frame that triggers real LLM spend — an unbounded `@dm` is a cost +
 *  griefing surface, so this is a policy-enforcement ZFC carve-out). */
const EXPLICIT_RATE_MAX = 10
const EXPLICIT_RATE_WINDOW_S = 60

/** True when a player_message's trimmed text begins with the literal `@dm`
 *  (case-insensitive) — the "@dm, …" explicit summon gesture (§4.5). A purely
 *  structural prefix check (ZFC structural carve-out), NOT semantic analysis. */
export function isExplicitText(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith('@dm')
}

/** Reschedule the per-campaign quiet-window debounce (§4.2), clamped by the
 *  max-wait anti-starvation ceiling. A queue failure is logged at WARN and
 *  swallowed — the message is already persisted+broadcast; a sustained outage
 *  is observable via the log, not a silent never-fires (§4.2/§9). */
export async function rescheduleQuietWindow(
  deps: WsSessionDeps,
  log: FastifyBaseLogger,
  campaignId: string,
  now: number,
): Promise<void> {
  const { triggerState, dmTriggerQueue } = deps
  try {
    const firstUnresponded = await triggerState.firstUnrespondedMs(campaignId)
    await rescheduleDebounce(dmTriggerQueue, campaignId, clampQuietDelay(now, firstUnresponded))
  } catch (err) {
    log.warn({ err, campaignId }, 'ws-session debounce reschedule failed')
  }
}

/** §4.5 the EXPLICIT fast-path. Rate-limit first (per campaign+user, 60s
 *  window); over the ceiling → drop + log. Then: if no turn is in flight,
 *  allocate the turnId, broadcast `dm_thinking` IMMEDIATELY (input locks before
 *  any enqueue/lock latency), build the turn batch from the watermark, and
 *  enqueue the `session-turn` directly. If a turn IS in flight, set the
 *  explicit-pending flag so the in-flight turn drains it on release (§4.7). */
export async function runExplicitTrigger(
  deps: WsSessionDeps,
  log: FastifyBaseLogger,
  userId: string,
  campaignId: string,
  sessionId: string,
): Promise<void> {
  const { repo, triggerState, turnPublisher, sessionTurnQueue, redisRealtime, redisKeyPrefix } = deps

  // Rate limit (§4.5): INCR a per-(campaign,user) key; set the 60s expiry on the
  // first increment. Over the ceiling → drop (a deliberate ice-out is cheap; an
  // unbounded `@dm` is a cost + griefing surface — policy-enforcement carve-out).
  const rateKey = `${redisKeyPrefix}explicit-rate:${campaignId}:${userId}`
  const count = await redisRealtime.incr(rateKey)
  if (count === 1) {
    await redisRealtime.expire(rateKey, EXPLICIT_RATE_WINDOW_S)
  }
  if (count > EXPLICIT_RATE_MAX) {
    log.warn({ campaignId, userId, count }, 'ws-session explicit summon rate-limited — dropped')
    return
  }

  // If a turn is already in flight, the room is already iced out (input locked
  // by that turn). Set the explicit-pending flag — the session-turn worker
  // drains it the instant the current turn releases (§4.7). No new enqueue.
  if (await triggerState.isResponding(campaignId)) {
    await triggerState.setExplicitPending(campaignId)
    return
  }

  // No turn in flight: ice out the room NOW. Allocate the turnId and broadcast
  // dm_thinking BEFORE the batch build + enqueue, so every client greys its
  // input ahead of any queue/lock latency. The worker's own later dm_thinking
  // for the same turnId is a client no-op (dedup on turnId).
  const turnId = randomUUID()
  await turnPublisher.dmThinking(campaignId, turnId)

  // Build the turn batch from the responded-seq watermark (§4.3). Input is now
  // locked, so nothing contaminates this frozen-at-invoke batch.
  const lastRespondedSeq = await triggerState.respondedSeq(campaignId)
  const { batch, maxSeq } = await buildTurnBatch(repo, campaignId, sessionId, lastRespondedSeq)

  await enqueueTurn(sessionTurnQueue, {
    campaignId,
    sessionId,
    turnId,
    triggerMessages: batch,
    maxConsumedSeq: maxSeq,
    trigger: { kind: 'explicit' },
  })
}
