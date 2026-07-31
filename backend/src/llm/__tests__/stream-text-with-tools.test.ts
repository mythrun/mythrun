// backend/src/llm/__tests__/stream-text-with-tools.test.ts
//
// MYT-68 Task 6 — tests for the FT tool-loop wrapper `streamTextWithTools`
// in ai.ts, plus the new GenerateObjectOpts.abortSignal external-abort
// threading.
//
// Mock strategy mirrors ai.test.ts: vi.mock('ai') replaces the SDK boundary
// (streamText + generateText) with vi.fn()s, leaving everything else actual.
// We NEVER mock the ai.ts wrapper itself — that's the unit under test.
//
// NOT covered here: the real SDK's `totalUsage` getter eagerly starts
// consuming a tee'd branch of the response stream on access — that eager-
// access-vs-fullStream-iteration interaction is covered only by the
// real-Anthropic E2E smoke, not these unit tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { SONNET } from '../models.js'

const streamTextMock = vi.fn()
const generateTextMock = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    streamText: (...args: unknown[]): unknown => streamTextMock(...args),
    generateText: (...args: unknown[]): unknown => generateTextMock(...args),
    Output: { object: vi.fn((opts: unknown) => opts) },
  }
})

import { streamTextWithTools, generateObject, stepCountIs, setLlmHealthSink } from '../ai.js'

function makeUsage(input = 100, output = 50): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output }
}

// A minimal fake fullStream yielding a single text-delta part.
function makeFullStream(parts: readonly unknown[]): AsyncIterable<unknown> {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async generator is required to satisfy AsyncIterable; the body has no await by design.
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p
    },
  }
}

