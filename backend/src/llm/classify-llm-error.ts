// backend/src/llm/classify-llm-error.ts
//
// §1.2 error taxonomy for the LLM outage-resilience design
// (docs/superpowers/specs/2026-07-30-llm-outage-resilience-design.md).
// Classifies every failed LLM call along two independent axes — retry-worthy
// (the wrapper attempt loop) and outage signal (the Redis outage window) —
// plus a failure class consumed by the §3.1 park predicate.
//
// Pure module, zero imports. All matching is by STRING property (name /
// code / statusCode / type), never instanceof: the lockfile carries a
// transitive undici@5 beside the npm undici@7, so two realms of the same
// error classes exist at runtime. Mythrun error classes (errors.ts) are
// likewise matched by their stable `code` strings ('llm_timeout',
// 'llm_overloaded') rather than imported.
//
// Mechanical, ZFC-exempt: structural error-shape dispatch, no semantics.

export type LlmFailureClass = 'connectivity' | 'rate-limit' | 'abort' | 'other'

export interface LlmFailureContext {
  /** 'streaming' | 'non-streaming' from the transport observable; null when unknown. */
  readonly mode: 'streaming' | 'non-streaming' | null
  /** Whether response headers had arrived when the failure surfaced; null when unknown. */
  readonly headersArrived: boolean | null
}

export interface LlmFailureVerdict {
  readonly retryWorthy: boolean
  readonly outageSignal: boolean
  readonly failureClass: LlmFailureClass
}

const CONNECTIVITY: LlmFailureVerdict = {
  retryWorthy: true,
  outageSignal: true,
  failureClass: 'connectivity',
}
const RATE_LIMIT: LlmFailureVerdict = {
  retryWorthy: true,
  outageSignal: false,
  failureClass: 'rate-limit',
}
const ABORT_RETRY: LlmFailureVerdict = {
  retryWorthy: true,
  outageSignal: false,
  failureClass: 'abort',
}
const ABORT_NO_RETRY: LlmFailureVerdict = {
  retryWorthy: false,
  outageSignal: false,
  failureClass: 'abort',
}
const OTHER: LlmFailureVerdict = {
  retryWorthy: false,
  outageSignal: false,
  failureClass: 'other',
}

// §1.2 item 5: the walk follows at most 5 cause links.
const MAX_DEPTH = 5

// §1.2 item 6: errnos (connect/DNS/socket layer).
const CONNECTIVITY_ERRNOS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

// §1.2 item 6: bare OpenSSL verify codes (surface without an ERR_TLS_ prefix).
const TLS_VERIFY_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

// §1.2 item 3: the named retry-worthy statuses; every other ≥400 status is
// the 4xx-application row (no retry, no signal).
const CONNECTIVITY_STATUSES = new Set([500, 502, 503, 504, 529])

