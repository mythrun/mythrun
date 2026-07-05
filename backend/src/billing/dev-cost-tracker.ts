// backend/src/billing/dev-cost-tracker.ts
//
// Process-level running total of approximate Anthropic API spend (USD).
//
// Populated by the cost-accounting LLM middleware (llm/cost-middleware.ts) on
// every generate/stream call, in ALL environments — it is a cheap in-memory
// float counter, harmless in production. The ONLY exposure is the
// GET /api/dev/api-cost route, which is gated on mythrunEnv !== 'production'
// (see app.ts + routes/dev-api-cost.ts). The floating DevCostTicker widget in
// the web app polls that route and shows a delta above a client-captured
// baseline — so there is NO server-side reset (reset is a client re-baseline).
//
// This is the SAME approximate-cost number model-pricing.ts computes for
// observability — NOT a billing figure. It resets to 0 on process restart
// (each deploy / dev-server bounce starts fresh).

let totalUsd = 0

/**
 * Add a computed USD cost for one LLM call to the running process total.
 * Non-finite or non-positive inputs are ignored so a bad usage map can never
 * corrupt the counter (a zero-usage repair call contributes nothing).
 */
export function addCostUsd(usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return
  totalUsd += usd
}

/** Current cumulative approximate spend since process start. */
export function getTotalUsd(): number {
  return totalUsd
}

/** Test-only: reset the singleton so each test starts from a known baseline. */
export function _resetDevCostForTests(): void {
  totalUsd = 0
}