describe('streamTextWithTools', () => {
  beforeEach(() => {
    streamTextMock.mockReset()
    generateTextMock.mockReset()
    vi.useRealTimers()
  })

  it('passthrough: parts iterate unchanged and stepUsage/totalUsage resolve to the SDK promises', async () => {
    const u1 = makeUsage(200, 80)
    const u2 = makeUsage(900, 300)
    const part = { type: 'text-delta', id: '1', text: 'hello' }
    streamTextMock.mockReturnValueOnce({
      fullStream: makeFullStream([part]),
      usage: Promise.resolve(u1),
      totalUsage: Promise.resolve(u2),
    })

    const r = streamTextWithTools({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      stopWhen: stepCountIs(4),
      callSite: 'test/passthrough',
    })

    const seen: unknown[] = []
    for await (const p of r.fullStream) seen.push(p)
    expect(seen).toEqual([part])

    await expect(r.stepUsage).resolves.toEqual(u1)
    await expect(r.totalUsage).resolves.toEqual(u2)
  })

  it('normalizes bare PromiseLike usage/totalUsage (SDK surface) into real Promises', async () => {
    // The real SDK types usage/totalUsage as PromiseLike, NOT Promise — no
    // .catch method. This test hands the wrapper hand-rolled thenables (not
    // instanceof Promise) to prove the Promise.resolve normalization in
    // streamTextWithTools is load-bearing: without it, the guarded
    // `.catch(...)` would throw and the returned fields wouldn't be Promises.
    const u1 = makeUsage(11, 7)
    const u2 = makeUsage(99, 33)
    function makeThenable<T>(value: T): PromiseLike<T> {
      return {
        then<R1 = T, R2 = never>(
          onFulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
          onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ): PromiseLike<R1 | R2> {
          void onRejected
          const result = onFulfilled !== undefined && onFulfilled !== null
            ? onFulfilled(value)
            : (value as unknown as R1)
          return makeThenable(result as R1)
        },
      }
    }
    const usageThenable = makeThenable(u1)
    const totalThenable = makeThenable(u2)
    expect(usageThenable).not.toBeInstanceOf(Promise)
    expect(totalThenable).not.toBeInstanceOf(Promise)

    streamTextMock.mockReturnValueOnce({
      fullStream: makeFullStream([]),
      usage: usageThenable,
      totalUsage: totalThenable,
    })

    const r = streamTextWithTools({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      stopWhen: stepCountIs(4),
      callSite: 'test/thenable-normalization',
    })

    expect(r.stepUsage).toBeInstanceOf(Promise)
    expect(r.totalUsage).toBeInstanceOf(Promise)
    await expect(r.stepUsage).resolves.toEqual(u1)
    await expect(r.totalUsage).resolves.toEqual(u2)
  })

  it('guarded promises: rejecting usage promises do not crash with an unhandled rejection', async () => {
    streamTextMock.mockReturnValueOnce({
      fullStream: makeFullStream([{ type: 'text-delta', id: '1', text: 'x' }]),
      usage: Promise.reject(new Error('usage boom')),
      totalUsage: Promise.reject(new Error('total boom')),
    })

    const r = streamTextWithTools({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      stopWhen: stepCountIs(4),
      callSite: 'test/guarded',
    })

    // Drain the stream, never await the usages.
    for await (const _p of r.fullStream) {
      void _p
    }
    // Tick the event loop — if the wrapper didn't pre-attach catch handlers,
    // Node would surface an unhandledRejection here.
    await new Promise((resolve) => setImmediate(resolve))

    // An explicit awaiter still observes the rejection.
    await expect(r.stepUsage).rejects.toThrow('usage boom')
    await expect(r.totalUsage).rejects.toThrow('total boom')
  })

  it('threading: passes tools, providerOptions, messages, stopWhen, abortSignal, prepareStep, maxOutputTokens to streamText', () => {
    streamTextMock.mockReturnValueOnce({
      fullStream: makeFullStream([]),
      usage: Promise.resolve(makeUsage()),
      totalUsage: Promise.resolve(makeUsage()),
    })

    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hi' },
    ]
    const tools = {}
    const stopWhen = stepCountIs(6)
    const prepareStep = vi.fn()
    const providerOptions = { mythrun: { callSite: 'ft-turn' } }

    streamTextWithTools({
      model: SONNET,
      messages,
      tools,
      stopWhen,
      prepareStep,
      providerOptions,
      maxOutputTokens: 4096,
      callSite: 'test/threading',
    })

    const callArgs = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArgs.model).toBe(SONNET)
    expect(callArgs.messages).toBe(messages)
    expect(callArgs.tools).toBe(tools)
    expect(callArgs.stopWhen).toBe(stopWhen)
    expect(callArgs.prepareStep).toBe(prepareStep)
    expect(callArgs.providerOptions).toEqual(providerOptions)
    expect(callArgs.maxOutputTokens).toBe(4096)
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('omits prepareStep, maxOutputTokens, providerOptions when not supplied', () => {
    streamTextMock.mockReturnValueOnce({
      fullStream: makeFullStream([]),
      usage: Promise.resolve(makeUsage()),
      totalUsage: Promise.resolve(makeUsage()),
    })

    streamTextWithTools({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      stopWhen: stepCountIs(4),
      callSite: 'test/omit',
    })

    const callArgs = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty('prepareStep')
    expect(callArgs).not.toHaveProperty('maxOutputTokens')
    expect(callArgs).not.toHaveProperty('providerOptions')
  })

  // Outage-resilience §1.2: streamTextWithTools never throws — errors surface
  // as in-band stream parts — so it gains an error/abort-part OBSERVER that
  // classifies and reports connectivity-class failures BEFORE yielding the
  // part through. The part itself is never altered or withheld.
  it('reports classified connectivity error parts before yielding them', async () => {
    const events: string[] = []
    setLlmHealthSink((report) => {
      events.push(`report:${report.failureClass}`)
    })
    try {
      const connErr = Object.assign(new Error('stream transport died'), { code: 'ECONNRESET' })
      const errorPart = { type: 'error', error: connErr }
      const textPart = { type: 'text-delta', id: '1', text: 'x' }
      streamTextMock.mockReturnValueOnce({
        fullStream: makeFullStream([errorPart, textPart]),
        usage: Promise.resolve(makeUsage()),
        totalUsage: Promise.resolve(makeUsage()),
      })

      const r = streamTextWithTools({
        model: SONNET,
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        stopWhen: stepCountIs(4),
        callSite: 'test/observer-error-part',
      })

      const seen: unknown[] = []
      for await (const p of r.fullStream) {
        events.push(`part:${(p as { type: string }).type}`)
        seen.push(p)
      }
      // The report fires BEFORE the error part is yielded through; the parts
      // themselves pass unchanged.
      expect(events).toEqual(['report:connectivity', 'part:error', 'part:text-delta'])
      expect(seen).toEqual([errorPart, textPart])
    } finally {
      setLlmHealthSink(null)
    }
  })

  it('abort parts and non-connectivity error parts yield through without a report', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    try {
      const abortPart = { type: 'abort' }
      const appErrPart = { type: 'error', error: new Error('tool blew up') }
      streamTextMock.mockReturnValueOnce({
        fullStream: makeFullStream([abortPart, appErrPart]),
        usage: Promise.resolve(makeUsage()),
        totalUsage: Promise.resolve(makeUsage()),
      })

      const r = streamTextWithTools({
        model: SONNET,
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        stopWhen: stepCountIs(4),
        callSite: 'test/observer-no-report',
      })

      const seen: unknown[] = []
      for await (const p of r.fullStream) seen.push(p)
      expect(seen).toEqual([abortPart, appErrPart])
      expect(sink).not.toHaveBeenCalled()
    } finally {
      setLlmHealthSink(null)
    }
  })

  it('a primitive in-band error part yields through without a report or attached class', async () => {
    const sink = vi.fn()
    setLlmHealthSink(sink)
    try {
      // §1.2: a primitive error classifies 'other' (no report) and
      // attachFailureClass has nothing to attach to — the part must still
      // pass through untouched.
      const primitivePart = { type: 'error', error: 'string boom' }
      streamTextMock.mockReturnValueOnce({
        fullStream: makeFullStream([primitivePart]),
        usage: Promise.resolve(makeUsage()),
        totalUsage: Promise.resolve(makeUsage()),
      })

      const r = streamTextWithTools({
        model: SONNET,
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        stopWhen: stepCountIs(4),
        callSite: 'test/observer-primitive-error',
      })

      const seen: unknown[] = []
      for await (const p of r.fullStream) seen.push(p)
      expect(seen).toEqual([primitivePart])
      expect(sink).not.toHaveBeenCalled()
    } finally {
      setLlmHealthSink(null)
    }
  })

  it('timeout cancel: the timer is cleared once usage settles (does not abort after settle)', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    let capturedSignal: AbortSignal | undefined
    streamTextMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal
      return {
        fullStream: makeFullStream([]),
        usage: Promise.resolve(makeUsage()),
        totalUsage: Promise.resolve(makeUsage()),
      }
    })

    const r = streamTextWithTools({
      model: SONNET,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      stopWhen: stepCountIs(4),
      callSite: 'test/timeout-cancel',
      timeoutMs: 1000,
    })

    // Let the usage promise resolve so the cancel-on-settle handler runs.
    await r.stepUsage
    expect(clearSpy).toHaveBeenCalled()

    // Advance well past the timeout; the signal must NOT abort.
    vi.advanceTimersByTime(5000)
    expect(capturedSignal?.aborted).toBe(false)
  })
})

