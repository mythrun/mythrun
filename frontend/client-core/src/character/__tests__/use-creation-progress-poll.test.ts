import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { CharacterCreationProgress } from '../../api/characters.ts'
import { resetTokenManager } from '../../auth/token-manager.ts'
import {
  useCreationProgressPoll,
  creationPollDelay,
  DEFAULT_CREATION_POLL,
  type CreationProgressPollDeps,
  type CreationPollConfig,
} from '../use-creation-progress-poll.ts'
import { CID, VIEWER, testCtx, wrapper, progressOf } from './creation-stream-harness.ts'

// useCreationProgressPoll (myth-qkjdq) — the SSE-INDEPENDENT reliable liveness for
// the character-creation waiting screen. It backoff-polls the durable progress GET
// and flips done/failed off the viewer's OWN concept status, so the screen advances
// even when no SSE frame ever reaches the browser (the CloudFront-edge death). These
// specs pin: the mount poll, the terminal latches, the storm-safe backoff cadence,
// the stop-on-terminal, the calm retry on a failed probe, and the unmount cancel.
// A deterministic backoff (jitter-free, tight spacing) + fake timers drive it.

/** A jitter-free, tight backoff so `vi.advanceTimersByTime` steps are exact. */
const TEST_BACKOFF: CreationPollConfig = { baseMs: 1000, capMs: 2000, factor: 2, jitterMs: 0 }

function renderPoll(fetchProgress: NonNullable<CreationProgressPollDeps['fetchProgress']>) {
  return renderHook(
    () =>
      useCreationProgressPoll(CID, VIEWER, { fetchProgress, backoff: TEST_BACKOFF, rng: () => 0 }),
    { wrapper },
  )
}

/** Flush the microtask queue (a resolved probe's `.then` settles off it). */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  resetTokenManager()
  vi.useRealTimers()
})

describe('creationPollDelay (the storm-safe schedule)', () => {
  it('ramps exponentially then holds at the cap', () => {
    const cfg: CreationPollConfig = { baseMs: 1000, capMs: 5000, factor: 2, jitterMs: 0 }
    expect(creationPollDelay(0, cfg, () => 0)).toBe(1000)
    expect(creationPollDelay(1, cfg, () => 0)).toBe(2000)
    expect(creationPollDelay(2, cfg, () => 0)).toBe(4000)
    // 8000 raw → capped at 5000.
    expect(creationPollDelay(3, cfg, () => 0)).toBe(5000)
    expect(creationPollDelay(4, cfg, () => 0)).toBe(5000)
  })

  it('adds jitter from the rng (0..jitterMs)', () => {
    const cfg: CreationPollConfig = { baseMs: 1000, capMs: 5000, factor: 2, jitterMs: 2000 }
    expect(creationPollDelay(0, cfg, () => 0)).toBe(1000)
    expect(creationPollDelay(0, cfg, () => 1)).toBe(3000)
    expect(creationPollDelay(0, cfg, () => 0.5)).toBe(2000)
  })

  it('the default cadence is calm (~3–5s)', () => {
    expect(DEFAULT_CREATION_POLL.baseMs).toBe(3000)
    expect(creationPollDelay(0, DEFAULT_CREATION_POLL, () => 0)).toBe(3000)
    // Later attempts hold at the 5s cap (+0..1s jitter) — never a burst.
    expect(creationPollDelay(5, DEFAULT_CREATION_POLL, () => 0)).toBe(5000)
  })
})

