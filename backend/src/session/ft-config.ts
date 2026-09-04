// MYT-68 §6 — FastThinker tuning constants. Never hardcode model names or
// budgets at call sites.
import { HAIKU, SONNET } from '../llm/models.js'

export const FT_MODEL = SONNET
export const SKILL_CHECK_MODEL = HAIKU

/** §3.6: up to FT_MAX_TOOL_STEPS-1 tool-calling steps + 1 instructed prose
 *  close (NOT toolChoice:'none' — the Anthropic provider strips the tools
 *  param for it → 400 when history holds tool blocks). */
export const FT_MAX_TOOL_STEPS = 5

/** Per-TURN budget: up to FT_MAX_TOOL_STEPS Sonnet passes + nested Haiku DC
 *  calls (same-step calls run concurrently). Tuned against the E2E smoke. */
export const FT_TURN_TIMEOUT_MS = 180_000

export const SKILL_CHECK_TIMEOUT_MS = 30_000

/** Injected as a final-step user message by prepareStep (§3.6). */
export const FT_CLOSE_INSTRUCTION =
  '[System: you have reached the tool-call limit for this turn. Wrap up your narration in prose now. Do not call any tools.]'

/** myth-nu0hm §context-fill — the FT model's context window, as reported by the
 *  Anthropic Models API for FT_MODEL (`claude-sonnet-5`: max_input_tokens
 *  1_000_000, max_tokens 128_000). Verified against the live endpoint rather
 *  than assumed; re-check it when FT_MODEL moves, because the two numbers are
 *  NOT the same across the model line (Haiku 4.5 is 200K). Re-verified on the
 *  2026-07-26 Sonnet 4.6 -> Sonnet 5 bump: both numbers are UNCHANGED.
 *
 *  But the window holding steady does NOT mean the session length did. Sonnet 5
 *  ships a new tokenizer that spends ~35.6% more tokens on the same text
 *  (measured on 6KB of our own prep prompt: 1175 -> 1593). The window is the
 *  same size in tokens and therefore ~26% smaller in PROSE. Since the FT holds
 *  the whole transcript every turn, that is a direct cut to how long a session
 *  can run before this ceiling bites — the constant did not move, the thing it
 *  measures did.
 *
 *  FT_USABLE_CONTEXT_TOKENS is the number the session-progress signal divides
 *  by, and it is deliberately BELOW the window: a session has to end before the
 *  window is actually full, not when it is. The reserve covers what the ending
 *  itself still has to fit — one more whole FT turn (the farewell), its up-to-
 *  FT_MAX_TOOL_STEPS tool round-trips, and its output, which the model line caps
 *  at 128K. 150K (15%) clears that with margin. Running to the real ceiling
 *  instead would trade a graceful send-off for a provider 400 mid-turn.
 *
 *  NOTE the FT holds the WHOLE transcript every turn with no compaction, so
 *  this ceiling is a real session-length bound, not a theoretical one. */
export const FT_CONTEXT_WINDOW_TOKENS = 1_000_000
export const FT_CONTEXT_HEADROOM_TOKENS = 150_000
export const FT_USABLE_CONTEXT_TOKENS = FT_CONTEXT_WINDOW_TOKENS - FT_CONTEXT_HEADROOM_TOKENS

/** myth-zd6pn — THE session bound. One ceiling, one metric: how much context
 *  the Fast Thinker holds in a SINGLE call.
 *
 *  It replaces `SESSION_TOKEN_BUDGET`, which metered CUMULATIVE GROSS tokens
 *  across every tier. That was the wrong quantity in two independent ways.
 *  It summed a LEVEL that does not accumulate (the FT re-sends one transcript,
 *  it does not stack them), and after cost wave 1 landed per-message cache
 *  breakpoints (2026-07-31/08-01) it counted cache reads 1:1 against a ceiling
 *  calibrated before caching existed — at the measured 91-96% cache-read rate
 *  the meter filled at roughly ten times the rate of the spend it stood for.
 *  Sessions auto-ended around turn 14 (~19 minutes) against a product sold as
 *  about three hours, with the window ~4% full.
 *
 *  This constant is the honest bound: the FT holds the WHOLE transcript every
 *  turn with no compaction, so the session genuinely ends when the window can
 *  no longer take another turn. FT_USABLE_CONTEXT_TOKENS already reserves
 *  FT_CONTEXT_HEADROOM_TOKENS for the farewell turn and its output, so ending
 *  AT this number still leaves room to land the session gracefully rather than
 *  taking a provider 400 mid-turn.
 *
 *  NOTE what this deliberately does NOT do: it is a CONTEXT bound, not a spend
 *  cap. Sessions now run to the window rather than to a token count, which is
 *  materially longer. If a per-session USD ceiling is wanted it belongs beside
 *  this as its own constant metered on priced usage (uncached input, cache
 *  read and cache write each at their own rate, per billing/model-pricing.ts),
 *  NOT bolted back onto this axis. */
export const SESSION_FT_CONTEXT_BUDGET = FT_USABLE_CONTEXT_TOKENS

/** §5 fail-soft: the resolver's fallback DC table when Haiku fails/aborts.
 *  The one place code picks a value Principle #5 normally delegates —
 *  moderate band so the fallback neither rewards nor punishes. */
export const FALLBACK_DC = 11
export const FALLBACK_OUTCOMES = {
  fail: 'The attempt clearly fails.',
  success: 'The attempt clearly succeeds.',
  great_success: 'The attempt succeeds remarkably well.',
} as const

/** §11: a fat-finger shape guard on a single gold credit/debit (structural
 *  validation), NOT an economy rule. Per-call hit-dice counts and amount
 *  floors are bounded in the TOOL input schemas, not here — this is the one
 *  shared constant. */
export const MAX_GOLD_TRANSACTION = 100_000