describe('generateObject external abortSignal', () => {
  const TestSchema = z.object({ name: z.string() })

  beforeEach(() => {
    streamTextMock.mockReset()
    generateTextMock.mockReset()
    vi.useRealTimers()
  })

  it('aborts the SDK signal when the external signal fires', async () => {
    let captured: AbortSignal | undefined
    generateTextMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      captured = opts.abortSignal
      return Promise.resolve({ output: { name: 'x' }, usage: makeUsage() })
    })

    const external = new AbortController()
    await generateObject<{ name: string }>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/external-abort',
      abortSignal: external.signal,
    })

    expect(captured).toBeInstanceOf(AbortSignal)
    expect(captured?.aborted).toBe(false)
    external.abort()
    expect(captured?.aborted).toBe(true)
  })

  it('passes a timeout-only AbortSignal when no external signal supplied', async () => {
    let captured: AbortSignal | undefined
    generateTextMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      captured = opts.abortSignal
      return Promise.resolve({ output: { name: 'x' }, usage: makeUsage() })
    })

    await generateObject<{ name: string }>({
      model: SONNET,
      schema: TestSchema,
      prompt: 'p',
      callSite: 'test/no-external-abort',
    })

    expect(captured).toBeInstanceOf(AbortSignal)
    expect(captured?.aborted).toBe(false)
  })
})
