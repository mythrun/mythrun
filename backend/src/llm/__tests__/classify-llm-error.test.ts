// backend/src/llm/__tests__/classify-llm-error.test.ts
//
// Fixture table for the §1.2 error taxonomy (LLM outage-resilience design,
// docs/superpowers/specs/2026-07-30-llm-outage-resilience-design.md).
// Every branch of the unwrap walk has a fixture — the backend runs a 100%
// coverage gate on this module.
//
// Fixtures construct AI SDK errors via their real constructors, but the
// module under test matches by STRING properties only (name / code /
// statusCode / type) — two undici realms exist in the lockfile, so
// instanceof is forbidden there.

import { describe, it, expect } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { classifyLlmError } from '../classify-llm-error.js'
import type { LlmFailureVerdict } from '../classify-llm-error.js'
import { LlmTimeoutError, LlmOverloadedError, LlmRateLimitedError } from '../errors.js'

const und = (code: string): Error => Object.assign(new Error(code), { code })
const CTX_S = { mode: 'streaming', headersArrived: false } as const
const CTX_NS = { mode: 'non-streaming', headersArrived: false } as const

const CONNECTIVITY: LlmFailureVerdict = {
  retryWorthy: true,
  outageSignal: true,
  failureClass: 'connectivity',
}
const OTHER: LlmFailureVerdict = {
  retryWorthy: false,
  outageSignal: false,
  failureClass: 'other',
}

const apiCallError = (opts: { statusCode?: number; cause?: unknown; message?: string }): APICallError =>
  new APICallError({
    message: opts.message ?? 'upstream failure',
    url: '',
    requestBodyValues: {},
    ...(opts.statusCode !== undefined ? { statusCode: opts.statusCode } : {}),
    ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
  })

