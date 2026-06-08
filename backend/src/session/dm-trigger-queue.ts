// MYT-67 T7 — the DM-trigger debounce producer (spec §4.2).
//
// `rescheduleDebounce` is a thin BullMQ producer that drives the quiet-window
// timer via BullMQ's DEBOUNCE-MODE deduplication: `{ replace: true, ttl, delay }`
// on a stable per-campaign dedup id. While the `evaluate` job is still in its
// delayed state, each subsequent `add` with the same dedup id *replaces* the
// delayed record and resets the `delay` countdown — so a burst of player
// messages collapses onto a single evaluation that fires only after the table
// has been quiet for `delayMs` (research-verified against BullMQ 5.76.8). The
// `ttl` (DEDUP_TTL_MS = DEAD_AIR_MS + 4s) keeps the dedup key alive across the
// whole quiet window so concurrent producers keep landing on the same id.
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
  DEDUP_TTL_MS,
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
      deduplication: { id: dedupId(campaignId), replace: true, ttl: DEDUP_TTL_MS },
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
