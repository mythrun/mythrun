import { describe, it, expect, vi, beforeEach, assert } from 'vitest'
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { logAndNormalizeMiddleware } from '../middleware.js'
import { logger } from '../logger.js'
import { LlmRateLimitedError } from '../errors.js'

const emptyParams = {} as LanguageModelV3CallOptions
const stubModel = {} as LanguageModelV3
const stubStream = (): Promise<LanguageModelV3StreamResult> => {
  throw new Error('stream not used')
}

const successResult: LanguageModelV3GenerateResult = {
  content: [{ type: 'text', text: 'hi' }],
  finishReason: { unified: 'stop' as const, raw: 'end_turn' },
  usage: {
    inputTokens: { total: 47, noCache: 47, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 8, text: 8, reasoning: 0 },
  },
  warnings: [],
}

describe('logAndNormalizeMiddleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs llm.call with model, tokens, latency on success', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-4-5-test')
    assert(mw.wrapGenerate !== undefined, 'wrapGenerate must be defined')

    const out = await mw.wrapGenerate({
      doGenerate: () => Promise.resolve(successResult),
      doStream: stubStream,
      params: emptyParams,
      model: stubModel,
    })

    expect(out).toBe(successResult)
    // myth-4omh: middleware now emits llm.call.started before doGenerate
    // (visibility into hung calls). Expect 2 info logs: started + call.
    expect(infoSpy).toHaveBeenCalledTimes(2)
    const startedCall = infoSpy.mock.calls[0]
    assert(startedCall !== undefined, 'expected started log')
    expect(startedCall[0]).toMatchObject({ event: 'llm.call.started', model: 'claude-haiku-4-5-test', mode: 'generate' })
    const completionCall = infoSpy.mock.calls[1]
    assert(completionCall !== undefined, 'expected completion log')
    const [obj, msg] = completionCall
    expect(obj).toMatchObject({
      event: 'llm.call',
      model: 'claude-haiku-4-5-test',
      inputTokens: 47,
      outputTokens: 8,
      totalTokens: 55,
      finishReason: 'stop',
    })
    const latencyMs = (obj as { latencyMs: unknown }).latencyMs
    expect(typeof latencyMs).toBe('number')
    expect(msg).toBe('llm call completed')
  })

  it('logs llm.error and rethrows mapped error on APICallError', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-4-5-test')
    assert(mw.wrapGenerate !== undefined, 'wrapGenerate must be defined')

    const upstream = new APICallError({
      message: 'rate limited',
      url: 'https://api.anthropic.com',
      statusCode: 429,
      requestBodyValues: {},
      isRetryable: true,
    })

    await expect(
      mw.wrapGenerate({
        doGenerate: () => Promise.reject(upstream),
        doStream: stubStream,
        params: emptyParams,
        model: stubModel,
      }),
    ).rejects.toBeInstanceOf(LlmRateLimitedError)
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('extracts sessionId/userId from providerOptions.mythrun', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-4-5-test')
    assert(mw.wrapGenerate !== undefined, 'wrapGenerate must be defined')

    const params = {
      providerOptions: { mythrun: { sessionId: 'sess-1', userId: 'user-9' } },
    } as unknown as LanguageModelV3CallOptions

    const minimalResult: LanguageModelV3GenerateResult = {
      content: [],
      finishReason: { unified: 'stop' as const, raw: 'end_turn' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }

    await mw.wrapGenerate({
      doGenerate: () => Promise.resolve(minimalResult),
      doStream: stubStream,
      params,
      model: stubModel,
    })

    // myth-4omh: started log is calls[0], call (completion) is calls[1].
    // Both should carry the threaded context (sessionId + userId).
    const startedCall = infoSpy.mock.calls[0]
    assert(startedCall !== undefined, 'expected started log')
    expect(startedCall[0]).toMatchObject({
      event: 'llm.call.started',
      sessionId: 'sess-1',
      userId: 'user-9',
    })
    const completionCall = infoSpy.mock.calls[1]
    assert(completionCall !== undefined, 'expected completion log')
    expect(completionCall[0]).toMatchObject({
      event: 'llm.call',
      sessionId: 'sess-1',
      userId: 'user-9',
    })
  })
})
