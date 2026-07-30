// Transport dispatchers + observable fetch for all Anthropic calls
// (outage-resilience design §1.1, normative).
//
// Two undici Agents with distinct timeout profiles: streaming requests get a
// tight headers/body leash (headers arrive in seconds on a healthy stream, so
// their absence means a hang); non-streaming requests get the 300s backstop
// (long Opus thinking calls legitimately hold the connection silent). The
// dispatcher is picked mechanically per request off the provider's JSON body:
// a string body containing `"stream":true` routes streaming; a NON-STRING
// body routes non-streaming (fail-safe — we never sniff Request/FormData/
// binary bodies).
//
// npm-undici's Agent + fetch are used together deliberately: mixing an
// npm-undici Agent into Node's GLOBAL fetch is unsupported (a transitive
// undici@5 also exists in the lockfile, which is why §1.2 matches undici
// errors by `code`, never `instanceof`).

import { Agent, fetch as undiciFetch } from 'undici'

export interface FetchObservation {
  readonly mode: 'streaming' | 'non-streaming'
  readonly headersArrived: boolean
  readonly invocationCount: number
}

export interface DispatcherTimeouts {
  readonly connectTimeoutMs: number
  readonly headersTimeoutMs: number
  readonly bodyTimeoutMs: number
}

export interface DispatcherOverrides {
  readonly streaming?: Partial<DispatcherTimeouts>
  readonly nonStreaming?: Partial<DispatcherTimeouts>
}

export interface LlmDispatchers {
  readonly streaming: Agent
  readonly nonStreaming: Agent
}

// §1.1 timeout table, verbatim.
const STREAMING_TIMEOUTS: DispatcherTimeouts = {
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 60_000,
  bodyTimeoutMs: 120_000,
}
const NON_STREAMING_TIMEOUTS: DispatcherTimeouts = {
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 300_000,
  bodyTimeoutMs: 300_000,
}

function buildAgent(timeouts: DispatcherTimeouts): Agent {
  return new Agent({
    connect: { timeout: timeouts.connectTimeoutMs },
    headersTimeout: timeouts.headersTimeoutMs,
    bodyTimeout: timeouts.bodyTimeoutMs,
  })
}

/**
 * Build the streaming + non-streaming dispatcher pair. `overrides` exists for
 * tests (the stall-server integration test injects sub-second timeouts to
 * assert the real undici error CODE paths without waiting out the production
 * numbers); production callers take the §1.1 defaults.
 */
export function createDispatchers(overrides?: DispatcherOverrides): LlmDispatchers {
  return {
    streaming: buildAgent({ ...STREAMING_TIMEOUTS, ...overrides?.streaming }),
    nonStreaming: buildAgent({ ...NON_STREAMING_TIMEOUTS, ...overrides?.nonStreaming }),
  }
}

const defaultDispatchers = createDispatchers()

interface MutableObservation {
  mode: 'streaming' | 'non-streaming'
  headersArrived: boolean
  invocationCount: number
}

/**
 * Build a per-attempt fetch: routes by body (`"stream":true` → streaming
 * dispatcher, non-string body → non-streaming), records a last-invocation-wins
 * observation. SDK-internal retries share one abort signal, so each invocation
 * gets its OWN record and `observation()` reports only the latest — attempt
 * 1's late headers-arrival can never pollute attempt 2's classification.
 */
export function createObservedFetch(dispatchers: LlmDispatchers = defaultDispatchers): {
  fetch: typeof globalThis.fetch
  observation: () => FetchObservation | null
} {
  let latest: MutableObservation | null = null
  let invocations = 0

  const observedFetch: typeof undiciFetch = async (input, init) => {
    const streaming = typeof init?.body === 'string' && init.body.includes('"stream":true')
    const record: MutableObservation = {
      mode: streaming ? 'streaming' : 'non-streaming',
      headersArrived: false,
      invocationCount: ++invocations,
    }
    latest = record
    const response = await undiciFetch(input, {
      ...init,
      dispatcher: streaming ? dispatchers.streaming : dispatchers.nonStreaming,
    })
    record.headersArrived = true
    return response
  }

  return {
    // THE pre-authorized type assertion (design §1.1). npm-undici ships its
    // own Request/Response d.ts that is structurally incompatible with the
    // global fetch types in BOTH directions (probe: undici Response's header
    // iterators lack Symbol.dispose; global Request lacks undici's duplex).
    // Runtime is fully compatible for everything the AI SDK sends (string
    // URL + plain init with string body). The SDK's FetchFunction is
    // `typeof globalThis.fetch`, so presenting that shape here means
    // models.ts and every downstream consumer stay cast-free.
    fetch: observedFetch as unknown as typeof globalThis.fetch,
    observation: () => (latest === null ? null : { ...latest }),
  }
}

/**
 * The default provider fetch used by models.ts. Same routing as
 * `createObservedFetch`; the per-invocation observation is created and
 * discarded (nothing reads it — per-attempt classification wraps its own
 * observed fetch around each attempt instead).
 */
export function providerFetch(): typeof globalThis.fetch {
  return createObservedFetch().fetch
}
