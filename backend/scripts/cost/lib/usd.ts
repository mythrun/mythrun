// backend/scripts/cost/lib/usd.ts
//
// The NORMATIVE per-call USD derivation for the cost-assertion harness.
// Spec: docs/superpowers/specs/2026-07-31-cost-wave1-harness-caching-trims-design.md §1.1(4).
//
// Logged `inputTokens` is the SDK SUM (noCache + cacheRead + cacheWrite) —
// middleware.ts logs `usage.inputTokens.total`. Pricing the sum at the input
// rate is 3–5× wrong on cached traffic, so:
//
//   base       = inputTokens − cacheReadTokens − cacheWriteTokens  @ input rate
//   cacheRead                                                      @ cache-read rate (0.10×)
//   cacheWrite                                                     @ cache-write rate (1.25×)
//   output                                                         @ output rate
//
// mirroring `mapUsage` in src/llm/cost-middleware.ts. Prices come ONLY from
// the model-pricing table (single source; deliberately sticker rates).

import {
  computeCostUsd,
  MODEL_PRICING,
  type Model,
} from '../../../src/billing/model-pricing.js'
import type { LlmCallLine } from './extract.js'

function isPricedModel(modelId: string): modelId is Model {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, modelId)
}

export function callUsd(line: LlmCallLine): number {
  if (!isPricedModel(line.model)) {
    throw new Error(
      `callUsd: model "${line.model}" is not in MODEL_PRICING — refusing to guess a price ` +
        '(rates live only in backend/src/billing/model-pricing.ts)',
    )
  }
  const cacheRead = line.cacheReadTokens ?? 0
  const cacheWrite = line.cacheWriteTokens ?? 0
  const base = line.inputTokens - cacheRead - cacheWrite
  if (base < 0) {
    throw new Error(
      `callUsd: inputTokens (${String(line.inputTokens)}) < cacheRead (${String(cacheRead)}) + ` +
        `cacheWrite (${String(cacheWrite)}) — logged inputTokens must be the SDK sum (spec §1.1(4))`,
    )
  }
  return computeCostUsd(line.model, {
    inputTokens: base,
    outputTokens: line.outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  })
}
