// backend/src/llm/__tests__/llm-fetch.test.ts
//
// Unit tests for the transport dispatchers (outage-resilience design §1.1).
// Mock strategy: vi.mock('undici') replaces `Agent` (constructor args captured
// via vi.hoisted so the module-scoped default dispatchers built at import time
// are observable too) and `fetch` (a vi.fn we stage per test). Everything else
// (notably `Response`) is the real undici module, so staged resolutions type
// as undici responses without casts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { agentCtorArgs } = vi.hoisted(() => {
  const ctorArgs: { opts: unknown; instance: unknown }[] = []
  return { agentCtorArgs: ctorArgs }
})

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  class MockAgent {
    constructor(opts: unknown) {
      agentCtorArgs.push({ opts, instance: this })
    }
  }
  return { ...actual, Agent: MockAgent, fetch: vi.fn() }
})

import * as undici from 'undici'
import { createDispatchers, createObservedFetch, providerFetch } from '../llm-fetch.js'

const mockFetch = vi.mocked(undici.fetch)

// The module-scoped default dispatchers are constructed once at import, before
// any test runs — snapshot those two Agent constructions before beforeEach
// clears the capture array.
const defaultAgentCtorArgs = agentCtorArgs.slice()

const STREAMING_DEFAULTS = { connect: { timeout: 10_000 }, headersTimeout: 60_000, bodyTimeout: 120_000 }
const NON_STREAMING_DEFAULTS = { connect: { timeout: 10_000 }, headersTimeout: 300_000, bodyTimeout: 300_000 }

function okResponse(): undici.Response {
  return new undici.Response('ok')
}

function dispatcherOfCall(callIndex: number): unknown {
  const init = mockFetch.mock.calls[callIndex]?.[1]
  return init?.dispatcher
}

beforeEach(() => {
  mockFetch.mockReset()
  agentCtorArgs.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createDispatchers', () => {
  it('module-scoped defaults carry the §1.1 timeout numbers verbatim', () => {
    expect(defaultAgentCtorArgs.map((a) => a.opts)).toEqual([STREAMING_DEFAULTS, NON_STREAMING_DEFAULTS])
  })

  it('builds streaming and non-streaming agents with the §1.1 defaults', () => {
    const dispatchers = createDispatchers()
    expect(agentCtorArgs.map((a) => a.opts)).toEqual([STREAMING_DEFAULTS, NON_STREAMING_DEFAULTS])
    expect(agentCtorArgs[0]?.instance).toBe(dispatchers.streaming)
    expect(agentCtorArgs[1]?.instance).toBe(dispatchers.nonStreaming)
  })

  it('applies per-dispatcher overrides while keeping unoverridden numbers', () => {
    createDispatchers({
      streaming: { headersTimeoutMs: 250 },
      nonStreaming: { bodyTimeoutMs: 500, connectTimeoutMs: 100 },
    })
    expect(agentCtorArgs.map((a) => a.opts)).toEqual([
      { connect: { timeout: 10_000 }, headersTimeout: 250, bodyTimeout: 120_000 },
      { connect: { timeout: 100 }, headersTimeout: 300_000, bodyTimeout: 500 },
    ])
  })
})

describe('createObservedFetch — dispatcher routing', () => {
  it('routes "stream":true bodies to the streaming dispatcher, others to non-streaming', async () => {
    mockFetch.mockResolvedValue(okResponse())
    const dispatchers = createDispatchers()
    const { fetch } = createObservedFetch(dispatchers)

    await fetch('http://localhost/v1/messages', { method: 'POST', body: '{"model":"m","stream":true}' })
    await fetch('http://localhost/v1/messages', { method: 'POST', body: '{"model":"m"}' })

    expect(dispatcherOfCall(0)).toBe(dispatchers.streaming)
    expect(dispatcherOfCall(1)).toBe(dispatchers.nonStreaming)
  })

  it('non-string body routes non-streaming (fail-safe)', async () => {
    mockFetch.mockResolvedValue(okResponse())
    const dispatchers = createDispatchers()
    const { fetch, observation } = createObservedFetch(dispatchers)

    // A Request input carrying "stream":true in its (non-sniffed) body.
    await fetch(new Request('http://localhost/v1/messages', { method: 'POST', body: '{"stream":true}' }))
    // A FormData init body.
    await fetch('http://localhost/v1/messages', { method: 'POST', body: new FormData() })
    // Binary bytes that CONTAIN the marker still route non-streaming.
    await fetch('http://localhost/v1/messages', {
      method: 'POST',
      body: new TextEncoder().encode('{"stream":true}'),
    })
    // No init at all.
    await fetch('http://localhost/v1/messages')

    for (const i of [0, 1, 2, 3]) {
      expect(dispatcherOfCall(i)).toBe(dispatchers.nonStreaming)
    }
    expect(observation()).toEqual({ mode: 'non-streaming', headersArrived: true, invocationCount: 4 })
  })
})

