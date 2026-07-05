// backend/src/llm/cost-middleware.ts
//
// A LanguageModelV3Middleware that accumulates approximate Anthropic API spend
// into the process-level dev-cost-tracker after every generate/stream call.
// Composed alongside logAndNormalizeMiddleware in models.ts, INNERMOST (closest
// to the raw provider model) so it observes the provider's real usage object
// directly — unaffected by the log middleware's error/finish transforms.
//
// The mapping from the SDK's LanguageModelV3Usage to model-pricing's UsageDeltas
// is the load-bearing correctness surface. Anthropic reports three input
// counters: base (uncached) input, cache-read, and cache-write. The AI SDK
// exposes them as `inputTokens.noCache`, `inputTokens.cacheRead`, and
// `inputTokens.cacheWrite`; `inputTokens.total` is the SUM of all three. So the
// base input rate MUST be applied to `noCache`, NOT `total` — pricing `total`
// at the input rate would double-charge the cache-read/-write tokens (which
// have their own, much cheaper, rates). See model-pricing.ts.
//
// Accumulation runs in ALL environments (a cheap counter); only the exposure
// (GET /api/dev/api-cost) is gated to non-production. An unknown/unpriced model
// id is skipped gracefully, and computeCostUsd is wrapped so cost accounting can
// never throw out of an LLM call.

import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import { addCostUsd } from '../billing/dev-cost-tracker.js'
import { computeCostUsd, MODEL_PRICING, type Model, type UsageDeltas } from '../billing/model-pricing.js'

/** Map the SDK's nested usage object to model-pricing's flat UsageDeltas. */
function mapUsage(usage: LanguageModelV3Usage): UsageDeltas {
  return {
    // Base (uncached) input tokens — priced at the input rate. NOT `total`,
    // which also includes cacheRead + cacheWrite (each priced separately).
    inputTokens: usage.inputTokens.noCache ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
  }
}

function isPricedModel(modelId: string): modelId is Model {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, modelId)
}

/** Compute + accumulate the cost of one call; never throws. */
function accountCost(modelId: string, usage: LanguageModelV3Usage): void {
  // Unknown/unpriced model → skip gracefully (don't guess a price).
  if (!isPricedModel(modelId)) return
  try {
    addCostUsd(computeCostUsd(modelId, mapUsage(usage)))
  } catch {
    // Cost accounting is best-effort observability — a mapping surprise must
    // never crash the LLM call it is measuring.
  }
}

export function costAccountingMiddleware(modelId: string): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      accountCost(modelId, result.usage)
      return result
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream()
      // Tap the stream for the terminal `finish` part (which carries the final
      // usage) and pass every part through untouched. If a stream is abandoned
      // before finishing, its cost is simply not counted — acceptable for a dev
      // ticker (rare, and it undercounts rather than crashes).
      const accounted = stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(chunk, controller) {
            if (chunk.type === 'finish') accountCost(modelId, chunk.usage)
            controller.enqueue(chunk)
          },
        }),
      )
      return { ...rest, stream: accounted }
    },
  }
}
