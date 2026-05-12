import { describe, it, expect, vi, beforeEach, assert } from 'vitest'
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { logAndNormalizeMiddleware } from '../middleware.js'
import { logger } from '../logger.js'
import { LlmRateLimitedError, LlmStructuredOutputError, LlmAuthError } from '../errors.js'

const stubModel = {} as LanguageModelV3
const stubGenerate = (): Promise<never> => Promise.reject(new Error('generate not used'))

function makeStream(
  parts: LanguageModelV3StreamPart[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

function makeStreamResult(
  parts: LanguageModelV3StreamPart[],
): LanguageModelV3StreamResult {
  return {
    stream: makeStream(parts),
    request: undefined,
    response: undefined,
  } as unknown as LanguageModelV3StreamResult
}

function emptyParams(): LanguageModelV3CallOptions {
  return {} as LanguageModelV3CallOptions
}

function paramsWithContext(mythrun: Record<string, unknown>): LanguageModelV3CallOptions {
  return { providerOptions: { mythrun } } as unknown as LanguageModelV3CallOptions
}

type FinishUnified = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'

const finishPart = (
  inputTokens = 47,
  outputTokens = 8,
  unified: FinishUnified = 'stop',
): LanguageModelV3StreamPart => ({
  type: 'finish',
  usage: {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  },
  finishReason: { unified, raw: 'end_turn' },
})

const textDeltaPart = (text: string): LanguageModelV3StreamPart => ({
  type: 'text-delta',
  id: 'block-1',
  delta: text,
})

async function drainStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = []
  for await (const part of stream) out.push(part)
  return out
}

describe('logAndNormalizeMiddleware wrapStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('case 1 — Success: finish with usage logs llm.call once with tokens + mode=stream', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined, 'wrapStream must be defined')

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () =>
        Promise.resolve(makeStreamResult([textDeltaPart('h'), textDeltaPart('i'), finishPart()])),
      params: emptyParams(),
      model: stubModel,
    })

    const parts = await drainStream(out.stream)
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(errorSpy).not.toHaveBeenCalled()
    const [obj, msg] = infoSpy.mock.calls[0] ?? []
    expect(obj).toMatchObject({
      event: 'llm.call',
      model: 'claude-sonnet-test',
      mode: 'stream',
      inputTokens: 47,
      outputTokens: 8,
      totalTokens: 55,
      finishReason: 'stop',
    })
    expect(msg).toContain('stream completed')
  })

  it('case 2 — Success with finishReason=error: logs llm.call, not llm.error', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () =>
        Promise.resolve(makeStreamResult([textDeltaPart('hi'), finishPart(20, 4, 'error' as const)])),
      params: emptyParams(),
      model: stubModel,
    })

    await drainStream(out.stream)
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.call',
      finishReason: 'error',
      inputTokens: 20,
      outputTokens: 4,
    })
  })

  it('case 3 — In-stream error part: logs llm.error once, consumer throws Mythrun-typed error', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const rateLimitErr = new APICallError({
      message: 'rate limited',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: 'rate limited',
    })
    const errorPart: LanguageModelV3StreamPart = { type: 'error', error: rateLimitErr }

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([textDeltaPart('h'), errorPart])),
      params: emptyParams(),
      model: stubModel,
    })

    await expect(drainStream(out.stream)).rejects.toBeInstanceOf(LlmRateLimitedError)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      mode: 'stream',
    })
  })

  it('case 4 — Truncation: stream closes without finish, logs llm.error + throws LlmStructuredOutputError', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([textDeltaPart('h'), textDeltaPart('i')])),
      params: emptyParams(),
      model: stubModel,
    })

    await expect(drainStream(out.stream)).rejects.toBeInstanceOf(LlmStructuredOutputError)
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      reason: 'truncated',
    })
  })

  it('case 5 — Cancellation: reader.cancel() logs llm.error with reason=cancelled', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const slowStream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue(textDeltaPart('h'))
        await new Promise(() => undefined)
      },
    })

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () =>
        Promise.resolve({
          stream: slowStream,
          request: undefined,
          response: undefined,
        } as unknown as LanguageModelV3StreamResult),
      params: emptyParams(),
      model: stubModel,
    })

    const reader = out.stream.getReader()
    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    await reader.cancel('aborted by test')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.error',
      reason: 'cancelled',
    })
  })

  it('case 6 — Open-time error: doStream rejects, wrapStream throws Mythrun-typed error', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-sonnet-test')
    assert(mw.wrapStream !== undefined)

    const authErr = new APICallError({
      message: 'unauthorized',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 401,
      responseHeaders: {},
      responseBody: 'unauthorized',
    })

    await expect(
      mw.wrapStream({
        doGenerate: stubGenerate,
        doStream: () => Promise.reject(authErr),
        params: emptyParams(),
        model: stubModel,
      }),
    ).rejects.toBeInstanceOf(LlmAuthError)

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('case 7 — Context threading: worldId + stage threaded into log line', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-opus-test')
    assert(mw.wrapStream !== undefined)

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([finishPart()])),
      params: paramsWithContext({ worldId: 'w1', stage: 'world_and_factions' }),
      model: stubModel,
    })
    await drainStream(out.stream)

    expect(infoSpy).toHaveBeenCalledOnce()
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      worldId: 'w1',
      stage: 'world_and_factions',
    })
    const obj = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(obj.sessionId).toBeUndefined()
    expect(obj.userId).toBeUndefined()
    expect(obj.campaignId).toBeUndefined()
  })

  it('case 8 — No-usage finish: undefined tokens, doesnt crash', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-test')
    assert(mw.wrapStream !== undefined)

    const noUsageFinish: LanguageModelV3StreamPart = {
      type: 'finish',
      usage: {
        inputTokens: {
          total: undefined,
          noCache: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: undefined,
          text: 0,
          reasoning: 0,
        },
      },
      finishReason: { unified: 'stop', raw: 'end_turn' },
    }

    const out = await mw.wrapStream({
      doGenerate: stubGenerate,
      doStream: () => Promise.resolve(makeStreamResult([noUsageFinish])),
      params: emptyParams(),
      model: stubModel,
    })
    await drainStream(out.stream)

    expect(infoSpy).toHaveBeenCalledOnce()
    const obj = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(obj.inputTokens).toBeUndefined()
    expect(obj.outputTokens).toBeUndefined()
    expect(obj.totalTokens).toBeUndefined()
  })

  it('case 9 — Backwards-compat: wrapGenerate still works with expanded MythrunContext', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-test')
    assert(mw.wrapGenerate !== undefined)

    const out = await mw.wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'hi' }],
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        }),
      doStream: () => Promise.reject(new Error('stream not used')),
      params: paramsWithContext({ worldId: 'w1', userId: 'u1', stage: 'concept_intake' }),
      model: stubModel,
    })

    expect(out.usage.inputTokens.total).toBe(5)
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(infoSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm.call',
      worldId: 'w1',
      userId: 'u1',
      stage: 'concept_intake',
    })
  })
})
