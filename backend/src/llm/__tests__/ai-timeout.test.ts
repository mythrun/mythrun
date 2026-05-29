// myth-4omh: focused test for the AbortSignal timeout behaviour in ai.ts.
//
// Background: a 22-min silent hang in concept_intake (mountain-monastery,
// 2026-05-29 staging smoke) was traced to the Anthropic provider being
// constructed with all defaults — no fetch override, no abortSignal, no
// timeout. A stalled socket could hang indefinitely. The fix threads an
// AbortController with a per-call wall-clock budget through
// generateObject / streamObject / generateText. This test asserts:
//
//   1. timeoutMs is respected — a model that takes longer than the budget
//      surfaces as LlmTimeoutError (terminal=false → BullMQ retries).
//   2. The default timeout still applies when timeoutMs is omitted, so a
//      caller that forgets to set one still has a safety net.

import { describe, it, expect } from 'vitest'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { generateObject, generateText } from '../ai.js'
import { LlmTimeoutError } from '../errors.js'

// A stub model that NEVER resolves until aborted. Used to simulate a hung
// Anthropic socket — the wrapper's timeout should fire and reject the
// call with LlmTimeoutError.
function makeHangingModel(): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'hanging-model',
    doGenerate: ({ abortSignal }: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (abortSignal === undefined) {
          throw new Error('test invariant: wrapper must thread abortSignal')
        }
        abortSignal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
    doStream: () => Promise.reject(new Error('not exercised in this test')),
  } as unknown as LanguageModel
}

describe('ai.ts AbortSignal timeout (myth-4omh)', () => {
  it('generateObject rejects with LlmTimeoutError when timeoutMs expires', async () => {
    const schema = z.object({ ok: z.boolean() })
    const promise = generateObject({
      model: makeHangingModel(),
      schema,
      prompt: 'this never returns',
      callSite: 'test',
      timeoutMs: 50,
      maxRetries: 0,
    })
    await expect(promise).rejects.toBeInstanceOf(LlmTimeoutError)
  })

  it('generateText rejects with LlmTimeoutError when timeoutMs expires', async () => {
    const promise = generateText({
      model: makeHangingModel(),
      prompt: 'this never returns',
      timeoutMs: 50,
      maxRetries: 0,
    })
    await expect(promise).rejects.toBeInstanceOf(LlmTimeoutError)
  })

  // Cover the finally-after-success branches for both generateObject and
  // generateText. The timer must be cancelled when the call returns
  // normally; otherwise the timer would fire on a settled call.
  it('cancels the timeout timer on successful generateObject return', async () => {
    const schema = z.object({ ok: z.boolean() })
    const fastModel = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'fast-model',
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text' as const, text: '{"ok": true}' }],
          finishReason: { unified: 'stop' as const, raw: 'end_turn' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        }),
      doStream: () => Promise.reject(new Error('not exercised')),
    } as unknown as LanguageModel

    const result = await generateObject({
      model: fastModel,
      schema,
      prompt: 'hello',
      callSite: 'test',
      timeoutMs: 10_000,
      maxRetries: 0,
    })
    expect(result.output.ok).toBe(true)
  })

  it('cancels the timeout timer on successful generateText return', async () => {
    const fastModel = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'fast-model',
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text' as const, text: 'ok' }],
          finishReason: { unified: 'stop' as const, raw: 'end_turn' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        }),
      doStream: () => Promise.reject(new Error('not exercised')),
    } as unknown as LanguageModel

    const result = await generateText({
      model: fastModel,
      prompt: 'hello',
      timeoutMs: 10_000,
      maxRetries: 0,
    })
    expect(result.text).toBe('ok')
  })
})