describe('useCreationProgressPoll', () => {
  it('polls the progress GET once at mount with (ctx, campaignId)', async () => {
    const fetchProgress = vi.fn().mockResolvedValue(progressOf('processing'))
    renderPoll(fetchProgress)
    await flush()
    expect(fetchProgress).toHaveBeenCalledTimes(1)
    expect(fetchProgress).toHaveBeenCalledWith(testCtx, CID)
  })

  it("flips done when the viewer's concept is completed", async () => {
    const { result } = renderPoll(vi.fn().mockResolvedValue(progressOf('completed')))
    await flush()
    expect(result.current.done).toBe(true)
    expect(result.current.failed).toBe(false)
  })

  it("flips failed when the viewer's concept is failed", async () => {
    const { result } = renderPoll(vi.fn().mockResolvedValue(progressOf('failed')))
    await flush()
    expect(result.current.failed).toBe(true)
    expect(result.current.done).toBe(false)
  })

  it('keeps waiting while processing, then advances when a later poll reports completed', async () => {
    vi.useFakeTimers()
    const fetchProgress = vi
      .fn()
      .mockResolvedValueOnce(progressOf('processing'))
      .mockResolvedValueOnce(progressOf('completed'))
    const { result } = renderPoll(fetchProgress)

    // Mount poll → processing → schedule the next at baseMs (1s, jitter-free).
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.done).toBe(false)
    expect(fetchProgress).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fetchProgress).toHaveBeenCalledTimes(2)
    expect(result.current.done).toBe(true)
  })

  it('keeps waiting when the viewer has no concept row yet (neither done nor failed)', async () => {
    vi.useFakeTimers()
    const fetchProgress = vi.fn().mockResolvedValue(progressOf(null))
    const { result } = renderPoll(fetchProgress)
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.done).toBe(false)
    expect(result.current.failed).toBe(false)
    // It re-polls on backoff (the row may appear) rather than giving up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fetchProgress).toHaveBeenCalledTimes(2)
  })

  it('re-polls calmly after a transient probe failure, then advances', async () => {
    vi.useFakeTimers()
    const fetchProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(progressOf('completed'))
    const { result } = renderPoll(fetchProgress)

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.done).toBe(false) // the failed probe did not strand it

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.done).toBe(true)
  })

  it('STOPS polling once terminal — no further fetch after completed', async () => {
    vi.useFakeTimers()
    const fetchProgress = vi.fn().mockResolvedValue(progressOf('completed'))
    renderPoll(fetchProgress)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchProgress).toHaveBeenCalledTimes(1)
    // A finished pipeline is never re-polled — advancing well past a backoff step
    // triggers no second fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchProgress).toHaveBeenCalledTimes(1)
  })

  it('cancels on unmount: a probe that resolves after teardown does not setState', async () => {
    let resolveProbe: ((p: CharacterCreationProgress) => void) | undefined
    const fetchProgress = vi.fn().mockImplementation(
      () =>
        new Promise<CharacterCreationProgress>((resolve) => {
          resolveProbe = resolve
        }),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { result, unmount } = renderPoll(fetchProgress)

    unmount()
    await act(async () => {
      resolveProbe?.(progressOf('completed'))
      await Promise.resolve()
    })
    // The resolve after unmount is a no-op — no setState-after-teardown warning.
    expect(result.current.done).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('cancels on unmount: a probe that REJECTS after teardown schedules no retry', async () => {
    vi.useFakeTimers()
    let rejectProbe: ((e: Error) => void) | undefined
    const fetchProgress = vi.fn().mockImplementation(
      () =>
        new Promise<CharacterCreationProgress>((_resolve, reject) => {
          rejectProbe = reject
        }),
    )
    const { unmount } = renderPoll(fetchProgress)
    unmount()
    await act(async () => {
      rejectProbe?.(new Error('late'))
      await Promise.resolve()
    })
    // No reschedule fired after cancel — no further fetch even far past a step.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchProgress).toHaveBeenCalledTimes(1)
  })

  it('cancels a SCHEDULED poll on unmount — the pending timer never fires', async () => {
    vi.useFakeTimers()
    const fetchProgress = vi.fn().mockResolvedValue(progressOf('processing'))
    const { unmount } = renderPoll(fetchProgress)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchProgress).toHaveBeenCalledTimes(1) // scheduled the next poll
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchProgress).toHaveBeenCalledTimes(1) // the cleared timer never fired
  })

  it('defaults fetchProgress + backoff + rng when no deps are injected', () => {
    // Proves the production defaults wire up (the real GET fires against the
    // unreachable test host and rejects; the calm catch absorbs it). Unmount
    // clears the scheduled retry.
    const { result, unmount } = renderHook(() => useCreationProgressPoll(CID, VIEWER), { wrapper })
    expect(result.current.done).toBe(false)
    expect(result.current.failed).toBe(false)
    expect(() => {
      unmount()
    }).not.toThrow()
  })
})
