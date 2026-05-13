// Fastify error handler that maps Mythrun-typed LLM upstream errors to
// the contract's `llm_upstream_unavailable` 503 response. The Vercel SDK
// middleware (src/llm/middleware.ts) chains raw AI_APICallError into
// these typed classes; this handler is the second half — translating
// them into HTTP responses that match the PipelineRouteError union, so
// the FE never sees an untyped 500 from an upstream LLM failure.
//
// Application-level typed errors (InsufficientCreditsError, etc.) stay
// inline in their route handlers — those carry route-specific payload
// (creditType, etc.) that a global handler can't compose.

import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import {
  LlmAuthError,
  LlmContextTooLongError,
  LlmInvalidRequestError,
  LlmOverloadedError,
  LlmRateLimitedError,
  LlmStructuredOutputError,
  LlmTimeoutError,
} from './llm/errors.js'

const RETRY_AFTER_SECONDS = 60

export function typedErrorHandler(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Sanitized log of the full error chain so an operator can
  // diagnose without exposing internals to the user.
  request.log.error({ err }, 'unhandled route error')

  if (
    err instanceof LlmAuthError ||
    err instanceof LlmRateLimitedError ||
    err instanceof LlmOverloadedError ||
    err instanceof LlmTimeoutError ||
    err instanceof LlmStructuredOutputError ||
    err instanceof LlmInvalidRequestError ||
    err instanceof LlmContextTooLongError
  ) {
    reply.header('Retry-After', String(RETRY_AFTER_SECONDS))
    void reply.code(503).send({
      code: 'llm_upstream_unavailable',
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    })
    return
  }

  // Anything else falls through to Fastify's default 500 (untyped).
  // Future application-level typed errors can add arms here.
  void reply.send(err)
}