describe('createObservedFetch — observation', () => {
  it('returns null before any invocation', () => {
    const { observation } = createObservedFetch(createDispatchers())
    expect(observation()).toBeNull()
  })

  it('records headersArrived=true once the response resolves; false while pending', async () => {
    let resolveFetch: (r: undici.Response) => void = () => undefined
    mockFetch.mockReturnValue(
      new Promise<undici.Response>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const { fetch, observation } = createObservedFetch(createDispatchers())

    const pending = fetch('http://localhost/v1/messages', { method: 'POST', body: '{"stream":true}' })
    expect(observation()).toEqual({ mode: 'streaming', headersArrived: false, invocationCount: 1 })

    resolveFetch(okResponse())
    await pending
    expect(observation()).toEqual({ mode: 'streaming', headersArrived: true, invocationCount: 1 })
  })

  it('keeps headersArrived=false when the fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('connect timeout'))
    const { fetch, observation } = createObservedFetch(createDispatchers())

    await expect(fetch('http://localhost/v1/messages', { method: 'POST', body: '{"model":"m"}' })).rejects.toThrow(
      'connect timeout',
    )
    expect(observation()).toEqual({ mode: 'non-streaming', headersArrived: false, invocationCount: 1 })
  })

  it('last-invocation-wins: two sequential invocations leave the second observation', async () => {
    mockFetch.mockResolvedValue(okResponse())
    const { fetch, observation } = createObservedFetch(createDispatchers())

    await fetch('http://localhost/v1/messages', { method: 'POST', body: '{"stream":true}' })
    await fetch('http://localhost/v1/messages', { method: 'POST', body: '{"model":"m"}' })

    expect(observation()).toEqual({ mode: 'non-streaming', headersArrived: true, invocationCount: 2 })
  })

  it('a stale invocation resolving late cannot pollute the latest observation', async () => {
    // SDK-internal retries share one signal: attempt 1's late headers-arrival
    // must not flip attempt 2's pending observation (§1.1 last-invocation-wins).
    let resolveFirst: (r: undici.Response) => void = () => undefined
    mockFetch
      .mockReturnValueOnce(
        new Promise<undici.Response>((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockReturnValueOnce(new Promise<undici.Response>(() => undefined))
    const { fetch, observation } = createObservedFetch(createDispatchers())

    const first = fetch('http://localhost/v1/messages', { method: 'POST', body: '{"stream":true}' })
    void fetch('http://localhost/v1/messages', { method: 'POST', body: '{"stream":true}' })
    expect(observation()).toEqual({ mode: 'streaming', headersArrived: false, invocationCount: 2 })

    resolveFirst(okResponse())
    await first
    expect(observation()).toEqual({ mode: 'streaming', headersArrived: false, invocationCount: 2 })
  })
})

describe('providerFetch', () => {
  it('routes through the module-scoped default dispatchers and discards its observation', async () => {
    mockFetch.mockResolvedValue(okResponse())
    const fetch = providerFetch()

    await fetch('http://localhost/v1/messages', { method: 'POST', body: '{"stream":true}' })
    await fetch('http://localhost/v1/messages', { method: 'POST', body: '{"model":"m"}' })

    expect(dispatcherOfCall(0)).toBe(defaultAgentCtorArgs[0]?.instance)
    expect(dispatcherOfCall(1)).toBe(defaultAgentCtorArgs[1]?.instance)
  })
})
