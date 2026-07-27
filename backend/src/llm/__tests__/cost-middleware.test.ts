// backend/src/llm/__tests__/cost-middleware.test.ts
//
// Verifies the cost-accounting middleware's usage → cost mapping — the
// load-bearing correctness surface. The critical assertion is that the base
// input rate is applied to `noCache`, NOT `total` (which also includes
// cache-read/-write tokens); pricing `total` would double-charge cached tokens.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import { costAccountingMiddleware } from '../cost-middleware.js'
import { getTotalUsd, _resetDevCostForTests } from '../../billing/dev-cost-tracker.js'

const HAIKU_ID = 'claude-haiku-4-5-20251001'
const SONNET_ID = 'claude-sonnet-5'

/** Build a valid LanguageModelV3Usage; `total` input is the sum of its parts,
 *  mirroring how the Anthropic provider populates the field. */
function makeUsage(o: {
  noCache?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
}): LanguageModelV3Usage {
  const noCache = o.noCache ?? 0
  const cacheRead = o.cacheRead ?? 0
  const cacheWrite = o.cacheWrite ?? 0
  const output = o.output ?? 0
  return {
    inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

type WrapGenerateArgs = Parameters<NonNullable<LanguageModelV3Middleware['wrapGenerate']>>[0]
type WrapStreamArgs = Parameters<NonNullable<LanguageModelV3Middleware['wrapStream']>>[0]

/** Drive the middleware's generate path with a canned usage object. The `params`
 *  / `model` fields are unused by this middleware, so a narrow cast of the
 *  options bag keeps the harness free of a full SDK model stub. */
async function runGenerate(modelId: string, usage: LanguageModelV3Usage): Promise<void> {
  const mw = costAccountingMiddleware(modelId)
  const genResult = { usage } as unknown as LanguageModelV3GenerateResult
  const args = {
    doGenerate: () => Promise.resolve(genResult),
  } as unknown as WrapGenerateArgs
  await mw.wrapGenerate?.(args)
}

/** Drive the middleware's stream path: emit a single terminal `finish` part
 *  carrying `usage`, then fully consume the returned (accounted) stream so the
 *  transform's finish tap runs. */
async function runStream(modelId: string, usage: LanguageModelV3Usage): Promise<void> {
  const mw = costAccountingMiddleware(modelId)
  const finishPart = {
    type: 'finish',
    usage,
    finishReason: { unified: 'stop', raw: 'stop' },
  } as unknown as LanguageModelV3StreamPart
  const upstream = {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue(finishPart)
        controller.close()
      },
    }),
  } as unknown as LanguageModelV3StreamResult
  const args = {
    doStream: () => Promise.resolve(upstream),
  } as unknown as WrapStreamArgs
  const result = await mw.wrapStream?.(args)
  if (result === undefined) throw new Error('wrapStream returned undefined')
  const reader = result.stream.getReader()
  // Drain to end so the finish part flows through the accounting transform.
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
}

describe('costAccountingMiddleware', () => {
  beforeEach(() => {
    _resetDevCostForTests()
  })
  afterEach(() => {
    _resetDevCostForTests()
  })

  it('generate: prices 1M input + 1M output on Haiku = $6.00', async () => {
    await runGenerate(HAIKU_ID, makeUsage({ noCache: 1_000_000, output: 1_000_000 }))
    expect(getTotalUsd()).toBeCloseTo(6.0, 6)
  })

  it('prices base input on noCache, NOT total (cached tokens are not double-charged)', async () => {
    // 1M base + 1M cache-read. Correct: 1M*$1 + 1M*$0.10 = $1.10.
    // If it wrongly priced `total` (2M) at the input rate: 2M*$1 + 1M*$0.10 = $2.10.
    await runGenerate(HAIKU_ID, makeUsage({ noCache: 1_000_000, cacheRead: 1_000_000 }))
    expect(getTotalUsd()).toBeCloseTo(1.1, 6)
  })

  it('prices cache-write + cache-read at their own rates (Sonnet)', async () => {
    // 100K cacheWrite * $3.75 + 1M cacheRead * $0.30 = 0.375 + 0.30 = 0.675.
    await runGenerate(SONNET_ID, makeUsage({ cacheWrite: 100_000, cacheRead: 1_000_000 }))
    expect(getTotalUsd()).toBeCloseTo(0.675, 6)
  })

  it('stream: taps the finish part and accumulates the same cost as generate', async () => {
    await runStream(HAIKU_ID, makeUsage({ noCache: 1_000_000, output: 1_000_000 }))
    expect(getTotalUsd()).toBeCloseTo(6.0, 6)
  })

  it('unknown/unpriced model id is skipped gracefully (no throw, counter untouched)', async () => {
    await expect(
      runGenerate('some-future-model-9', makeUsage({ noCache: 1_000_000, output: 1_000_000 })),
    ).resolves.toBeUndefined()
    expect(getTotalUsd()).toBe(0)
  })

  it('generate passes the underlying result through unchanged', async () => {
    const mw = costAccountingMiddleware(HAIKU_ID)
    const genResult = { usage: makeUsage({ noCache: 10 }) } as unknown as LanguageModelV3GenerateResult
    const args = { doGenerate: () => Promise.resolve(genResult) } as unknown as WrapGenerateArgs
    const out = await mw.wrapGenerate?.(args)
    expect(out).toBe(genResult)
  })

  it('a malformed usage shape never throws out of the LLM call (counter untouched)', async () => {
    // A provider surprise: `inputTokens` missing entirely — mapUsage's
    // `.noCache` read throws, and the accountCost catch must swallow it.
    const malformed = { outputTokens: { total: 5 } } as unknown as LanguageModelV3Usage
    await expect(runGenerate(HAIKU_ID, malformed)).resolves.toBeUndefined()
    expect(getTotalUsd()).toBe(0)
  })

  it('omitted usage counters (no cache activity) default to zero, not NaN', async () => {
    // A call with no cache reads/writes omits those counters rather than
    // reporting 0 — every `?? 0` arm in mapUsage must default cleanly.
    const partial = { inputTokens: {}, outputTokens: {} } as unknown as LanguageModelV3Usage
    await runGenerate(HAIKU_ID, partial)
    expect(getTotalUsd()).toBe(0)
  })
})
