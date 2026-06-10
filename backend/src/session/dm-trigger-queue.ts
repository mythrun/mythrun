// MYT-67 T7 — the DM-trigger debounce producer (spec §4.2).
//
// `rescheduleDebounce` is a thin BullMQ producer that drives the quiet-window
// timer via BullMQ's DEBOUNCE-MODE deduplication: `{ replace: true, delay }`
// on a stable per-campaign dedup id. While the `evaluate` job is still in its
// delayed state, each subsequent `add` with the same dedup id *replaces* the
// delayed record and resets the `delay` countdown — so a burst of player
// messages collapses onto a single evaluation that fires only after the table
// has been quiet for `delayMs` (verified against BullMQ 5.76.8's Lua).
//
// Deliberately NO `ttl` (fixed during the MYT-68 E2E smoke): with an explicit
// ttl, BullMQ's moveToFinished does NOT clear the dedup key (it only deletes
// keys with no ttl), and replace-mode cannot displace a job that already left
// the delayed state — so every add for up to DEAD_AIR_MS+4s after an
// evaluation fired was SILENTLY SWALLOWED and the DM went untriggerable for
// ~a minute after each turn. Without a ttl the key dies with the job
// (finalization deletes it), so post-evaluation messages schedule fresh. The
// residual swallow window (adds while the evaluate job itself runs, or while
// a turn is in flight) is closed by the turn-worker's post-turn re-mature.
//
// `clampQuietDelay` is the deterministic policy (mechanical computation, not
// cognition) that bounds each reschedule: a full QUIET_WINDOW_MS when nothing is
// yet unresponded, otherwise clamped so the debounce can never push the eventual
// evaluation past `firstUnresponded + MAX_QUIET_EXTENSION_MS` — capping how long
// a steady drip of chatter can starve the DM, and never going negative.

import type { Queue } from 'bullmq'
import {
  QUEUE_DM_TRIGGER,
  DM_TRIGGER_JOB_NAME,
  QUIET_WINDOW_MS,
  MAX_QUIET_EXTENSION_MS,
} from './dm-trigger-config.js'

/** The DM-trigger job payload: a single campaign id. The worker re-derives the
 *  trigger batch from session state at evaluation time, so nothing else rides
 *  the job — the debounce collapses many messages onto one evaluation. */
export interface DmTriggerPayload {
  readonly campaignId: string
}

/** The narrow producer surface the ws-session layer needs: just `add`. The raw
 *  BullMQ Queue is closed at shutdown in server.ts; the session/chat path only
 *  reschedules. Mirrors `TurnQueueLike` from turn-queue.ts. */
export interface DmTriggerQueueLike {
  add: Queue<DmTriggerPayload>['add']
}

/** The WORKER-side queue surface: the evaluate job's self-re-arms (not-quiet,
 *  sit-back-toward-dead-air) must clear their OWN dedup key before re-adding —
 *  a running job cannot be replaced, so a plain dedup'd add from inside the
 *  evaluate is silently swallowed by its own key (found live in the MYT-68
 *  E2E smoke; both §4.3 re-arm paths had been dead in effect since MYT-67).
 *  The SERVER-side producer keeps the narrow `add`-only surface — removing
 *  the key there would defeat the debounce. */
export interface DmTriggerQueueWithDedup extends DmTriggerQueueLike {
  removeDeduplicationKey: Queue<DmTriggerPayload>['removeDeduplicationKey']
}

/** Stable per-campaign dedup id. Every reschedule for a campaign collapses onto
 *  this id, so the debounce window is shared across producers. */
export function dedupId(campaignId: string): string {
  return `dm-trigger:${campaignId}`
}

/** (Re)arm the quiet-window debounce for a campaign. In debounce mode
 *  (`replace: true` + `delay`), an `add` against a still-delayed job resets its
 *  countdown to `delayMs`; the first `add` schedules it. */
export function rescheduleDebounce(
  queue: DmTriggerQueueLike,
  campaignId: string,
  delayMs: number,
): Promise<unknown> {
  return queue.add(
    DM_TRIGGER_JOB_NAME,
    { campaignId },
    {
      deduplication: { id: dedupId(campaignId), replace: true },
      delay: delayMs,
    },
  )
}

/** Bound a reschedule's delay (spec §4.2). With no first-unresponded message,
 *  use the full quiet window. Otherwise clamp to whichever is smaller: the full
 *  window, or the room left before `firstUnresponded + MAX_QUIET_EXTENSION_MS`
 *  — floored at 0 so a crossed ceiling fires immediately rather than negative. */
export function clampQuietDelay(nowMs: number, firstUnrespondedMs: number | null): number {
  if (firstUnrespondedMs === null) return QUIET_WINDOW_MS
  const ceilingRemaining = Math.max(0, firstUnrespondedMs + MAX_QUIET_EXTENSION_MS - nowMs)
  return Math.min(QUIET_WINDOW_MS, ceilingRemaining)
}

export { QUEUE_DM_TRIGGER }
