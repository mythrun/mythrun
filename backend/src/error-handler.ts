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
  LlmContentFilteredError,
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

  // Content-policy filter (MYT-52 §7.2): terminal — retrying the same prompt
  // will hit the same filter. 422 Unprocessable Entity is the right shape:
  // the request was well-formed but the upstream content filter rejected it,
  // and no Retry-After is sent because the user must change the source text.
  // (503 + Retry-After is wrong here — it would invite the FE to auto-retry
  // a request that is permanently rejected. 409 is what the resume route
  // emits when this is the world's stuck state; the global handler uses 422
  // for the "synchronous LLM call from a route hit the filter" path.)
  if (err instanceof LlmContentFilteredError) {
    void reply.code(422).send({ code: 'content_filtered' })
    return
  }

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
