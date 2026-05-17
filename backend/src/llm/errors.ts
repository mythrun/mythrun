import { APICallError } from '@ai-sdk/provider'

// myth-uppw: each typed error carries a stable `code` so `sanitizeError`
// in world-gen-processor surfaces a useful identifier in pipeline_runs.error
// and the stage-failed SSE event, rather than falling back to 'stage_failed'.
// The TERMINAL constant on each terminal class is used by isTerminalError
// to decide whether BullMQ should retry.

export class LlmRateLimitedError extends Error {
  readonly code = 'llm_rate_limited'
  readonly terminal = false
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmRateLimitedError'
  }
}
export class LlmOverloadedError extends Error {
  readonly code = 'llm_overloaded'
  readonly terminal = false
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmOverloadedError'
  }
}
export class LlmAuthError extends Error {
  readonly code = 'llm_auth_failed'
  readonly terminal = true
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmAuthError'
  }
}
export class LlmInvalidRequestError extends Error {
  readonly code = 'llm_invalid_request'
  readonly terminal = true
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmInvalidRequestError'
  }
}
export class LlmContextTooLongError extends Error {
  readonly code = 'llm_context_too_long'
  readonly terminal = true
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmContextTooLongError'
  }
}
export class LlmTimeoutError extends Error {
  readonly code = 'llm_timeout'
  readonly terminal = false
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmTimeoutError'
  }
}
export class LlmStructuredOutputError extends Error {
  readonly code = 'llm_structured_output_failed'
  readonly terminal = true
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmStructuredOutputError'
  }
}
/**
 * Anthropic content-policy filter tripped on the prompt (or its continuation).
 *
 * Surfaces from Vercel AI SDK as `finishReason.unified === 'content-filter'`
 * on both `generateText` and `streamObject` paths. Per MYT-52 design §7.2:
 * this is a TERMINAL stop — retrying produces the same filter hit on the
 * same prompt, so the worker must NOT retry. The user must adjust the
 * source concept text via a new campaign. The resume route reports
 * `content_filtered` (409) until the user acts.
 */
export class LlmContentFilteredError extends Error {
  readonly code = 'llm_content_filtered'
  readonly terminal = true
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmContentFilteredError'
  }
}

/**
 * myth-uppw: terminal-error predicate. Returns true when the error is
 * one whose retry produces the same outcome — the worker MUST NOT
 * BullMQ-retry these. Returns false for transient errors (rate limit,
 * overload, network timeout) where backoff has a chance to help, and
 * for non-Error values (defensive — pass through to the existing
 * 'stage_failed' generic path).
 *
 * Duck-typed on `.terminal` rather than instanceof so:
 *   (a) error classes added in the future can self-declare terminal-ness
 *       at the class definition site
 *   (b) errors that cross module boundaries (e.g., through structured
 *       clone in test fixtures) don't trip instanceof checks
 *
 * NOTE: PaintJobLoopExhaustedError lives in paint-job-validator.ts (it
 * needs the PaintJobJudgement type) and self-declares `terminal: true`
 * via the same convention. Don't import that class here — keep this
 * module free of LLM-stage dependencies.
 */
export function isTerminalError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const terminal = (err as { terminal?: unknown }).terminal
  return terminal === true
}

const CONTEXT_WINDOW_RE = /context window|too long|maximum context/i

/**
 * Map a Vercel AI SDK error (or a generic Error) to a Mythrun-typed error.
 *
 * Pattern-matches by class (APICallError, DOMException) and status code.
 * Unknown errors pass through unchanged so Fastify's default error handler
 * still catches them. Every mapped error preserves the original as `cause`.
 */
export function mapToMythrunError(err: unknown): Error {
  // AbortSignal fired during the call.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new LlmTimeoutError('llm call aborted', { cause: err })
  }
  // generateObject couldn't produce a schema-valid object after retries.
  // The AI_NoObjectGeneratedError class lives in the `ai` package and is
  // matched by name to avoid a brittle deep import.
  if (err instanceof Error && err.name === 'AI_NoObjectGeneratedError') {
    return new LlmStructuredOutputError('llm returned unparseable structured output', {
      cause: err,
    })
  }
  if (err instanceof APICallError) {
    const status = err.statusCode
    if (status === 429) {
      return new LlmRateLimitedError(`upstream rate limited: ${err.message}`, { cause: err })
    }
    if (status === 529) {
      return new LlmOverloadedError(`upstream overloaded: ${err.message}`, { cause: err })
    }
    if (status === 401 || status === 403) {
      return new LlmAuthError(`upstream auth failed: ${err.message}`, { cause: err })
    }
    if (status === 400 && CONTEXT_WINDOW_RE.test(err.message)) {
      return new LlmContextTooLongError(`context too long: ${err.message}`, { cause: err })
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return new LlmInvalidRequestError(`upstream rejected request: ${err.message}`, { cause: err })
    }
  }
  return err instanceof Error ? err : new Error(String(err))
}
