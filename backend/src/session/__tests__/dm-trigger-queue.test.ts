// MYT-67 T7 — DM-trigger debounce producer (`dm-trigger-queue.ts`, spec §4.2).
//
// `rescheduleDebounce` is a thin BullMQ producer that uses the DEBOUNCE-MODE
// deduplication option (`replace:true` + `delay` + `ttl`) as the spec's
// quiet-window timer: each `add` with the same dedup id, while the job is still
// delayed, resets the countdown (research-verified against BullMQ 5.76.8). The
// CORRECTNESS here is the exact arg shape passed to `queue.add`, which a
// recording fake (`{ add: vi.fn() }`) asserts without a real broker.
//
// `clampQuietDelay` is the deterministic policy that bounds each reschedule's
// delay: a full QUIET_WINDOW_MS when there is no first-unresponded timestamp,
// otherwise clamped so the debounce never extends past
// firstUnresponded + MAX_QUIET_EXTENSION_MS (and never goes negative).

import { describe, expect, it, vi } from 'vitest'
import {
  DEDUP_TTL_MS,
  QUIET_WINDOW_MS,
  MAX_QUIET_EXTENSION_MS,
} from '../dm-trigger-config.js'
import {
  rescheduleDebounce,
  clampQuietDelay,
  dedupId,
  type DmTriggerQueueLike,
} from '../dm-trigger-queue.js'

describe('rescheduleDebounce — debounce-mode add (MYT-67 T7)', () => {
  it('adds the evaluate job with replace+ttl dedup and the given delay', async () => {
    const add = vi.fn(() => Promise.resolve({ id: 'job-1' }))
    const fake = { add } as unknown as DmTriggerQueueLike

    await rescheduleDebounce(fake, 'c1', 4000)

    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(
      'evaluate',
      { campaignId: 'c1' },
      {
        deduplication: { id: 'dm-trigger:c1', replace: true, ttl: DEDUP_TTL_MS },
        delay: 4000,
      },
    )
  })

  it('derives the dedup id from the campaign id', () => {
    expect(dedupId('c1')).toBe('dm-trigger:c1')
  })
})

describe('clampQuietDelay — quiet-window policy (MYT-67 T7)', () => {
  it('returns the full quiet window when there is no first-unresponded timestamp', () => {
    expect(clampQuietDelay(10_000, null)).toBe(QUIET_WINDOW_MS)
  })

  it('clamps the delay to the remaining ceiling room when that is smaller than the window', () => {
    const firstUnresponded = 100_000
    const now = firstUnresponded + 29_000
    // ceilingRemaining = firstUnresponded + 30_000 - now = 1_000; min(4000, 1000) = 1000
    expect(clampQuietDelay(now, firstUnresponded)).toBe(
      Math.min(QUIET_WINDOW_MS, firstUnresponded + MAX_QUIET_EXTENSION_MS - now),
    )
    expect(clampQuietDelay(now, firstUnresponded)).toBe(1_000)
  })

  it('never returns a negative delay once the ceiling has been crossed', () => {
    const firstUnresponded = 100_000
    const now = firstUnresponded + 31_000
    expect(clampQuietDelay(now, firstUnresponded)).toBe(0)
  })
})
