// The shared WAITING-DISPLAY brain (MYT-102 loading revamp) — one estimation
// approach behind BOTH waiting surfaces (the character-loading beat and the
// world-gen loading screen / status card). It sits on top of the adaptive
// remaining-ms estimate the surfaces already compute (`remainingOverSlice` in
// worldgen/stage-eta.ts, re-derived every tick from live stage completions) and
// resolves the two things the old per-second `~M:SS` countdown got wrong:
//
//   1. COARSENESS. A remaining estimate displays minute-granular — "2 min",
//      "under a minute" — never a ticking `0:24`. A per-second count reads as
//      false precision and manufactures anxiety; a coarse bucket that changes
//      about once a minute reads as an honest expectation (the macOS/Android
//      "About 2 minutes remaining" register). `coarseWaitBucket` returns the
//      bucket; the web layer maps it to the localized `{{time}}` fill.
//
//   2. NEVER A DEAD ZERO. The estimate is honest, so an overrunning final stage
//      clamps `remainingMs` to 0 — and the old countdown then SAT at "0:00
//      remaining" until completion (the reported bug). Instead, the moment the
//      estimate exhausts, the display transitions to an indeterminate STALLED
//      kind ("still working"), and a wall-clock backstop catches the rarer hang
//      where a wedged pending stage keeps the estimate positive forever.
//
// Pure + DOM-free — no i18n, no clock, no React. The web surface owns the 1s
// tick (it feeds `elapsedMs` + the fresh `remainingMs`), the copy, and which of
// the three display kinds it renders (character shows a stall LINE; world-gen
// degrades a non-estimate to "no countdown" — its spinner + flavor cycle is
// already the indeterminate presentation).

/** The coarse remaining-wait bucket — minute-granular, never seconds. The web
 *  layer resolves each to its localized `{{time}}` fill (`under-minute` → e.g.
 *  "under a minute"; `minutes` → e.g. "2 min"). */
export type WaitBucket =
  | { readonly kind: 'under-minute' }
  | { readonly kind: 'minutes'; readonly count: number }

/** The display decision for the current wait:
 *   - `estimate` — a usable coarse estimate to show;
 *   - `stalled` — the estimate exhausted / the wait wedged: show the
 *     indeterminate "still working" presentation, NEVER a dead 0:00;
 *   - `hidden` — nothing to show yet (cold-start with no history, before the
 *     no-history stall window). */
export type WaitDisplay =
  | { readonly kind: 'estimate'; readonly bucket: WaitBucket }
  | { readonly kind: 'stalled' }
  | { readonly kind: 'hidden' }

export interface WaitDisplayInput {
  /** The adaptive remaining estimate in ms (`remainingOverSlice`), re-derived
   *  each tick; `null` when there is no usable history to estimate from. */
  readonly remainingMs: number | null
  /** Wall-clock ms since the wait began — drives the no-history stall window and
   *  the initial-estimate backstop. */
  readonly elapsedMs: number
  /** With no estimate to exhaust, elapsed past this window reads as stalled. Pass
   *  `Number.POSITIVE_INFINITY` to never stall on no-history (world-gen: the
   *  flavor cycle carries the liveness, so it simply hides the countdown). */
  readonly noHistoryStallMs: number
  /** The FIRST usable estimate this wait saw (ms). Supplied → a wall-clock
   *  backstop stalls once elapsed reaches `initialEstimateMs × stallMultiplier`
   *  (a wedged pending stage keeps `remainingMs` positive forever, so exhaustion
   *  alone would never fire). Omit to disable the backstop. */
  readonly initialEstimateMs?: number | null
  /** The backstop multiple of the initial estimate (default 3). */
  readonly stallMultiplier?: number
}

/** One minute in ms. */
const MINUTE_MS = 60_000

/** The default wall-clock stall backstop: elapsed past 3× the first estimate. */
const DEFAULT_STALL_MULTIPLIER = 3

/**
 * Map a positive remaining-ms estimate to its coarse bucket. Sub-minute waits
 * collapse to a single "under a minute" bucket (no ticking seconds); a minute
 * and up round to the nearest whole minute, floored at 1 so a just-over-a-minute
 * wait never reads "0 min". Rounding biases the half-minute boundary UP (90s →
 * "2 min"), so the coarse label errs toward over- rather than under-promising —
 * the safe direction (the wait finishes early, a pleasant surprise). Total for
 * any non-negative input; `waitDisplay` only calls it once the estimate is
 * strictly positive.
 */
export function coarseWaitBucket(remainingMs: number): WaitBucket {
  if (remainingMs < MINUTE_MS) return { kind: 'under-minute' }
  return { kind: 'minutes', count: Math.max(1, Math.round(remainingMs / MINUTE_MS)) }
}

/**
 * Resolve the wait's display kind. See the module header for the two rules; in
 * short: no history → hidden until the no-history window, then stalled; a usable
 * estimate → a coarse estimate while positive, else stalled (exhausted, or past
 * the initial-estimate backstop).
 */
export function waitDisplay({
  remainingMs,
  elapsedMs,
  noHistoryStallMs,
  initialEstimateMs = null,
  stallMultiplier = DEFAULT_STALL_MULTIPLIER,
}: WaitDisplayInput): WaitDisplay {
  if (remainingMs === null) {
    return elapsedMs >= noHistoryStallMs ? { kind: 'stalled' } : { kind: 'hidden' }
  }
  // The estimate exhausted — the running (final) stage overran to 0. This is the
  // exact dead-zero the old countdown sat on; read it as indeterminate instead.
  if (remainingMs <= 0) return { kind: 'stalled' }
  // Wall-clock backstop: a wedged pending stage keeps `remainingMs` positive
  // forever, so a generous multiple of the first estimate flips to stalled too.
  if (initialEstimateMs !== null && initialEstimateMs > 0 && elapsedMs >= initialEstimateMs * stallMultiplier) {
    return { kind: 'stalled' }
  }
  return { kind: 'estimate', bucket: coarseWaitBucket(remainingMs) }
}