const readString = (err: object, key: string): string | undefined => {
  const value = (err as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

const readNumber = (err: object, key: string): number | undefined => {
  const value = (err as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

const readMembers = (err: object): readonly unknown[] => {
  const errors = (err as { errors?: unknown }).errors
  return Array.isArray(errors) ? (errors as unknown[]) : []
}

// §1.2 item 6: connectivity base cases by code string. UND_ERR_* is
// prefix-matched per the task contract (covers HEADERS_TIMEOUT,
// CONNECT_TIMEOUT, BODY_TIMEOUT, SOCKET and the rest of the undici family);
// ERR_TLS_* prefix plus EPROTO cover the TLS layer.
const isConnectivityCode = (code: string): boolean =>
  code.startsWith('UND_ERR_') ||
  CONNECTIVITY_ERRNOS.has(code) ||
  code === 'EPROTO' ||
  code.startsWith('ERR_TLS_') ||
  TLS_VERIFY_CODES.has(code)

// §1.2 item 7: abort recognition predicate — DOMException named
// AbortError/TimeoutError (matched by name string; DOMExceptions also cross
// realms) OR the mapped LlmTimeoutError (code 'llm_timeout').
const isAbortShape = (name: string | undefined, code: string | undefined): boolean =>
  name === 'AbortError' || name === 'TimeoutError' || code === 'llm_timeout'

// §1.2 item 7: dispatcher-aware abort rule. Pre-headers + streaming means a
// hang (headers arrive in seconds on a healthy stream) → connectivity. On
// the non-streaming dispatcher no-headers-at-abort is the healthy state →
// retry-worthy, never outage signal. Post-headers (or unknown — external
// aborts arrive without transport context, and the table's external-abort
// row is no/no) → no retry, no signal.
const classifyAbort = (ctx: LlmFailureContext): LlmFailureVerdict => {
  if (ctx.headersArrived === false) {
    if (ctx.mode === 'streaming') return CONNECTIVITY
    return ABORT_RETRY
  }
  return ABORT_NO_RETRY
}

// §1.2 item 3: APICallError statusCode table (applied only when ≥400).
const classifyStatus = (status: number): LlmFailureVerdict => {
  if (status === 429) return RATE_LIMIT
  if (CONNECTIVITY_STATUSES.has(status)) return CONNECTIVITY
  return OTHER
}

// §1.2 item 1: AI_RetryError — retry axis (and class) from the LAST member;
// outage axis from ANY member (the incident's own shape is
// [headers-timeout, abort]; last-member-only discards the genuine signal).
const classifyRetryError = (
  members: readonly unknown[],
  ctx: LlmFailureContext,
  depth: number
): LlmFailureVerdict => {
  const last = members.length > 0 ? walk(members[members.length - 1], ctx, depth + 1) : OTHER
  const anyOutage = members.some((member) => walk(member, ctx, depth + 1).outageSignal)
  return {
    retryWorthy: last.retryWorthy,
    outageSignal: anyOutage,
    failureClass: last.failureClass,
  }
}

const walk = (err: unknown, ctx: LlmFailureContext, depth: number): LlmFailureVerdict => {
  // §1.2 item 5: bounded depth — a link past the 5th is not followed.
  if (depth > MAX_DEPTH) return OTHER
  if (err === null || typeof err !== 'object') return OTHER

  const name = readString(err, 'name')
  const code = readString(err, 'code')

  // §1.2 item 1: AI_RetryError.
  if (name === 'AI_RetryError') return classifyRetryError(readMembers(err), ctx, depth)

  // §1.2 item 2: AggregateError — connectivity if ANY member is; otherwise
  // fall through to the base cases on the aggregate itself.
  if (name === 'AggregateError') {
    const members = readMembers(err)
    if (members.some((member) => walk(member, ctx, depth + 1).failureClass === 'connectivity')) {
      return CONNECTIVITY
    }
  }

  // §1.2 item 3: APICallError — statusCode only when ≥400 (mid-body deaths
  // arrive as statusCode 200 with the real undici error in cause; those
  // fall through to the generic cause recursion below).
  if (name === 'AI_APICallError') {
    const status = readNumber(err, 'statusCode')
    if (status !== undefined && status >= 400) return classifyStatus(status)
  }

  // §1.2 item 4: Mythrun-mapped LlmOverloadedError (529) → connectivity;
  // the other mapped classes carry their status via cause.
  if (code === 'llm_overloaded') return CONNECTIVITY

  // §1.2 item 7: dispatcher-aware abort rule.
  if (isAbortShape(name, code)) return classifyAbort(ctx)

  // §1.2 item 6: base cases by code string.
  if (code !== undefined && isConnectivityCode(code)) return CONNECTIVITY

  // §1.2 in-band raw payload shape: mid-stream Anthropic error events
  // (`overloaded_error` → 529-class, `api_error` → 500-class) arrive as raw
  // JSON parts on OPEN streams; Task 4's observer passes them here directly.
  const type = readString(err, 'type')
  if (type === 'overloaded_error' || type === 'api_error') return CONNECTIVITY

  // §1.2 item 5: generic rule — anything with a cause recurses.
  const cause = (err as { cause?: unknown }).cause
  if (cause !== undefined) return walk(cause, ctx, depth + 1)

  return OTHER
}

/**
 * Classify a failed LLM call per design §1.2. `err` is whatever surfaced at
 * the ai.ts boundary — an AI SDK error, a Mythrun-mapped error, a bare
 * transport error, or a raw in-band stream payload. `ctx` is the
 * mode/headers observable from the §1.1 transport dispatchers; pass nulls
 * when unknown (unknown-context aborts classify conservatively as
 * no-retry/no-signal).
 */
export function classifyLlmError(err: unknown, ctx: LlmFailureContext): LlmFailureVerdict {
  return walk(err, ctx, 0)
}
