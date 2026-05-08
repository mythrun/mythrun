import { APICallError } from '@ai-sdk/provider'

export class LlmRateLimitedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmRateLimitedError'
  }
}
export class LlmOverloadedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmOverloadedError'
  }
}
export class LlmAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmAuthError'
  }
}
export class LlmInvalidRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmInvalidRequestError'
  }
}
export class LlmContextTooLongError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmContextTooLongError'
  }
}
export class LlmTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmTimeoutError'
  }
}
export class LlmStructuredOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmStructuredOutputError'
  }
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
