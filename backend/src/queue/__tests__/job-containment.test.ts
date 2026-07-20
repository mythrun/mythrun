// backend/src/queue/__tests__/job-containment.test.ts
//
// myth-y2qfi (BUG 1) + myth-3u4a0 (BUG 2): the worker-resilience primitives.
//
//   - withJobTimeout       — hard wall-clock bound on ONE external await; a
//                            trip throws the cross-workstream {terminal:true}
//                            shape so BullMQ does NOT retry an unrecoverable job.
//   - containProcessor     — processor-boundary containment: any in-chain throw
//                            (sync or async) becomes a logged job failure.
//   - createProcessEscapeGuard — the LAST line of defence for a FLOATING
//                            rejection that escapes every job boundary (the
//                            2026-07-19 crash). Logs + keeps the process ALIVE
//                            so one bad job can't kill all nine queues, with a
//                            crash-loop escape hatch on a systemic storm.
//   - describeErrorForLog  — secret-free error descriptor for structured logs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from 'bullmq'
import {
  withJobTimeout,
  JOB_TIMEOUT_CODE,
  containProcessor,
  createProcessEscapeGuard,
  describeErrorForLog,
} from '../job-containment.js'
import { isTerminalError } from '../../llm/errors.js'

function fakeJob(overrides: Partial<Job> = {}): Job {
  return { id: 'j1', name: 'unit-job', ...overrides } as unknown as Job
}

function collectingLogger(): {
  error: (obj: Record<string, unknown>, msg?: string) => void
  calls: { obj: Record<string, unknown>; msg: string | undefined }[]
} {
  const calls: { obj: Record<string, unknown>; msg: string | undefined }[] = []
  return {
    error: (obj, msg) => {
      calls.push({ obj, msg })
    },
    calls,
  }
}

