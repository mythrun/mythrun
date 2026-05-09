// backend/src/billing/model-pricing.ts
//
// USD per million tokens for each model we use, across the four rate
// categories Anthropic publishes:
//   - input:           base prompt tokens
//   - output:          generated tokens
//   - cacheWrite:      5-min cache write tokens (1.25× input)
//   - cacheRead:       cache read tokens at any TTL (0.10× input)
//
// THIS IS APPROXIMATE COST FOR OBSERVABILITY, NOT BILLING. Stripe charges
// users a fixed $/session price; these rates power internal cost-cap
// signaling, dashboards, and CloudWatch alarms.
//
// Drift detection: scripts/check-pricing.ts runs daily under
// .github/workflows/llm-price-check.yml — fetches Anthropic's pricing
// docs page, extracts rates via Haiku (Zod-validated + sanity-bounded),
// diffs against this constant, alarms on any drift (with floating-point
// epsilon).
//
// Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §5

export const MODEL_PRICING = {
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
} as const

/** Display name (as listed on Anthropic's docs page) → MODEL_PRICING slug.
 *  Used by the daily price-check; the docs page lists models by display
 *  name only, not by SDK slug. */
export const MODEL_DISPLAY_NAMES: Record<string, keyof typeof MODEL_PRICING> = {
  'Claude Opus 4.7': 'claude-opus-4-7',
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Haiku 4.5': 'claude-haiku-4-5-20251001',
}

export type Model = keyof typeof MODEL_PRICING

export interface UsageDeltas {
  readonly inputTokens: number
  readonly outputTokens: number
  /** 5-minute cache write tokens. Default 0. */
  readonly cacheWriteTokens?: number
  /** Cache read tokens (any TTL). Default 0. */
  readonly cacheReadTokens?: number
  /** 1-hour cache write tokens. Mythrun does not use 1-hour cache; if
   *  this is non-zero, computeCostUsd throws — we don't silently mis-
   *  charge by treating these as 5-min-rate writes. */
  readonly cacheWrite1hTokens?: number
}

export function computeCostUsd(model: Model, deltas: UsageDeltas): number {
  if ((deltas.cacheWrite1hTokens ?? 0) > 0) {
    throw new Error(
      `computeCostUsd: 1-hour cache_creation tokens (${String(deltas.cacheWrite1hTokens)}) ` +
        `received but not priced. Mythrun uses 5-min cache only; see design §6.`,
    )
  }
  const p = MODEL_PRICING[model]
  const cacheWrite = deltas.cacheWriteTokens ?? 0
  const cacheRead = deltas.cacheReadTokens ?? 0
  return (
    (deltas.inputTokens * p.input +
      deltas.outputTokens * p.output +
      cacheWrite * p.cacheWrite +
      cacheRead * p.cacheRead) /
    1_000_000
  )
}
