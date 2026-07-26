// backend/src/session/st-usage.ts
//
// The ST pipeline's ONE token-accounting helper. The SDK's usage blob reports
// `totalTokens` when the provider supplies it and leaves it undefined
// otherwise; every ST-side call (gate, director, convergence probe) accumulates
// into the same `:usage:st` counter, so the fallback sum lives in one place
// rather than being re-derived at each call site.

import type { LanguageModelUsage } from '../llm/ai.js'

export const usageTokens = (u: LanguageModelUsage): number =>
  u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