describe('withJobTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the work value when work wins the race', async () => {
    const p = withJobTimeout(Promise.resolve('ok'), 1000, 'work')
    await expect(p).resolves.toBe('ok')
  })

  it('propagates the work rejection unchanged when work rejects before the timeout', async () => {
    const boom = new Error('boom')
    const p = withJobTimeout(Promise.reject(boom), 1000, 'work')
    await expect(p).rejects.toBe(boom)
  })

  it('throws the {terminal:true} contract shape when the timer wins', async () => {
    // A never-settling await — models the staging hang (myth-3u4a0).
    const p = withJobTimeout(new Promise<never>(() => undefined), 5000, 'char-stage')
    const assertion = expect(p).rejects.toMatchObject({
      terminal: true,
      code: JOB_TIMEOUT_CODE,
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    // isTerminalError (the shared predicate) must route it to the no-retry path.
    await p.catch((err: unknown) => {
      expect(isTerminalError(err)).toBe(true)
      expect(err instanceof Error && err.message).toMatch(/char-stage/)
      expect(err instanceof Error && err.message).toMatch(/5000/)
    })
  })

  it('does not leak a timer when work wins (timer cleared)', async () => {
    const p = withJobTimeout(Promise.resolve(1), 10_000, 'work')
    await expect(p).resolves.toBe(1)
    // No pending timers remain — the finally-clear ran.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('containProcessor', () => {
  it('passes through the processor result and logs nothing on success', async () => {
    const logger = collectingLogger()
    const wrapped = containProcessor('world-gen', () => Promise.resolve('done'), logger)
    await expect(wrapped(fakeJob())).resolves.toBe('done')
    expect(logger.calls).toHaveLength(0)
  })

  it('contains an ASYNC throw: the job fails (promise rejects) and is logged structured', async () => {
    const logger = collectingLogger()
    const err = new Error('async failure')
    const wrapped = containProcessor('session-prep', () => Promise.reject(err), logger)
    await expect(wrapped(fakeJob({ id: 'jp', name: 'session-prep' }))).rejects.toBe(err)
    expect(logger.calls).toHaveLength(1)
    expect(logger.calls[0]?.obj).toMatchObject({
      component: 'worker',
      event: 'job.contained_failure',
      queue: 'session-prep',
      jobId: 'jp',
    })
  })

  it('contains a SYNCHRONOUS throw inside the processor body (job fails, process fine)', async () => {
    const logger = collectingLogger()
    // A processor that throws synchronously before returning a promise — the
    // failure mode the boundary must convert into a job rejection rather than
    // let escape as an uncaught exception.
    const wrapped = containProcessor(
      'campaign-setup',
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => {
        throw new TypeError('cannot read property of undefined')
      },
      logger,
    )
    await expect(wrapped(fakeJob())).rejects.toBeInstanceOf(TypeError)
    expect(logger.calls[0]?.obj.event).toBe('job.contained_failure')
  })
})

describe('createProcessEscapeGuard', () => {
  it('logs and KEEPS THE PROCESS ALIVE for a single escape (no storm)', () => {
    const logger = collectingLogger()
    const onStorm = vi.fn()
    const guard = createProcessEscapeGuard({ logger, onStorm, threshold: 25, windowMs: 60_000 })

    // The 2026-07-19 crash shape: a floating LlmStructuredOutputError.
    guard.onUnhandledRejection(Object.assign(new Error('structured output failed'), {
      code: 'llm_structured_output_failed',
      terminal: true,
    }))

    expect(logger.calls).toHaveLength(1)
    expect(logger.calls[0]?.obj).toMatchObject({
      component: 'worker',
      event: 'process.escape',
      kind: 'unhandledRejection',
    })
    // Survives — no fail-fast for an isolated escape.
    expect(onStorm).not.toHaveBeenCalled()
  })

  it('records uncaughtException as an escape too', () => {
    const logger = collectingLogger()
    const onStorm = vi.fn()
    const guard = createProcessEscapeGuard({ logger, onStorm })
    guard.onUncaughtException(new Error('boom'))
    expect(logger.calls[0]?.obj.kind).toBe('uncaughtException')
    expect(onStorm).not.toHaveBeenCalled()
  })

  it('fails fast (onStorm) once the rolling-window threshold is exceeded', () => {
    const logger = collectingLogger()
    const onStorm = vi.fn()
    let clock = 0
    const guard = createProcessEscapeGuard({
      logger,
      onStorm,
      threshold: 3,
      windowMs: 1000,
      now: () => clock,
    })
    // 3 escapes inside the window: at threshold, not yet over.
    guard.onUnhandledRejection(new Error('1'))
    guard.onUnhandledRejection(new Error('2'))
    guard.onUnhandledRejection(new Error('3'))
    expect(onStorm).not.toHaveBeenCalled()
    // The 4th within-window escape crosses the threshold → fail fast, once.
    guard.onUnhandledRejection(new Error('4'))
    expect(onStorm).toHaveBeenCalledTimes(1)
    expect(onStorm).toHaveBeenCalledWith({ count: 4, windowMs: 1000 })
    // Idempotent — a 5th escape does not re-fire the storm.
    guard.onUnhandledRejection(new Error('5'))
    expect(onStorm).toHaveBeenCalledTimes(1)
  })

  it('prunes escapes outside the rolling window (isolated-over-time does not storm)', () => {
    const logger = collectingLogger()
    const onStorm = vi.fn()
    let clock = 0
    const guard = createProcessEscapeGuard({
      logger,
      onStorm,
      threshold: 2,
      windowMs: 1000,
      now: () => clock,
    })
    guard.onUnhandledRejection(new Error('a')) // t=0
    clock = 2000
    guard.onUnhandledRejection(new Error('b')) // t=2000, 'a' pruned
    clock = 4000
    guard.onUnhandledRejection(new Error('c')) // t=4000, 'b' pruned
    // Never more than 1 within any 1000ms window → no storm.
    expect(onStorm).not.toHaveBeenCalled()
  })

  it('is a no-op while shutting down (a rejection racing teardown must not exit)', () => {
    const logger = collectingLogger()
    const onStorm = vi.fn()
    const guard = createProcessEscapeGuard({
      logger,
      onStorm,
      threshold: 1,
      windowMs: 1000,
      isShuttingDown: () => true,
    })
    guard.onUnhandledRejection(new Error('during shutdown'))
    guard.onUnhandledRejection(new Error('during shutdown'))
    expect(logger.calls).toHaveLength(0)
    expect(onStorm).not.toHaveBeenCalled()
  })

  it('install() registers real process listeners and returns a disposer that removes them', () => {
    const logger = collectingLogger()
    const guard = createProcessEscapeGuard({ logger, onStorm: vi.fn() })
    const before = process.listenerCount('unhandledRejection')
    const beforeUncaught = process.listenerCount('uncaughtException')
    const dispose = guard.install()
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1)
    dispose()
    expect(process.listenerCount('unhandledRejection')).toBe(before)
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught)
  })
})

describe('describeErrorForLog', () => {
  it('extracts only secret-free scalar fields (name, code, terminal, capped message)', () => {
    const err = Object.assign(new LlmLikeError('llm returned unparseable structured output'), {
      code: 'llm_structured_output_failed',
      terminal: true,
      // A secret-bearing diagnostic — MUST NOT appear in the descriptor.
      diagnostic: { rawTextSnippet: 'SECRET sd_playbook: the NPC is actually the killer' },
    })
    const d = describeErrorForLog(err)
    expect(d).toEqual({
      name: 'LlmLikeError',
      code: 'llm_structured_output_failed',
      terminal: true,
      message: 'llm returned unparseable structured output',
    })
    // No secret-bearing fields leaked through.
    expect(JSON.stringify(d)).not.toMatch(/SECRET|sd_playbook|killer/)
  })

  it('caps an over-long message and handles non-Error throws', () => {
    const long = describeErrorForLog(new Error('x'.repeat(500)))
    expect(long.message.length).toBeLessThanOrEqual(120)
    const nonErr = describeErrorForLog('a raw string')
    expect(nonErr).toMatchObject({ name: 'NonError', code: null, terminal: false })
  })
})

class LlmLikeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmLikeError'
  }
}
