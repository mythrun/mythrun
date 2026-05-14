import { describe, it, expect, vi, assert } from 'vitest'
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import {
  LlmRateLimitedError,
  LlmOverloadedError,
  LlmAuthError,
  LlmInvalidRequestError,
  LlmContextTooLongError,
  LlmTimeoutError,
  LlmStructuredOutputError,
  LlmContentFilteredError,
  mapToMythrunError,
} from '../errors.js'
import { logAndNormalizeMiddleware } from '../middleware.js'
import { logger } from '../logger.js'

describe('mapToMythrunError', () => {
  it('maps 429 APICallError to LlmRateLimitedError', () => {
    const upstream = new APICallError({
      message: 'rate limited',
      url: 'https://api.anthropic.com',
      statusCode: 429,
      requestBodyValues: {},
      isRetryable: true,
    })
    const mapped = mapToMythrunError(upstream)
    expect(mapped).toBeInstanceOf(LlmRateLimitedError)
    expect(mapped.cause).toBe(upstream)
  })

  it('maps 529 APICallError to LlmOverloadedError', () => {
    const upstream = new APICallError({
      message: 'overloaded',
      url: 'https://api.anthropic.com',
      statusCode: 529,
      requestBodyValues: {},
      isRetryable: true,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmOverloadedError)
  })

  it('maps 401 APICallError to LlmAuthError', () => {
    const upstream = new APICallError({
      message: 'invalid key',
      url: 'https://api.anthropic.com',
      statusCode: 401,
      requestBodyValues: {},
      isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmAuthError)
  })

  it('maps 400 with context-window message to LlmContextTooLongError', () => {
    const upstream = new APICallError({
      message: 'prompt is too long: context window exceeded',
      url: 'https://api.anthropic.com',
      statusCode: 400,
      requestBodyValues: {},
      isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmContextTooLongError)
  })

  it('maps generic 400 APICallError to LlmInvalidRequestError', () => {
    const upstream = new APICallError({
      message: 'invalid params',
      url: 'https://api.anthropic.com',
      statusCode: 400,
      requestBodyValues: {},
      isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmInvalidRequestError)
  })

  it('maps DOMException AbortError to LlmTimeoutError', () => {
    const upstream = new DOMException('aborted', 'AbortError')
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmTimeoutError)
  })

  it('passes unknown errors through unchanged', () => {
    const upstream = new Error('something else')
    expect(mapToMythrunError(upstream)).toBe(upstream)
  })

  it('maps AI_NoObjectGeneratedError (matched by name) to LlmStructuredOutputError', () => {
    // The class lives in the `ai` package and is matched by `.name` to
    // avoid a brittle deep import. Construct a stand-in by setting .name.
    const upstream = new Error('schema failed after retries')
    upstream.name = 'AI_NoObjectGeneratedError'
    const mapped = mapToMythrunError(upstream)
    expect(mapped).toBeInstanceOf(LlmStructuredOutputError)
    expect(mapped.cause).toBe(upstream)
  })

  it('maps generic 5xx APICallError (not 401/403/429/529) through to fallthrough Error', () => {
    // 500 doesn't hit any of the typed branches — falls through to the
    // final `err instanceof Error ? err : new Error(...)` line.
    const upstream = new APICallError({
      message: 'server exploded',
      url: 'https://api.anthropic.com',
      statusCode: 500,
      requestBodyValues: {},
      isRetryable: true,
    })
    const mapped = mapToMythrunError(upstream)
    expect(mapped).toBe(upstream)
  })

  it('wraps non-Error throwables into Error', () => {
    // The final fallback: `err instanceof Error ? err : new Error(String(err))`
    // — exercises the `: new Error(String(err))` branch.
    const mapped = mapToMythrunError('string-thrown')
    expect(mapped).toBeInstanceOf(Error)
    expect(mapped.message).toBe('string-thrown')
  })

  it('preserves cause chain on every mapped error', () => {
    const upstream = new APICallError({
      message: 'x',
      url: 'https://api.anthropic.com',
      statusCode: 401,
      requestBodyValues: {},
      isRetryable: false,
    })
    const mapped = mapToMythrunError(upstream)
    expect(mapped.cause).toBe(upstream)
  })
})

// --- Content-filter mapping (Task 15 / design §7.2) -------------------------
//
// Anthropic returns `stop_reason: 'content_filter'` when a prompt or its
// continuation trips Anthropic's content-policy filter. The Vercel SDK
// surfaces that as `finishReason.unified === 'content-filter'`. Per design,
// this is a TERMINAL stop (retrying hits the same filter on the same prompt)
// — so the middleware must throw an `LlmContentFilteredError` rather than
// log it as a graceful completion the way it does for `finishReason: 'error'`.

const stubModel = {} as LanguageModelV3
const stubGenerate = (): Promise<never> => Promise.reject(new Error('generate not used'))

function makeStream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

function makeStreamResult(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: makeStream(parts),
    request: undefined,
    response: undefined,
  } as unknown as LanguageModelV3StreamResult
}

function emptyParams(): LanguageModelV3CallOptions {
  return {} as LanguageModelV3CallOptions
}

const contentFilterFinish: LanguageModelV3StreamPart = {
  type: 'finish',
  usage: {
    inputTokens: { total: 47, noCache: 47, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 8, text: 8, reasoning: 0 },
  },
  finishReason: { unified: 'content-filter', raw: 'content_filter' },
}

async function drainStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = []
  for await (const part of stream) out.push(part)
  return out
}

describe('content-filter mapping (LlmContentFilteredError)', () => {
  it('stream finishReason: content-filter → consumer throws LlmContentFilteredError', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined, 'wrapStream must be defined')

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([contentFilterFinish])),
      params: emptyParams(),
      model: stubModel,
    })

    await expect(drainStream(out.stream)).rejects.toBeInstanceOf(LlmContentFilteredError)
  })

  it('stream finishReason: content-filter logs llm.error (terminal), not llm.call', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([contentFilterFinish])),
      params: emptyParams(),
      model: stubModel,
    })

    await expect(drainStream(out.stream)).rejects.toBeInstanceOf(LlmContentFilteredError)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      mode: 'stream',
      reason: 'content-filter',
    })
  })

  it('generate finishReason: content-filter → throws LlmContentFilteredError', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapGenerate !== undefined, 'wrapGenerate must be defined')

    const fakeGenerateResult = {
      content: [],
      usage: {
        inputTokens: { total: 47, noCache: 47, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 8, text: 8, reasoning: 0 },
      },
      finishReason: { unified: 'content-filter', raw: 'content_filter' },
      warnings: [],
    }

    await expect(
      mw.wrapGenerate({
        doGenerate: () =>
          Promise.resolve(
            fakeGenerateResult as unknown as Awaited<ReturnType<LanguageModelV3['doGenerate']>>,
          ),
        doStream: () => Promise.reject(new Error('stream not used')),
        params: emptyParams(),
        model: stubModel,
      }),
    ).rejects.toBeInstanceOf(LlmContentFilteredError)
  })
})
