// Unit test for typedErrorHandler — the Fastify error handler that
// maps Mythrun-typed LLM upstream errors to the contract's
// `llm_upstream_unavailable` 503. Registered globally in buildApp;
// extracted to its own module so it can be unit-tested without
// spinning up the full app + Redis + Postgres surface.

import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { typedErrorHandler } from '../error-handler.js'
import {
  LlmAuthError,
  LlmContentFilteredError,
  LlmContextTooLongError,
  LlmInvalidRequestError,
  LlmOverloadedError,
  LlmRateLimitedError,
  LlmStructuredOutputError,
  LlmTimeoutError,
} from '../llm/errors.js'

async function buildAppThatThrows(toThrow: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setErrorHandler(typedErrorHandler)
  app.get('/throw', () => {
    throw toThrow
  })
  await app.ready()
  return app
}

describe('typedErrorHandler', () => {
  // The seven typed LLM errors all map to the same 503 response. Loop
  // them rather than copy-paste seven near-identical assertions.
  const llmErrors: { name: string; instance: Error }[] = [
    { name: 'LlmAuthError', instance: new LlmAuthError('bad key') },
    { name: 'LlmRateLimitedError', instance: new LlmRateLimitedError('429') },
    { name: 'LlmOverloadedError', instance: new LlmOverloadedError('529') },
    { name: 'LlmTimeoutError', instance: new LlmTimeoutError('timeout') },
    {
      name: 'LlmStructuredOutputError',
      instance: new LlmStructuredOutputError('AI_NoObjectGenerated'),
    },
    { name: 'LlmInvalidRequestError', instance: new LlmInvalidRequestError('400') },
    { name: 'LlmContextTooLongError', instance: new LlmContextTooLongError('200k') },
  ]

  for (const { name, instance } of llmErrors) {
    it(`maps ${name} to 503 llm_upstream_unavailable with Retry-After: 60`, async () => {
      const app = await buildAppThatThrows(instance)
      try {
        const res = await app.inject({ method: 'GET', url: '/throw' })
        expect(res.statusCode).toBe(503)
        expect(res.headers['retry-after']).toBe('60')
        expect(res.json()).toEqual({
          code: 'llm_upstream_unavailable',
          retryAfterSeconds: 60,
        })
      } finally {
        await app.close()
      }
    })
  }

  it('maps LlmContentFilteredError to 422 content_filtered (no Retry-After)', async () => {
    // Content-policy filter is terminal: retrying with the same prompt
    // hits the same filter. 422 + no Retry-After signals "permanently
    // rejected on this payload, change the source" rather than the
    // 503 + Retry-After shape that invites auto-retry. (MYT-52 §7.2.)
    const app = await buildAppThatThrows(new LlmContentFilteredError('filtered'))
    try {
      const res = await app.inject({ method: 'GET', url: '/throw' })
      expect(res.statusCode).toBe(422)
      expect(res.headers['retry-after']).toBeUndefined()
      expect(res.json()).toEqual({ code: 'content_filtered' })
    } finally {
      await app.close()
    }
  })

  it('falls through to Fastify default 500 for non-LLM errors', async () => {
    const app = await buildAppThatThrows(new Error('something else'))
    try {
      const res = await app.inject({ method: 'GET', url: '/throw' })
      expect(res.statusCode).toBe(500)
      // The default 500 JSON payload has the raw message — no
      // `code: 'llm_upstream_unavailable'`.
      expect(res.headers['retry-after']).toBeUndefined()
      const body = res.json<{ code?: string; message?: string }>()
      expect(body.code).not.toBe('llm_upstream_unavailable')
    } finally {
      await app.close()
    }
  })

  it('maps a Postgres 22P02 (invalid uuid/text) to a clean 404 — no raw SQLSTATE leak (MYT-102 QA)', async () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), {
      code: '22P02',
    })
    const app = await buildAppThatThrows(pgErr)
    try {
      const res = await app.inject({ method: 'GET', url: '/throw' })
      expect(res.statusCode).toBe(404)
      const body = res.json<{ code?: string; message?: string }>()
      expect(body.code).toBe('not_found')
      // The raw Postgres message + SQLSTATE never reach the client.
      expect(JSON.stringify(body)).not.toContain('22P02')
      expect(JSON.stringify(body)).not.toContain('invalid input syntax')
    } finally {
      await app.close()
    }
  })

  it('preserves Fastify validation errors (statusCode!=500)', async () => {
    // A Fastify FastifyError with statusCode=400 (e.g., schema validation
    // failure) shouldn't be remapped to 500 by the fallback branch — the
    // handler defers to Fastify's default serialization for non-LLM
    // errors, which honors the err.statusCode.
    const app = Fastify({ logger: false })
    app.setErrorHandler(typedErrorHandler)
    app.get('/throw', () => {
      const err = new Error('bad request') as Error & { statusCode: number }
      err.statusCode = 400
      throw err
    })
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/throw' })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
