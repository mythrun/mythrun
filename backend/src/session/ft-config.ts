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

/** §5 fail-soft: the resolver's fallback DC table when Haiku fails/aborts.
 *  The one place code picks a value Principle #5 normally delegates —
 *  moderate band so the fallback neither rewards nor punishes. */
export const FALLBACK_DC = 11
export const FALLBACK_OUTCOMES = {
  fail: 'The attempt clearly fails.',
  success: 'The attempt clearly succeeds.',
  great_success: 'The attempt succeeds remarkably well.',
} as const
