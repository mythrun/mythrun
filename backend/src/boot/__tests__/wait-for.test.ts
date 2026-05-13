import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, RETRY_DELAYS_MS } from '../wait-for.js'

describe('waitFor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on first-attempt success', async () => {
    const probe = vi.fn().mockResolvedValue('ok')
    const promise = waitFor({ label: 'svc', probe })
    await expect(promise).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('retries on transient failure and resolves when probe eventually succeeds', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockRejectedValueOnce(new Error('still not ready'))
      .mockResolvedValue('ok')
    const promise = waitFor({ label: 'svc', probe })
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1])
    await expect(promise).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting all attempts; error names label and includes last cause', async () => {
    const lastError = new Error('final failure')
    const probe = vi.fn().mockRejectedValue(lastError)
    const promise = waitFor({ label: 'mySvc', probe })
    // Attach a no-op handler so the rejection during advanceTimersByTimeAsync
    // is never observed as unhandled by Node before our `expect.rejects` runs.
    promise.catch(() => undefined)
    const totalDelay = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    await vi.advanceTimersByTimeAsync(totalDelay)
    await expect(promise).rejects.toThrow(/mySvc/)
    await expect(promise).rejects.toThrow(/final failure/)
    expect(probe).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1)
  })

  it('respects backoff schedule between attempts', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('nope'))
    const promise = waitFor({ label: 'svc', probe })
    promise.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(199)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(promise).rejects.toThrow()
  })

  it('aborts when AbortSignal fires mid-loop', async () => {
    const controller = new AbortController()
    const probe = vi.fn().mockRejectedValue(new Error('nope'))
    const promise = waitFor({ label: 'svc', probe, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(50)
    expect(probe).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    const calls = probe.mock.calls.length
    await vi.advanceTimersByTimeAsync(100_000)
    expect(probe).toHaveBeenCalledTimes(calls)
  })

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const probe = vi.fn()
    const promise = waitFor({ label: 'svc', probe, signal: controller.signal })
    await expect(promise).rejects.toThrow(/abort/i)
    expect(probe).not.toHaveBeenCalled()
  })

  it('throws "aborted" (the loop-top check) when signal aborts after first probe failure but before next retry', async () => {
    // Covers the if (signal?.aborted) branch at the TOP of each loop pass.
    // Sequence: probe fails → loop sleeps via sleepWithAbort → during sleep
    // the controller aborts → sleepWithAbort rejects, the catch handler
    // catches it, the next iteration's top-of-loop signal check throws.
    const controller = new AbortController()
    const probe = vi.fn().mockRejectedValue(new Error('nope'))
    const promise = waitFor({ label: 'midloop', probe, signal: controller.signal })
    promise.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(50) // probe runs + fails
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
  })

  it('handles a signal that aborts between addEventListener registration and the next event loop tick', async () => {
    // Covers the if (signal.aborted) early-return inside sleepWithAbort
    // (lines 44-48). We need signal.aborted to be true at the point
    // sleepWithAbort checks it AFTER setTimeout was scheduled but BEFORE
    // the abort listener was attached. Simulate by patching addEventListener.
    const controller = new AbortController()
    const realAdd = controller.signal.addEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation(
      (event: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
        controller.abort()
        realAdd(event, listener, options)
      },
    )
    const probe = vi.fn().mockRejectedValue(new Error('nope'))
    const promise = waitFor({ label: 'race', probe, signal: controller.signal })
    promise.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).rejects.toThrow(/abort/i)
  })
})