describe('classifyLlmError', () => {
  it('headers timeout (bare undici code) → connectivity both axes', () => {
    expect(classifyLlmError(und('UND_ERR_HEADERS_TIMEOUT'), CTX_S)).toEqual({
      retryWorthy: true, outageSignal: true, failureClass: 'connectivity',
    })
  })

  it('incident shape: APICallError wrapping the undici error, no statusCode', () => {
    const e = new APICallError({ message: 'Cannot connect to API: Headers Timeout Error', url: '', requestBodyValues: {}, cause: und('UND_ERR_HEADERS_TIMEOUT') })
    expect(classifyLlmError(e, CTX_NS).failureClass).toBe('connectivity')
  })

  it('RetryError [headers-timeout, abort]: outage axis sees ANY member', () => {
    const e = new RetryError({ message: 'Failed after 2 attempts.', reason: 'maxRetriesExceeded', errors: [und('UND_ERR_HEADERS_TIMEOUT'), new LlmTimeoutError('llm call aborted')] })
    const v = classifyLlmError(e, CTX_NS)
    expect(v.outageSignal).toBe(true) // any-member rule
  })

  it('mid-body death: statusCode 200 wrapper recurses into cause', () => {
    const e = new APICallError({ message: 'Failed to process successful response', url: '', requestBodyValues: {}, statusCode: 200, cause: new TypeError('terminated', { cause: und('UND_ERR_BODY_TIMEOUT') }) })
    expect(classifyLlmError(e, CTX_S).failureClass).toBe('connectivity')
  })

  it('in-band raw payload: overloaded_error object', () => {
    expect(classifyLlmError({ type: 'overloaded_error', message: 'Overloaded' }, CTX_S).failureClass).toBe('connectivity')
  })

  it('429 → retry-worthy, never signal, rate-limit class', () => {
    const e = new APICallError({ message: 'rate', url: '', requestBodyValues: {}, statusCode: 429 })
    expect(classifyLlmError(e, CTX_NS)).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'rate-limit' })
  })

  it('pre-headers abort: streaming → connectivity; non-streaming → abort, no signal', () => {
    const abort = new LlmTimeoutError('llm call aborted')
    expect(classifyLlmError(abort, CTX_S).outageSignal).toBe(true)
    expect(classifyLlmError(abort, CTX_NS)).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'abort' })
  })

  it('post-headers abort → other axis pair, non-retry', () => {
    const abort = new LlmTimeoutError('llm call aborted')
    expect(classifyLlmError(abort, { mode: 'streaming', headersArrived: true })).toEqual({ retryWorthy: false, outageSignal: false, failureClass: 'abort' })
  })

  it('LlmOverloadedError (mapped 529) → connectivity', () => {
    expect(classifyLlmError(new LlmOverloadedError('overloaded'), CTX_S).outageSignal).toBe(true)
  })

  it('schema/validation error → other, no retry', () => {
    expect(classifyLlmError(new Error('schema mismatch'), CTX_S)).toEqual({ retryWorthy: false, outageSignal: false, failureClass: 'other' })
  })

  it('cause-chain depth bound: 6-deep connectivity is NOT found (bounded at 5)', () => {
    let e: Error = und('ECONNRESET')
    for (let i = 0; i < 6; i++) e = new Error(`w${String(i)}`, { cause: e })
    expect(classifyLlmError(e, CTX_S).failureClass).toBe('other')
  })

  it('cause-chain depth bound: 5-deep connectivity IS found', () => {
    let e: Error = und('ECONNRESET')
    for (let i = 0; i < 5; i++) e = new Error(`w${String(i)}`, { cause: e })
    expect(classifyLlmError(e, CTX_S).failureClass).toBe('connectivity')
  })

  // §1.2 walk item 6 — every base-case code classifies connectivity on both axes.
  it.each([
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPROTO',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ])('code %s → connectivity pair', (code) => {
    expect(classifyLlmError(und(code), CTX_S)).toEqual(CONNECTIVITY)
    expect(classifyLlmError(und(code), CTX_NS)).toEqual(CONNECTIVITY)
  })

  it('a code outside every connectivity family (llm_rate_limited, no cause) → other', () => {
    expect(classifyLlmError(new LlmRateLimitedError('limited'), CTX_S)).toEqual(OTHER)
  })

  // §1.2 walk item 3 — HTTP statuses via APICallError.statusCode (≥400 only).
  it.each([500, 502, 503, 504, 529])('HTTP %i → connectivity pair', (status) => {
    expect(classifyLlmError(apiCallError({ statusCode: status }), CTX_NS)).toEqual(CONNECTIVITY)
  })

  it.each([400, 404, 501])('HTTP %i (unlisted status) → other, no retry', (status) => {
    expect(classifyLlmError(apiCallError({ statusCode: status }), CTX_NS)).toEqual(OTHER)
  })

  // §1.2 walk item 1 — RetryError edge shapes.
  it('RetryError with all-non-connectivity members → other (retry axis from last member)', () => {
    const e = new RetryError({ message: 'Failed after 2 attempts.', reason: 'maxRetriesExceeded', errors: [new Error('schema mismatch'), new Error('validation failed')] })
    expect(classifyLlmError(e, CTX_NS)).toEqual(OTHER)
  })

  it('RetryError with empty errors array → other', () => {
    const e = new RetryError({ message: 'Failed after 0 attempts.', reason: 'maxRetriesExceeded', errors: [] })
    expect(classifyLlmError(e, CTX_NS)).toEqual(OTHER)
  })

  it('name-spoofed AI_RetryError without an errors array → other (defensive)', () => {
    expect(classifyLlmError({ name: 'AI_RetryError', message: 'spoof' }, CTX_NS)).toEqual(OTHER)
  })

  // §1.2 walk item 2 — AggregateError any-member rule.
  it('AggregateError with a connectivity member → connectivity pair', () => {
    const e = new AggregateError([new Error('first failed'), und('ECONNREFUSED')], 'all attempts failed')
    expect(classifyLlmError(e, CTX_S)).toEqual(CONNECTIVITY)
  })

  it('AggregateError with no connectivity member → other', () => {
    const e = new AggregateError([new Error('nope')], 'all attempts failed')
    expect(classifyLlmError(e, CTX_S)).toEqual(OTHER)
  })

  // §1.2 walk item 4 — Mythrun-mapped classes carry status via cause.
  it('LlmRateLimitedError wrapping an APICallError 429 → rate-limit via cause', () => {
    const e = new LlmRateLimitedError('upstream rate limited', { cause: apiCallError({ statusCode: 429 }) })
    expect(classifyLlmError(e, CTX_NS)).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'rate-limit' })
  })

  // §1.2 walk item 5 — generic cause recursion (undici fetch wrapper shape).
  it("TypeError 'fetch failed' wrapping ECONNREFUSED → connectivity", () => {
    const e = new TypeError('fetch failed', { cause: und('ECONNREFUSED') })
    expect(classifyLlmError(e, CTX_S)).toEqual(CONNECTIVITY)
  })

  // §1.2 walk item 7 — abort predicate covers DOMException names.
  it('DOMException AbortError: pre-headers streaming → connectivity; post-headers → abort no-retry', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError')
    expect(classifyLlmError(abort, CTX_S)).toEqual(CONNECTIVITY)
    expect(classifyLlmError(abort, { mode: 'streaming', headersArrived: true })).toEqual({ retryWorthy: false, outageSignal: false, failureClass: 'abort' })
  })

  it('DOMException TimeoutError (AbortSignal.timeout): pre-headers non-streaming → abort, retry-worthy, no signal', () => {
    const abort = new DOMException('The operation timed out', 'TimeoutError')
    expect(classifyLlmError(abort, CTX_NS)).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'abort' })
  })

  it('abort with unknown context (nulls) → abort, no retry, no signal (conservative)', () => {
    const abort = new LlmTimeoutError('llm call aborted')
    expect(classifyLlmError(abort, { mode: null, headersArrived: null })).toEqual({ retryWorthy: false, outageSignal: false, failureClass: 'abort' })
  })

  it('pre-headers abort with unknown mode → retry-worthy, never signal', () => {
    const abort = new LlmTimeoutError('llm call aborted')
    expect(classifyLlmError(abort, { mode: null, headersArrived: false })).toEqual({ retryWorthy: true, outageSignal: false, failureClass: 'abort' })
  })

  // In-band raw payload shapes (Task 4's stream observer passes raw parts).
  it('in-band raw payload: api_error object maps 500-class → connectivity pair', () => {
    expect(classifyLlmError({ type: 'api_error', message: 'Internal server error' }, CTX_S)).toEqual(CONNECTIVITY)
  })

  // Non-object and null inputs.
  it('string input → other', () => {
    expect(classifyLlmError('boom', CTX_S)).toEqual(OTHER)
  })

  it('null input → other', () => {
    expect(classifyLlmError(null, CTX_S)).toEqual(OTHER)
  })
})
