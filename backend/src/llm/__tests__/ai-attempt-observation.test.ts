// backend/src/llm/__tests__/ai-attempt-observation.test.ts
//
// Outage-resilience Task 4 — the SIGNAL-IDENTITY PIN (design §1.1/§1.3).
//
// The per-attempt observation exchange works only because the AI SDK's
// mergeAbortSignals SHORT-CIRCUITS a single signal: when ai.ts passes ONE
// abortSignal and no SDK `timeout`, the exact same AbortSignal instance
// reaches the provider's fetch as init.signal, where llm-fetch's registry
// (keyed by signal identity) records the {mode, headersArrived} observation.
//
// This test drives the REAL 'ai' SDK and the REAL @ai-sdk/anthropic provider
// (no vi.mock('ai')) over providerFetch(), with only the undici layer mocked.
// If an SDK upgrade breaks the merge short-circuit (wrapping the signal), the
// registry misses, the observation comes back null, and the sink report's
// mode collapses to null — failing THIS test loudly instead of silently
// degrading every §1.2 dispatcher-aware classification.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  // vi.fn() is new-able — stands in for the Agent class; the dispatcher the
  // mocked fetch receives is never used.
  return { ...actual, Agent: vi.fn(), fetch: vi.fn() }
})

import * as undici from 'undici'
import { createAnthropic } from '@ai-sdk/anthropic'
import { providerFetch } from '../llm-fetch.js'
import { generateObject, setLlmHealthSink } from '../ai.js'
import { logger } from '../logger.js'

const mockFetch = vi.mocked(undici.fetch)

describe('signal-identity pin: per-attempt observation through the REAL SDK chain', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    setLlmHealthSink(null)
    vi.restoreAllMocks()
  })

  it('the fetch sees the exact AbortSignal the attempt registered — mode reaches the sink', async () => {
    const capturedSignals: (AbortSignal | null | undefined)[] = []
    mockFetch.mockImplementation((_input, init) => {
      capturedSignals.push(init?.signal)
      return Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      )
    })

    const provider = createAnthropic({ apiKey: 'test-key', fetch: providerFetch() })
    const model = provider('claude-test-model')

    const sink = vi.fn()
    setLlmHealthSink(sink)

    await expect(
      generateObject({
        model,
        schema: z.object({ name: z.string() }),
        prompt: 'pick a name',
        callSite: 'pin/signal-identity',
        // Below the 60s default expectedHealthyDurationMs → exactly one
        // attempt, no retries to wait out.
        stageBudgetMs: 30_000,
      }),
    ).rejects.toThrow()

    // The provider called fetch exactly once (loop-scoped calls run with
    // SDK maxRetries: 0) and passed a real AbortSignal.
    expect(capturedSignals).toHaveLength(1)
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal)

    // THE PIN: mode 'streaming' in the report proves BOTH halves at once —
    // the loop drove streaming transport (§1.0: the provider body carried
    // "stream":true) AND the registry matched the attempt's signal by
    // IDENTITY through ai.ts → SDK → provider → llm-fetch. A broken
    // short-circuit surfaces here as mode: null.
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      callsite: 'pin/signal-identity',
      failureClass: 'connectivity',
      mode: 'streaming',
    })
  })

  it('with an external opts.abortSignal the registered COMPOSITE signal still reaches the fetch by identity', async () => {
    const capturedSignals: (AbortSignal | null | undefined)[] = []
    mockFetch.mockImplementation((_input, init) => {
      capturedSignals.push(init?.signal)
      return Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      )
    })

    const provider = createAnthropic({ apiKey: 'test-key', fetch: providerFetch() })
    const model = provider('claude-test-model')

    const sink = vi.fn()
    setLlmHealthSink(sink)
    // Never aborted — present only so the attempt registers the
    // AbortSignal.any([attemptController.signal, external]) composite.
    const external = new AbortController()

    await expect(
      generateObject({
        model,
        schema: z.object({ name: z.string() }),
        prompt: 'pick a name',
        callSite: 'pin/signal-identity-external',
        stageBudgetMs: 30_000,
        abortSignal: external.signal,
      }),
    ).rejects.toThrow()

    expect(capturedSignals).toHaveLength(1)
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal)
    // The registry key is the COMPOSITE, not the external signal — if the SDK
    // ever passed the external signal (or a re-wrap) to fetch instead, the
    // identity lookup would miss and mode would collapse to null below.
    expect(capturedSignals[0]).not.toBe(external.signal)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      callsite: 'pin/signal-identity-external',
      failureClass: 'connectivity',
      mode: 'streaming',
    })
  })
})
